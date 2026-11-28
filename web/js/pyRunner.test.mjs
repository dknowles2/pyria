import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Minimal DOM & MessageChannel harness to test PyRunner lifecycle, queueing,
// timeout respawn, stale-generation filtering, and untrusted-result sanitization.
function installMockDom() {
  const iframes = [];

  class MockIframe {
    constructor() {
      this.attributes = new Map();
      this.style = {};
      this.listeners = new Map();
      this.removed = false;
      this.receivedPorts = [];
      this.contentWindow = {
        postMessage: (data, targetOrigin, transfer) => {
          this.lastInit = { data, targetOrigin, transfer };
          if (Array.isArray(transfer) && transfer[0]) {
            this.receivedPorts.push(transfer[0]);
          }
        },
      };
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    addEventListener(type, fn, opts) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ fn, once: Boolean(opts && opts.once) });
    }

    dispatch(type) {
      const list = this.listeners.get(type) || [];
      const remaining = [];
      for (const entry of list) {
        entry.fn();
        if (!entry.once) remaining.push(entry);
      }
      this.listeners.set(type, remaining);
    }

    remove() {
      this.removed = true;
      setTimeout(() => {
        for (const p of this.receivedPorts) {
          try {
            p.close();
          } catch {
            // ignore
          }
        }
      }, 5);
    }
  }

  globalThis.document = {
    body: {
      appendChild(el) {
        iframes.push(el);
        queueMicrotask(() => el.dispatch('load'));
      },
    },
    createElement(tag) {
      assert.equal(tag, 'iframe');
      return new MockIframe();
    },
    addEventListener() {},
  };

  return { iframes };
}

// Import before installing mock document so the module singleton does not spawn an extra channel.
const { PyRunner, translateErrorForPip } = await import('./pyRunner.js');
const { iframes } = installMockDom();

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 10));
}

test('spawns opaque-origin sandboxed iframe with allow-scripts only', async () => {
  const startLen = iframes.length;
  const runner = new PyRunner({ executionTimeoutMs: 80, bootTimeoutMs: 120 });
  await flushMicrotasks();

  assert.equal(iframes.length, startLen + 1);
  const iframe = iframes.at(-1);
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.lastInit.data.type, 'pyria:init');
  assert.equal(iframe.lastInit.targetOrigin, '*');
  assert.equal(iframe.receivedPorts.length, 1);

  // Duplicate load event must be ignored ({ once: true }) so port2 is never re-transferred
  iframe.dispatch('load');
  assert.equal(iframe.receivedPorts.length, 1);

  // Teardown sends deterministic terminate message to sandbox port
  const teardownMsgs = [];
  iframe.receivedPorts[0].onmessage = (ev) => teardownMsgs.push(ev.data);
  runner._teardownSandbox();
  await flushMicrotasks();
  assert.ok(teardownMsgs.some((m) => m && m.type === 'terminate'));
});

test('queues runs during boot and does NOT tear down sandbox on boot timeout', async () => {
  const startLen = iframes.length;
  const runner = new PyRunner({ executionTimeoutMs: 80, bootTimeoutMs: 50 });
  await flushMicrotasks();

  const iframe = iframes.at(-1);
  const sandboxPort = iframe.receivedPorts[0];
  const receivedRuns = [];
  sandboxPort.onmessage = (ev) => receivedRuns.push(ev.data);

  const res = await runner.runTrial('print(1)', '');
  assert.equal(res.passed, false);
  assert.equal(res.timedOut, false);
  assert.equal(res.errorType, 'BootTimeoutError');
  assert.equal(receivedRuns.length, 0, 'queued run must not be sent before ready');
  assert.equal(iframe.removed, false, 'boot timeout must not tear down the sandbox');
  assert.equal(iframes.length, startLen + 1, 'no duplicate iframe spawned');

  // Now Pyodide finishes downloading -> ready -> next run succeeds on same iframe
  sandboxPort.postMessage({ type: 'ready' });
  await flushMicrotasks();
  assert.equal(runner.getStatus().state, 'ready');

  sandboxPort.onmessage = (ev) => {
    sandboxPort.postMessage({
      type: 'result',
      id: ev.data.id,
      result: { passed: true, stdout: 'ok\n', stderr: '' },
    });
  };
  const ok = await runner.runTrial('print("ok")', '');
  assert.equal(ok.passed, true);
  assert.equal(ok.stdout, 'ok\n');

  runner._teardownSandbox();
});

