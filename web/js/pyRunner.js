// Main-thread Pyodide runner backed by an opaque-origin sandboxed iframe
// (<iframe sandbox="allow-scripts">, NO allow-same-origin) with 3-second hard timeout
// & Pip's Kid-Friendly Error Translator.

const EXECUTION_TIMEOUT_MS = 3000;
const BOOT_TIMEOUT_MS = 20000;
const SANDBOX_IFRAME_URL = '/py-sandbox.html?v=20261127l';
const MAX_PARTIAL_STDOUT_BYTES = 16384;
const MAX_PARTIAL_STDOUT_LINES = 200;
const STDOUT_TRUNCATED_NOTICE = '\n... (output truncated)';

const TIMEOUT_PIP_MESSAGE =
  "Whoa! Your spell got stuck in an endless loop (like a 'while' loop that never stops)! " +
  "I hit the emergency stop after 3 seconds so Pyria didn't freeze. " +
  "Check that your 'while' loop updates its counter (like count += 1) or reaches a stopping condition, then try again!";

function appendCappedStdout(current, chunk) {
  if (!chunk || typeof chunk !== 'string') return current;
  if (current.endsWith(STDOUT_TRUNCATED_NOTICE)) return current;
  let combined = current + chunk;
  const lines = combined.split('\n');
  let truncated = false;
  if (lines.length > MAX_PARTIAL_STDOUT_LINES + 1) {
    combined = lines.slice(0, MAX_PARTIAL_STDOUT_LINES).join('\n');
    truncated = true;
  }
  if (combined.length > MAX_PARTIAL_STDOUT_BYTES) {
    combined = combined.slice(0, MAX_PARTIAL_STDOUT_BYTES);
    truncated = true;
  }
  return truncated ? combined + STDOUT_TRUNCATED_NOTICE : combined;
}

/**
 * Translates raw Python errors into warm, encouraging, kid-readable Pip messages.
 */
