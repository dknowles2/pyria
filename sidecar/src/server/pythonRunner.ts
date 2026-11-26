import { spawn } from "node:child_process";
import type { TrialTestResult } from "../shared/types.js";

const PYTHON_HARNESS = `
import io
import json
import sys
import traceback
from contextlib import redirect_stdout

payload = json.loads(sys.stdin.read())
student_code = payload.get("code", "")
test_code = payload.get("testCode", "")

stdout_buf = io.StringIO()
ns = {"__name__": "__main__", "say": print, "shout": print}
result = {
    "passed": False,
    "stdout": "",
    "stderr": "",
    "errorType": None,
    "errorMessage": None,
    "phase": "student",
}

try:
    with redirect_stdout(stdout_buf):
        exec(compile(student_code, "<hero_spell>", "exec"), ns)
    captured = stdout_buf.getvalue()
    ns["OUTPUT"] = captured
    result["stdout"] = captured
    result["phase"] = "test"
    if test_code.strip():
        test_stdout = io.StringIO()
        with redirect_stdout(test_stdout):
            exec(compile(test_code, "<trial_test>", "exec"), ns)
        extra = test_stdout.getvalue()
        if extra:
            result["stdout"] = captured + extra
    result["passed"] = True
except BaseException as exc:
    result["stdout"] = stdout_buf.getvalue()
    result["errorType"] = type(exc).__name__
    result["errorMessage"] = str(exc)
    result["stderr"] = traceback.format_exc()

sys.stdout.write(json.dumps(result))
`;

function buildPipHint(
  passed: boolean,
  errorType: string | null,
  errorMessage: string | null,
  phase: string,
  timedOut: boolean
): string {
  if (passed) {
    return "Pip chirps happily! Your Python spell passed every single test rune!";
  }
  if (timedOut) {
    return "Whoa, Pip got dizzy! Your spell took longer than 3 seconds — check if a loop is running forever.";
  }

  const msg = errorMessage || "";
  switch (errorType) {
    case "SyntaxError":
      return `Pip spotted a typo in your spell syntax (${msg || "check quotes, colons ':', and matching parentheses '()'"}).`;
    case "IndentationError":
    case "TabError":
      return "Pip noticed uneven spacing! In Python, lines inside an `if`, `for`, or `def` block need the exact same indentation (4 spaces).";
    case "NameError": {
      const match = msg.match(/name '([^']+)' is not defined/);
      const name = match ? match[1] : "that name";
      return `Pip scratched his head — Python doesn't know '${name}' yet. Check the spelling or make sure you defined it before using it!`;
    }
    case "TypeError":
      return `Pip saw two mismatched types bumping into each other (${msg}). Remember you can't mix strings and numbers without converting them (like str() or int())!`;
    case "ValueError":
      return `Pip says the right kind of value was passed, but its contents didn't work (${msg}). Double-check the exact text or number!`;
    case "ZeroDivisionError":
      return "Pip ducked! Dividing by zero makes the magic runes explode — check your divisor.";
    case "IndexError":
      return "Pip peeked past the end of your list! Remember Python lists start counting at 0.";
    case "KeyError":
      return `Pip couldn't find that key in the dictionary (${msg}). Check the spelling and quotes!`;
    case "AssertionError":
      if (msg) {
        return `Almost there! Pip checked the Trial runes and found: ${msg}`;
      }
      return "Almost there! Your code ran without crashing, but the output or variable value didn't quite match what the Trial expects.";
    default:
      if (phase === "test") {
        return `Pip saw your spell run, but a test check failed (${errorType || "Error"}: ${msg || "check expected values"}).`;
      }
      return `Pip bumped into a ${errorType || "Python error"}: ${msg || "check your spell carefully and try again!"}`;
  }
}

export async function runTrialTest(
  code: string,
  testCode: string,
  timeoutMs = 3000
): Promise<TrialTestResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", "-c", PYTHON_HARNESS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        PYTHONIOENCODING: "utf-8",
      },
    });

    let stdoutRaw = "";
    let stderrRaw = "";
    let timedOut = false;
    let settled = false;

    const finish = (res: TrialTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish({
        passed: false,
        stdout: "",
        stderr: `Execution timed out after ${timeoutMs}ms`,
        pipFriendlyHint: buildPipHint(false, "TimeoutError", null, "student", true),
        timedOut: true,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutRaw += chunk.toString("utf8");
      if (stdoutRaw.length > 262_144) {
        child.kill("SIGKILL");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrRaw += chunk.toString("utf8");
      if (stderrRaw.length > 262_144) {
        child.kill("SIGKILL");
      }
    });

    child.on("error", (err) => {
      finish({
        passed: false,
        stdout: "",
        stderr: `Failed to launch python3: ${err.message}`,
        pipFriendlyHint:
          "Pip couldn't wake up the Python engine (`python3`). Make sure Python 3 is installed on this machine.",
        durationMs: Date.now() - start,
      });
    });

    child.on("close", () => {
      if (timedOut) return;
      const durationMs = Date.now() - start;
      try {
        const parsed = JSON.parse(stdoutRaw) as {
          passed: boolean;
          stdout: string;
          stderr: string;
          errorType: string | null;
          errorMessage: string | null;
          phase: string;
        };
        finish({
          passed: Boolean(parsed.passed),
          stdout: parsed.stdout ?? "",
          stderr: parsed.stderr ?? stderrRaw,
          pipFriendlyHint: buildPipHint(
            Boolean(parsed.passed),
            parsed.errorType ?? null,
            parsed.errorMessage ?? null,
            parsed.phase ?? "student",
            false
          ),
          timedOut: false,
          durationMs,
        });
      } catch {
        finish({
          passed: false,
          stdout: stdoutRaw,
          stderr: stderrRaw || "Unexpected runner output",
          pipFriendlyHint: buildPipHint(
            false,
            "RuntimeError",
            stderrRaw.trim().split("\n").pop() || null,
            "student",
            false
          ),
          timedOut: false,
          durationMs,
        });
      }
    });

    child.stdin.write(JSON.stringify({ code, testCode }));
    child.stdin.end();
  });
}