test('flushes bootQueue on ready and enforces execution timeout with respawn', async () => {
  const runner = new PyRunner({ executionTimeoutMs: 60, bootTimeoutMs: 500 });
  await flushMicrotasks();

  const iframe1 = iframes.at(-1);
  const port1 = iframe1.receivedPorts[0];
  const sentToPort1 = [];
  port1.onmessage = (ev) => sentToPort1.push(ev.data);

  // Queue an infinite-loop run before ready
  const loopPromise = runner.runTrial('while True:\n  pass', '');
  await flushMicrotasks();
  assert.equal(sentToPort1.length, 0);

  // Sandbox becomes ready -> run is flushed and hits 60ms execution timeout
  port1.postMessage({ type: 'ready' });
  const loopRes = await loopPromise;
  assert.equal(loopRes.passed, false);
  assert.equal(loopRes.timedOut, true);
  assert.equal(loopRes.errorType, 'TimeoutError');
  assert.equal(sentToPort1.length, 1);
  assert.equal(iframe1.removed, true, 'timed-out iframe must be torn down');

  // Respawned iframe2 handles subsequent runs cleanly
  await flushMicrotasks();
  const iframe2 = iframes.at(-1);
  assert.notEqual(iframe2, iframe1);
  const port2 = iframe2.receivedPorts[0];
  port2.onmessage = (ev) => {
    port2.postMessage({
      type: 'result',
      id: ev.data.id,
      result: { passed: true, stdout: 'recovered\n', stderr: '' },
    });
  };

  // Stale message from port1 must be ignored
  port1.postMessage({ type: 'ready' });
  await flushMicrotasks();
  assert.equal(runner.getStatus().state, 'loading');

  port2.postMessage({ type: 'ready' });
  const recovered = await runner.runTrial('print("recovered")', '');
  assert.equal(recovered.passed, true);
  assert.equal(recovered.stdout, 'recovered\n');

  runner._teardownSandbox();
});

test('sanitizes untrusted/malformed sandbox results without throwing', async () => {
  const runner = new PyRunner({ executionTimeoutMs: 200, bootTimeoutMs: 200 });
  await flushMicrotasks();

  const iframe = iframes.at(-1);
  const port = iframe.receivedPorts[0];
  port.postMessage({ type: 'ready' });
  await flushMicrotasks();

  port.onmessage = (ev) => {
    port.postMessage({
      type: 'result',
      id: ev.data.id,
      result: {
        passed: 'truthy',
        stdout: 12345,
        stderr: { bad: true },
        errorLine: Number.NaN,
        ownedUnlockIds: 'not-an-array',
        byteShards: -999,
        purchased: [1, 'Valid Item', null],
        equipped: null,
        appearance: ['bad-array'],
        stats: { charisma: 'evil', courage: 3.9 },
      },
    });
  };

  const res = await runner.runWorkshop('wear_hat("explorer")', [], {});
  assert.equal(res.passed, true);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
  assert.equal(res.errorLine, null);
  assert.deepEqual(res.ownedUnlockIds, []);
  assert.equal(res.byteShards, 0);
  assert.deepEqual(res.purchased, ['Valid Item']);
  assert.deepEqual(res.equipped, []);
  assert.deepEqual(res.appearance, {});
  assert.deepEqual(res.stats, { charisma: 0, courage: 3 });
  assert.deepEqual(res.inventory, { arrows: 0, potions: 0 });
  assert.deepEqual(res.customItems, []);

  runner._teardownSandbox();
});