export function translateErrorForPip(result, showRawTracebacks = false) {
  if (!result || result.passed) {
    return {
      pipMessage: 'Chirp! Your Python spell worked like a charm!',
      rawTraceback: null,
    };
  }

  if (result.timedOut) {
    return {
      pipMessage: TIMEOUT_PIP_MESSAGE,
      rawTraceback: null,
    };
  }

  const type = result.errorType || 'Error';
  const msg = result.errorMessage || '';
  const linePart = result.errorLine ? ` on line ${result.errorLine}` : '';

  let pipMessage = '';

  switch (type) {
    case 'TimeoutError':
      pipMessage = TIMEOUT_PIP_MESSAGE;
      break;

    case 'SyntaxError':
      if (msg.includes('unterminated string') || msg.includes('EOL while scanning')) {
        pipMessage = `Oops${linePart}! It looks like a quote mark (" or ') was opened but never closed. Wrap your text in matching quotes!`;
      } else if (msg.includes('was never closed') || msg.includes('EOF')) {
        pipMessage = `Almost there${linePart}! Check if you left an opening parenthesis '(' without its matching ')'!`;
      } else if (msg.includes("expected ':'")) {
        pipMessage = `Chirp${linePart}! Remember that 'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', and 'with' lines need a colon ':' at the very end!`;
      } else {
        pipMessage = `Python got a tiny bit confused by the spelling or punctuation${linePart}. Double-check quotes, parentheses (), and colons ':'! (${msg})`;
      }
      break;

    case 'IndentationError':
    case 'TabError':
      if (msg.includes('expected an indented block')) {
        pipMessage = `Watch your spacing${linePart}! After a colon ':' (like 'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', or 'with'), the lines inside MUST be pushed over by 4 spaces — put your cursor at the start of that line and tap '⇥ Indent' (or 4 spaces)!`;
      } else if (msg.includes('unexpected indent')) {
        pipMessage = `Extra spaces spotted${linePart}! Normal lines (not inside an 'if', 'for', 'while', 'def', 'class', 'try', or 'with' block) need to start all the way at the left edge with 0 spaces.`;
      } else {
        pipMessage = `Watch your spacing${linePart}! Code inside an 'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', or 'with' block needs to be indented 4 spaces (tap '⇥ Indent'), and normal lines start at the left edge.`;
      }
      break;

    case 'NameError': {
      const match = msg.match(/name '([^']+)' is not defined/);
      const varName = match ? match[1] : null;
      if (varName === 'self') {
        pipMessage = `Hmm${linePart}, Python doesn't know 'self' here! Remember: 'self' only exists inside a class method, and it must be the first parameter in 'def method(self, ...):'.`;
      } else if (varName) {
        pipMessage = `Hmm${linePart}, Python doesn't know what '${varName}' is yet! Did you spell it the same way, or forget quotes around text like "${varName}"?`;
      } else {
        pipMessage = `Python couldn't find one of your variable or function names${linePart}. Check your spelling and capitalization!`;
      }
      break;
    }

    case 'AttributeError': {
      const attrMatch = msg.match(/'([^']+)' object has no attribute '([^']+)'/);
      if (attrMatch) {
        const [, objType, attrName] = attrMatch;
        if (objType === 'NoneType') {
          pipMessage = `Oops${linePart}! That value is None (empty), so it doesn't have '.${attrName}'. Make sure your variable or function actually returned a value before calling '.${attrName}'!`;
        } else {
          pipMessage = `Pip checked your ${objType}${linePart}, and it doesn't have '.${attrName}'! Double-check the method or attribute spelling — and in a class, make sure you set 'self.${attrName}' inside '__init__' or spelled the method name right!`;
        }
      } else {
        pipMessage = `Pip couldn't find that attribute or method${linePart}! Check your spelling after the dot '.' (and make sure class attributes use 'self.'). Detail: ${msg}`;
      }
      break;
    }

    case 'TypeError':
      if (/missing \d+ required positional argument/.test(msg)) {
        pipMessage = `Almost there${linePart}! You called a function without enough inputs inside '()'. Check how many parameters it expects! (${msg})`;
      } else if (/takes .* positional argument/.test(msg)) {
        pipMessage = `Whoa${linePart}! You passed a different number of inputs than the function expects inside '()' (if this is a class method, remember 'self' counts as the first parameter!). Detail: ${msg}`;
      } else {
        pipMessage = `Mix-and-match alert${linePart}! You tried to combine two different kinds of things (like adding text and a number, or passing the wrong kind of argument). Detail: ${msg}`;
      }
      break;

    case 'ValueError':
      pipMessage = `Good spell format${linePart}, but the value didn't quite fit: ${msg}`;
      break;

    case 'ZeroDivisionError':
      pipMessage = `Whoa${linePart}! Even dragons can't divide by zero! Check the number after / or // or %.`;
      break;

    case 'IndexError':
      pipMessage = `Careful${linePart}! You reached past the end of a list. Remember Python starts counting at 0!`;
      break;

    case 'KeyError':
      pipMessage = `Pip peeked inside your dictionary${linePart} and couldn't find the key ${msg}. Check the exact spelling!`;
      break;

    case 'AssertionError':
      pipMessage = msg
        ? `Your code ran without crashing, nice! One tiny tweak needed: ${msg}`
        : 'Your code ran cleanly, but the output or variable value did not quite match the Trial objective yet. Check the exact spelling, numbers, and capitalization!';
      break;

    case 'BootTimeoutError':
      pipMessage =
        "Hold tight! Pip is still warming up the Python spellbook — tap Run again in a few seconds!";
      break;

    default:
      pipMessage = `Pip spotted a ${type}${linePart}: ${msg || 'Something unexpected happened. Try tweaking your spell!'}`;
      break;
  }

  return {
    pipMessage,
    rawTraceback: showRawTracebacks ? result.rawTraceback || null : null,
  };
}

function sanitizePlainObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'string' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeStringArray(val) {
  if (!Array.isArray(val)) return [];
  return val.filter((item) => typeof item === 'string');
}

