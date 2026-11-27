import test from 'node:test';
import assert from 'node:assert/strict';

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
const { PyRunner } = await import('./pyRunner.js');
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

  runner._teardownSandbox();
});