test('#94: preserves streamed partial stdout on timeout and enforces cap', async () => {
  const runner = new PyRunner({ executionTimeoutMs: 70, bootTimeoutMs: 200 });
  await flushMicrotasks();

  const iframe = iframes.at(-1);
  const port = iframe.receivedPorts[0];
  port.postMessage({ type: 'ready' });
  await flushMicrotasks();

  port.onmessage = (ev) => {
    if (ev.data.type !== 'run') return;
    port.postMessage({ type: 'stdout', id: ev.data.id, chunk: 'tick 0\ntick 1\n' });
    port.postMessage({ type: 'stdout', id: ev.data.id, chunk: 'tick 2\n' });
    // Never sends 'result' -> triggers execution timeout
  };

  const res = await runner.runTrial('while True:\n  print("tick")', '');
  assert.equal(res.passed, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.errorType, 'TimeoutError');
  assert.equal(res.stdout, 'tick 0\ntick 1\ntick 2\n');
  assert.match(res.pipMessage, /while/i);
  assert.match(res.pipMessage, /endless loop/i);

  // Test cap truncation on huge streamed output
  await flushMicrotasks();
  const port2 = iframes.at(-1).receivedPorts[0];
  port2.postMessage({ type: 'ready' });
  await flushMicrotasks();
  port2.onmessage = (ev) => {
    if (ev.data.type !== 'run') return;
    const manyLines = Array.from({ length: 260 }, (_, i) => `line ${i}`).join('\n') + '\n';
    port2.postMessage({ type: 'stdout', id: ev.data.id, chunk: manyLines });
  };
  const capped = await runner.runTrial('while True:\n  print("x")', '');
  assert.equal(capped.timedOut, true);
  assert.ok(capped.stdout.includes('... (output truncated)'));
  assert.ok(capped.stdout.split('\n').length <= 205);

  runner._teardownSandbox();
});

test('#94: translateErrorForPip handles TimeoutError even without timedOut flag', () => {
  const timeoutRes = translateErrorForPip({
    passed: false,
    timedOut: false,
    errorType: 'TimeoutError',
    errorMessage: 'Execution exceeded 3 seconds',
  });
  assert.match(timeoutRes.pipMessage, /endless loop/i);
  assert.match(timeoutRes.pipMessage, /while/i);
});

test('#95: translateErrorForPip covers later Python concepts (colons, indentation, self, AttributeError, arg-count TypeError)', () => {
  // SyntaxError colon hint includes all later keywords
  const colonRes = translateErrorForPip({
    passed: false,
    errorType: 'SyntaxError',
    errorMessage: "expected ':'",
    errorLine: 3,
  });
  for (const kw of ['if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', 'with']) {
    assert.ok(colonRes.pipMessage.includes(`'${kw}'`), `colon hint missing ${kw}`);
  }

  // IndentationError includes later keywords
  const indentRes = translateErrorForPip({
    passed: false,
    errorType: 'IndentationError',
    errorMessage: 'expected an indented block after function definition',
    errorLine: 2,
  });
  assert.match(indentRes.pipMessage, /def/);
  assert.match(indentRes.pipMessage, /class/);
  assert.match(indentRes.pipMessage, /while/);
  assert.match(indentRes.pipMessage, /try/);

  // NameError special-case for self
  const selfNameRes = translateErrorForPip({
    passed: false,
    errorType: 'NameError',
    errorMessage: "name 'self' is not defined",
    errorLine: 4,
  });
  assert.match(selfNameRes.pipMessage, /action that belongs to a class/i);
  assert.match(selfNameRes.pipMessage, /def roar\(self/);

  // Normal NameError still gives variable hint
  const normalNameRes = translateErrorForPip({
    passed: false,
    errorType: 'NameError',
    errorMessage: "name 'drago' is not defined",
    errorLine: 1,
  });
  assert.match(normalNameRes.pipMessage, /drago/);

  // AttributeError for class/method typo
  const attrRes = translateErrorForPip({
    passed: false,
    errorType: 'AttributeError',
    errorMessage: "'Dragon' object has no attribute 'fly'",
    errorLine: 8,
  });
  assert.match(attrRes.pipMessage, /Dragon/);
  assert.match(attrRes.pipMessage, /self\.fly/);

  // AttributeError for NoneType
  const noneAttrRes = translateErrorForPip({
    passed: false,
    errorType: 'AttributeError',
    errorMessage: "'NoneType' object has no attribute 'append'",
    errorLine: 5,
  });
  assert.match(noneAttrRes.pipMessage, /None/);
  assert.match(noneAttrRes.pipMessage, /\.append/);

  // TypeError argument-count cases
  const missingArgRes = translateErrorForPip({
    passed: false,
    errorType: 'TypeError',
    errorMessage: "greet() missing 1 required positional argument: 'name'",
    errorLine: 6,
  });
  assert.match(missingArgRes.pipMessage, /without enough inputs/i);

  const tooManyArgsRes = translateErrorForPip({
    passed: false,
    errorType: 'TypeError',
    errorMessage: 'Dragon.roar() takes 1 positional argument but 2 were given',
    errorLine: 7,
  });
  assert.match(tooManyArgsRes.pipMessage, /different number of inputs/i);
  assert.match(tooManyArgsRes.pipMessage, /self/);
});

function extractSandboxPythonConstants() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.join(dir, '..', 'py-sandbox.html'), 'utf8');
  const extract = (name) => {
    const marker = `const ${name} = \``;
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, `Could not find ${name} in py-sandbox.html`);
    let i = start + marker.length;
    let raw = '';
    while (i < html.length) {
      if (html[i] === '`' && html[i - 1] !== '\\') break;
      raw += html[i];
      i += 1;
    }
    return raw.replace(/\\\\/g, '\\');
  };
  return {
    guard: extract('SANDBOX_GUARD_PY'),
    trial: extract('TRIAL_HARNESS_PY'),
    workshop: extract('WORKSHOP_HARNESS_PY'),
  };
}