function sanitizeSandboxResult(mode, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = {
    passed: Boolean(src.passed),
    timedOut: Boolean(src.timedOut),
    stdout: typeof src.stdout === 'string' ? src.stdout : '',
    stderr: typeof src.stderr === 'string' ? src.stderr : '',
    errorType: typeof src.errorType === 'string' ? src.errorType : null,
    errorMessage: typeof src.errorMessage === 'string' ? src.errorMessage : null,
    errorLine:
      typeof src.errorLine === 'number' && Number.isFinite(src.errorLine)
        ? Math.trunc(src.errorLine)
        : null,
    rawTraceback: typeof src.rawTraceback === 'string' ? src.rawTraceback : null,
  };
  if (typeof src.stage === 'string') {
    base.stage = src.stage;
  }
  if (mode === 'charcreate') {
    base.appearance = sanitizePlainObject(src.appearance);
    base.confirmed = Boolean(src.confirmed);
    base.events = sanitizeStringArray(src.events);
  } else if (mode === 'workshop') {
    base.appearance = sanitizePlainObject(src.appearance);
    const statsRaw = sanitizePlainObject(src.stats);
    base.stats = {
      charisma: typeof statsRaw.charisma === 'number' ? Math.max(0, Math.trunc(statsRaw.charisma)) : 0,
      courage: typeof statsRaw.courage === 'number' ? Math.max(0, Math.trunc(statsRaw.courage)) : 0,
    };
    base.ownedUnlockIds = sanitizeStringArray(src.ownedUnlockIds);
    base.byteShards =
      typeof src.byteShards === 'number' && Number.isFinite(src.byteShards)
        ? Math.max(0, Math.trunc(src.byteShards))
        : 0;
    base.purchased = sanitizeStringArray(src.purchased);
    base.equipped = sanitizeStringArray(src.equipped);
    const invRaw = sanitizePlainObject(src.inventory);
    base.inventory = {
      arrows: typeof invRaw.arrows === 'number' ? Math.max(0, Math.trunc(invRaw.arrows)) : 0,
      potions: typeof invRaw.potions === 'number' ? Math.max(0, Math.trunc(invRaw.potions)) : 0,
    };
    base.customItems = sanitizeStringArray(src.customItems)
      .map((item) => item.slice(0, 80))
      .slice(0, 20);
  }
  return base;
}

export class PyRunner {
  constructor(options = {}) {
    this.executionTimeoutMs =
      typeof options.executionTimeoutMs === 'number'
        ? options.executionTimeoutMs
        : EXECUTION_TIMEOUT_MS;
    this.bootTimeoutMs =
      typeof options.bootTimeoutMs === 'number'
        ? options.bootTimeoutMs
        : BOOT_TIMEOUT_MS;
    this.iframe = null;
    this.port = null;
    this.generation = 0;
    this.ready = false;
    this.initError = null;
    this.nextId = 1;
    this.pending = new Map();
    this.bootQueue = [];
    this.statusListeners = new Set();
    if (typeof document !== 'undefined' && options.autoSpawn !== false) {
      this.spawnSandbox();
    }
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  getStatus() {
    if (this.initError) return { state: 'error', label: 'Python: Offline' };
    if (this.ready) return { state: 'ready', label: 'Python: Ready' };
    return { state: 'loading', label: 'Python: Warming up...' };
  }

  emitStatus() {
    const status = this.getStatus();
    for (const fn of this.statusListeners) {
      fn(status);
    }
  }

  _abortPending(errorType, errorMessage) {
    this.bootQueue = [];
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.resolve(
        sanitizeSandboxResult(req.mode, {
          passed: false,
          stdout: '',
          stderr: '',
          errorType,
          errorMessage,
          rawTraceback: null,
        })
      );
    }
    this.pending.clear();
  }

  _teardownSandbox() {
    this.generation += 1;
    if (this.port) {
      try {
        this.port.postMessage({ type: 'terminate' });
      } catch {
        // ignore
      }
      try {
        this.port.onmessage = null;
        this.port.close();
      } catch {
        // ignore
      }
      this.port = null;
    }
    if (this.iframe) {
      try {
        this.iframe.remove();
      } catch {
        // ignore
      }
      this.iframe = null;
    }
  }

  spawnSandbox() {
    this._teardownSandbox();
    this._abortPending('SandboxResetError', 'Python sandbox was reset');

    this.ready = false;
    this.initError = null;

    const gen = this.generation;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => {
      if (gen !== this.generation) return;
      this.handleMessage(event.data);
    };

    const iframe = document.createElement('iframe');
    // Strictly opaque origin: allow-scripts ONLY (NEVER allow-same-origin).
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.title = 'Pyria Python Sandbox';
    iframe.style.display = 'none';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';

    iframe.addEventListener(
      'load',
      () => {
        if (gen !== this.generation || !iframe.contentWindow) return;
        try {
          // Opaque-origin sandboxed iframes require '*' targetOrigin; we transfer a
          // dedicated MessagePort so all subsequent messages travel on a private channel.
          iframe.contentWindow.postMessage({ type: 'pyria:init' }, '*', [channel.port2]);
        } catch (err) {
          this.initError = (err && err.message) || 'Failed to initialize Python sandbox';
          this.emitStatus();
          this._abortPending('SandboxError', this.initError);
        }
      },
      { once: true }
    );

    iframe.addEventListener('error', () => {
      if (gen !== this.generation) return;
      this.initError = 'Python sandbox failed to load';
      this.emitStatus();
      this._abortPending('SandboxError', this.initError);
    });

    iframe.src = SANDBOX_IFRAME_URL;
    this.iframe = iframe;

    const mount = () => {
      if (gen !== this.generation) return;
      if (document.body) {
        document.body.appendChild(iframe);
      }
    };
    if (document.body) {
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }

    this.emitStatus();
  }

