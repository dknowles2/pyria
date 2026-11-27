// Main-thread Pyodide runner with 3-second hard timeout & Pip's Kid-Friendly Error Translator

const EXECUTION_TIMEOUT_MS = 3000;

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
      pipMessage:
        "Whoa! Your spell got stuck in an endless loop (like 'while True:')! " +
        "I hit the emergency stop after 3 seconds so Pyria didn't freeze. " +
        'Check your loop and try again!',
      rawTraceback: null,
    };
  }

  const type = result.errorType || 'Error';
  const msg = result.errorMessage || '';
  const linePart = result.errorLine ? ` on line ${result.errorLine}` : '';

  let pipMessage = '';

  switch (type) {
    case 'SyntaxError':
      if (msg.includes('unterminated string') || msg.includes('EOL while scanning')) {
        pipMessage = `Oops${linePart}! It looks like a quote mark (" or ') was opened but never closed. Wrap your text in matching quotes!`;
      } else if (msg.includes('was never closed') || msg.includes('EOF')) {
        pipMessage = `Almost there${linePart}! Check if you left an opening parenthesis '(' without its matching ')'!`;
      } else if (msg.includes('expected \':\'')) {
        pipMessage = `Chirp${linePart}! Remember that 'if', 'elif', 'else', and 'for' lines need a colon ':' at the very end!`;
      } else {
        pipMessage = `Python got a tiny bit confused by the spelling or punctuation${linePart}. Double-check quotes, parentheses (), and colons ':'! (${msg})`;
      }
      break;

    case 'IndentationError':
    case 'TabError':
      if (msg.includes('expected an indented block')) {
        pipMessage = `Watch your spacing${linePart}! After a colon ':', the lines inside MUST be pushed over by 4 spaces — put your cursor at the start of that line and tap '⇥ Indent' (or 4 spaces)!`;
      } else if (msg.includes('unexpected indent')) {
        pipMessage = `Extra spaces spotted${linePart}! Normal lines (not inside an 'if' or 'for') need to start all the way at the left edge with 0 spaces.`;
      } else {
        pipMessage = `Watch your spacing${linePart}! Code inside an 'if', 'elif', 'else', or 'for' block needs to be indented 4 spaces (tap '⇥ Indent'), and normal lines start at the left edge.`;
      }
      break;

    case 'NameError': {
      const match = msg.match(/name '([^']+)' is not defined/);
      const varName = match ? match[1] : null;
      if (varName) {
        pipMessage = `Hmm${linePart}, Python doesn't know what '${varName}' is yet! Did you spell it the same way, or forget quotes around text like "${varName}"?`;
      } else {
        pipMessage = `Python couldn't find one of your variable or function names${linePart}. Check your spelling and capitalization!`;
      }
      break;
    }

    case 'TypeError':
      pipMessage = `Mix-and-match alert${linePart}! You tried to combine two different kinds of things (like adding text and a number, or passing the wrong kind of argument). Detail: ${msg}`;
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

    default:
      pipMessage = `Pip spotted a ${type}${linePart}: ${msg || 'Something unexpected happened. Try tweaking your spell!'}`;
      break;
  }

  return {
    pipMessage,
    rawTraceback: showRawTracebacks ? result.rawTraceback || null : null,
  };
}

class PyRunner {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.initError = null;
    this.nextId = 1;
    this.pending = new Map();
    this.statusListeners = new Set();
    this.spawnWorker();
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

  spawnWorker() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
    }
    this.ready = false;
    this.initError = null;
    this.worker = new Worker('/js/pyWorker.js?v=20261127c');
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (err) => {
      this.initError = err.message || 'Worker failed';
      this.emitStatus();
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.resolve({
          passed: false,
          stdout: '',
          errorType: 'WorkerError',
          errorMessage: this.initError,
        });
      }
      this.pending.clear();
    };
    this.emitStatus();
  }

  handleMessage(msg) {
    if (!msg) return;
    if (msg.type === 'ready') {
      this.ready = true;
      this.initError = null;
      this.emitStatus();
      return;
    }
    if (msg.type === 'init_error') {
      this.initError = msg.error || 'Could not load Pyodide';
      this.emitStatus();
      return;
    }
    if (msg.type === 'result' && this.pending.has(msg.id)) {
      const req = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(req.timer);
      req.resolve(msg.result);
    }
  }

  execute(mode, payload) {
    return new Promise((resolve) => {
      const id = this.nextId++;

      // If Pyodide is still booting on first run, allow extra boot time before enforcing
      // the 3-second execution timeout once ready; if already ready, strict 3-second timeout!
      const startTimer = () => {
        const timeoutMs = this.ready ? EXECUTION_TIMEOUT_MS : 20000;
        return setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          // Hard kill worker to break infinite while True: loops and spin up a fresh worker
          this.spawnWorker();
          resolve({
            passed: false,
            timedOut: true,
            stdout: '',
            errorType: 'TimeoutError',
            errorMessage: 'Execution exceeded 3 seconds',
            rawTraceback: null,
          });
        }, timeoutMs);
      };

      const timer = startTimer();
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, mode, payload });
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