test('#98: sanitizes workshop inventory and customItems fields', async () => {
  const runner = new PyRunner({ executionTimeoutMs: 200, bootTimeoutMs: 200 });
  await flushMicrotasks();

  const port = iframes.at(-1).receivedPorts[0];
  port.postMessage({ type: 'ready' });
  await flushMicrotasks();

  port.onmessage = (ev) => {
    port.postMessage({
      type: 'result',
      id: ev.data.id,
      result: {
        passed: true,
        stdout: 'Forged!\n',
        stderr: '',
        byteShards: 40,
        inventory: { arrows: 10.7, potions: -2 },
        customItems: ['Flame Blade (Power 5)', 999, 'Frost Staff (Power 8)'],
      },
    });
  };

  const res = await runner.runWorkshop('forge_arrows(10)', [], { byteShards: 90 });
  assert.equal(res.passed, true);
  assert.deepEqual(res.inventory, { arrows: 10, potions: 0 });
  assert.deepEqual(res.customItems, ['Flame Blade (Power 5)', 'Frost Staff (Power 8)']);

  runner._teardownSandbox();
});

test('#94: embedded Python streaming buffer emits chunks and caps huge output', () => {
  const { guard, trial } = extractSandboxPythonConstants();
  const pyTestScript = `
${guard}
${trial}

chunks = []
r_stream = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": "for i in range(250):\\n    print('line', i)",
    "testCode": "",
}), emit_stdout=lambda c: chunks.append(c)))
assert r_stream["passed"], r_stream
assert len(chunks) > 0
assert "... (output truncated)" in r_stream["stdout"]
print("STREAMING_BUFFER_OK")
`;
  const out = execFileSync('python3', ['-c', pyTestScript], { encoding: 'utf8' });
  assert.ok(out.includes('STREAMING_BUFFER_OK'));
});

test('#98: embedded Python workshop builtins (get_shards, forge_arrows, brew_potion, forge_custom)', () => {
  const { guard, workshop } = extractSandboxPythonConstants();
  const pyTestScript = `
${guard}
${workshop}

w_res = json.loads(_pyria_run_workshop(json.dumps({
    "code": '''
class Blade:
    def __init__(self, name, power, element):
        self.name = name
        self.power = power
        self.element = element

if get_shards() >= 50:
    forge_arrows(3)
    brew_potion(2)
    forge_custom("Star Dagger", 4)
    forge_custom(Blade("Sunblade", 9, "Fire"))
''',
    "unlockables": [],
    "saveState": {"byteShards": 100, "inventory": {"arrows": 2, "potions": 1}, "customItems": []},
})))
assert w_res["passed"], w_res
assert w_res["byteShards"] == 100 - 15 - 20 - 15 - 15, w_res
assert w_res["inventory"] == {"arrows": 5, "potions": 3}, w_res
assert w_res["customItems"] == ["Star Dagger (Power 4)", "Sunblade (Fire, Power 9)"], w_res

# Rejects overly long .element without spending shards
w_bad = json.loads(_pyria_run_workshop(json.dumps({
    "code": '''
class Huge:
    def __init__(self):
        self.name = "Orb"
        self.power = 5
        self.element = "X" * 30
forge_custom(Huge())
''',
    "unlockables": [],
    "saveState": {"byteShards": 50, "inventory": {"arrows": 0, "potions": 0}, "customItems": []},
})))
assert not w_bad["passed"] and w_bad["errorType"] == "ValueError" and "24 characters" in w_bad["errorMessage"], w_bad
print("WORKSHOP_BUILTINS_OK")
`;
  const out = execFileSync('python3', ['-c', pyTestScript], { encoding: 'utf8' });
  assert.ok(out.includes('WORKSHOP_BUILTINS_OK'));
});