  _scheduleExecutionTimeout(id) {
    return setTimeout(() => {
      if (!this.pending.has(id)) return;
      const req = this.pending.get(id);
      this.pending.delete(id);
      // Destroy and recreate the sandboxed iframe to immediately terminate
      // infinite loops (like while True:) and discard any tainted sandbox state.
      this.spawnSandbox();
      req.resolve(
        sanitizeSandboxResult(req.mode, {
          passed: false,
          timedOut: true,
          stdout: req.partialStdout || '',
          stderr: '',
          errorType: 'TimeoutError',
          errorMessage: 'Execution exceeded 3 seconds',
          rawTraceback: null,
        })
      );
    }, this.executionTimeoutMs);
  }

  _scheduleBootTimeout(id) {
    return setTimeout(() => {
      if (!this.pending.has(id)) return;
      const req = this.pending.get(id);
      this.pending.delete(id);
      this.bootQueue = this.bootQueue.filter((item) => item.id !== id);
      // Do NOT tear down the sandbox on boot timeout: allow the in-progress
      // Pyodide download to finish rather than restarting it from scratch.
      req.resolve(
        sanitizeSandboxResult(req.mode, {
          passed: false,
          timedOut: false,
          stdout: '',
          stderr: '',
          errorType: 'BootTimeoutError',
          errorMessage: 'Python is still warming up — please try again in a moment!',
          rawTraceback: null,
        })
      );
    }, this.bootTimeoutMs);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      this.ready = true;
      this.initError = null;
      this.emitStatus();
      // Flush any runs that were queued while Pyodide was booting, switching
      // each one to the strict 3-second execution timeout now that user code is sent.
      const queued = this.bootQueue;
      this.bootQueue = [];
      for (const item of queued) {
        const req = this.pending.get(item.id);
        if (!req) continue;
        clearTimeout(req.timer);
        req.sent = true;
        req.timer = this._scheduleExecutionTimeout(item.id);
        this.port.postMessage({
          type: 'run',
          id: item.id,
          mode: item.mode,
          payload: item.payload,
        });
      }
      return;
    }
    if (msg.type === 'init_error') {
      this.initError = typeof msg.error === 'string' && msg.error ? msg.error : 'Could not load Pyodide';
      this.emitStatus();
      this._abortPending('SandboxError', this.initError);
      return;
    }
    if (msg.type === 'stdout' && this.pending.has(msg.id)) {
      const req = this.pending.get(msg.id);
      if (!req.sent || typeof msg.chunk !== 'string' || !msg.chunk) return;
      req.partialStdout = appendCappedStdout(req.partialStdout || '', msg.chunk);
      return;
    }
    if (msg.type === 'result' && this.pending.has(msg.id)) {
      const req = this.pending.get(msg.id);
      if (!req.sent) return;
      this.pending.delete(msg.id);
      clearTimeout(req.timer);
      req.resolve(sanitizeSandboxResult(req.mode, msg.result));
    }
  }

  execute(mode, payload) {
    if (!this.iframe || !this.port || this.initError) {
      this.spawnSandbox();
    }
    return new Promise((resolve) => {
      const id = this.nextId++;
      if (this.ready) {
        const timer = this._scheduleExecutionTimeout(id);
        this.pending.set(id, { resolve, timer, mode, sent: true, partialStdout: '' });
        this.port.postMessage({ type: 'run', id, mode, payload });
      } else {
        const timer = this._scheduleBootTimeout(id);
        this.pending.set(id, { resolve, timer, mode, sent: false, partialStdout: '' });
        this.bootQueue.push({ id, mode, payload });
      }
    });
  }

  async runTrial(studentCode, testCode, showRawTracebacks = false) {
    const result = await this.execute('trial', { studentCode, testCode });
    const pip = translateErrorForPip(result, showRawTracebacks);
    return { ...result, ...pip };
  }

  async runCharCreate(code, currentAppearance, allowedValues) {
    const result = await this.execute('charcreate', {
      code,
      currentAppearance,
      allowedValues,
    });
    const pip = translateErrorForPip(result, false);
    return { ...result, ...pip };
  }

  async runWorkshop(code, unlockables, saveState) {
    const result = await this.execute('workshop', {
      code,
      unlockables,
      saveState,
    });
    const pip = translateErrorForPip(result, false);
    return { ...result, ...pip };
  }
}

export const pyRunner = new PyRunner();