test('#89: shout() uppercases string arguments and preserves non-strings', () => {
  const { guard, trial } = extractSandboxPythonConstants();
  const pyTestScript = `
${guard}
${trial}

r = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": 'shout("hello", "pyria", 42)\\nsay("quiet")',
    "testCode": 'assert OUTPUT.strip() == "HELLO PYRIA 42\\\\nquiet"',
})))
assert r["passed"], r
print("SHOUT_UPPERCASE_OK")
`;
  const out = execFileSync('python3', ['-c', pyTestScript], { encoding: 'utf8' });
  assert.ok(out.includes('SHOUT_UPPERCASE_OK'));
});

test('#85: runTrial forwards requiredConstructs and variants in sandbox payload', async () => {
  const runner = new PyRunner({ executionTimeoutMs: 200, bootTimeoutMs: 200 });
  await flushMicrotasks();

  const iframe = iframes.at(-1);
  const port = iframe.receivedPorts[0];
  port.postMessage({ type: 'ready' });
  await flushMicrotasks();

  let capturedPayload = null;
  port.onmessage = (ev) => {
    capturedPayload = ev.data.payload;
    port.postMessage({
      type: 'result',
      id: ev.data.id,
      result: { passed: true, stdout: '15\n', stderr: '' },
    });
  };

  const res = await runner.runTrial('a = 3\nb = 4\ntotal = a + b\nprint(total)', 'assert total == 7', false, {
    requiredConstructs: ['math_op'],
    variants: [{ overrides: { a: 10, b: 5 }, expectOutput: '15', expectVars: { total: 15 } }],
  });
  assert.equal(res.passed, true);
  assert.deepEqual(capturedPayload.requiredConstructs, ['math_op']);
  assert.deepEqual(capturedPayload.variants, [
    { overrides: { a: 10, b: 5 }, expectOutput: '15', expectVars: { total: 15 } },
  ]);

  runner._teardownSandbox();
});

test('#85: embedded Python harness enforces requiredConstructs and variants', () => {
  const { guard, trial } = extractSandboxPythonConstants();
  const pyTestScript = `
${guard}
${trial}

# requiredConstructs catches missing construct and passes when present
r_miss = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": 'msg = "hello world"\\nprint(msg)',
    "testCode": 'assert OUTPUT.strip() == "hello world"',
    "requiredConstructs": ["str_concat"],
})))
assert not r_miss["passed"] and r_miss["stage"] == "constructs" and "+" in r_miss["errorMessage"], r_miss

r_hit = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": 'msg = "hello" + " " + "world"\\nprint(msg)',
    "testCode": 'assert OUTPUT.strip() == "hello world"',
    "requiredConstructs": ["str_concat", "call:print"],
})))
assert r_hit["passed"], r_hit

# OR syntax and AST construct tokens
r_multi = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": '''
def check(items, target):
    val = None
    count = 0
    if target in items:
        count += 1
        val = items[0:1]
    elif len(items) == 0:
        return "empty"
    else:
        return f"no {target.upper()}"
    return str(count)
''',
    "testCode": 'assert check(["a"], "a") == "1"',
    "requiredConstructs": ["def", "return", "none", "aug_assign", "if", "elif", "else", "in_op", "slice", "call:len", "str_call", "fstring|str_concat", "method_call:upper"],
})))
assert r_multi["passed"], r_multi

# variants rejects hard-coded answer and accepts real computation
r_cheat = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": "a = 3\\nb = 4\\ntotal = 7\\nprint(total)",
    "testCode": "assert total == 7 and OUTPUT.strip() == '7'",
    "variants": [{"overrides": {"a": 10, "b": 5}, "expectOutput": "15", "expectVars": {"total": 15}}],
})))
assert not r_cheat["passed"] and r_cheat["stage"] == "variants", r_cheat

r_real = json.loads(_pyria_run_trial(json.dumps({
    "studentCode": "a = 3\\nb = 4\\ntotal = a + b\\nprint(total)",
    "testCode": "assert total == 7 and OUTPUT.strip() == '7'",
    "variants": [{"overrides": {"a": 10, "b": 5}, "expectOutput": "15", "expectVars": {"total": 15}}],
})))
assert r_real["passed"], r_real
print("ANTI_CHEAT_OK")
`;
  const out = execFileSync('python3', ['-c', pyTestScript], { encoding: 'utf8' });
  assert.ok(out.includes('ANTI_CHEAT_OK'));
});
