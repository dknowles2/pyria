#!/usr/bin/env python3
"""Pyria lightweight Python 3 stdlib + SQLite game & builder server.

Runs identically on macOS (local dev) and Debian 13 (elzar) with zero
third-party dependencies.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit


MIME_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MiB

PYTHON_TRIAL_HARNESS = r"""
import io
import json
import sys
import traceback
from contextlib import redirect_stdout

payload = json.loads(sys.stdin.read())
student_code = payload.get("code", "")
test_code = payload.get("testCode", "")

stdout_buf = io.StringIO()
ns = {"__name__": "__main__"}
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
"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    tmp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp_path, path)


def build_pip_hint(
    passed: bool,
    error_type: str | None,
    error_message: str | None,
    phase: str,
    timed_out: bool,
) -> str:
    if passed:
        return "Pip chirps happily! Your Python spell passed every single test rune!"
    if timed_out:
        return "Whoa, Pip got dizzy! Your spell took longer than 3 seconds — check if a loop is running forever."

    msg = error_message or ""
    if error_type == "SyntaxError":
        return f"Pip spotted a typo in your spell syntax ({msg or 'check quotes, colons, and parentheses'})."
    if error_type in ("IndentationError", "TabError"):
        return "Pip noticed uneven spacing! In Python, lines inside an `if`, `for`, or `def` block need the exact same indentation (4 spaces)."
    if error_type == "NameError":
        m = re.search(r"name '([^']+)' is not defined", msg)
        name = m.group(1) if m else "that name"
        return f"Pip scratched his head — Python doesn't know '{name}' yet. Check the spelling or define it before using it!"
    if error_type == "TypeError":
        return f"Pip saw two mismatched types bumping into each other ({msg}). Remember you can't mix strings and numbers without converting them!"
    if error_type == "ValueError":
        return f"Pip says the right kind of value was passed, but its contents didn't work ({msg})."
    if error_type == "ZeroDivisionError":
        return "Pip ducked! Dividing by zero makes the magic runes explode — check your divisor."
    if error_type == "IndexError":
        return "Pip peeked past the end of your list! Remember Python lists start counting at 0."
    if error_type == "KeyError":
        return f"Pip couldn't find that key in the dictionary ({msg}). Check the spelling and quotes!"
    if error_type == "AssertionError":
        if msg:
            return f"Almost there! Pip checked the Trial runes and found: {msg}"
        return "Almost there! Your code ran without crashing, but the output or variable value didn't quite match what the Trial expects."
    if phase == "test":
        return f"Pip saw your spell run, but a test check failed ({error_type or 'Error'}: {msg or 'check expected values'})."
    return f"Pip bumped into a {error_type or 'Python error'}: {msg or 'check your spell carefully and try again!'}"


def run_sandboxed_trial_test(
    code: str, test_code: str, timeout_sec: float = 3.0
) -> dict[str, Any]:
    start = time.monotonic()
    payload = json.dumps({"code": code, "testCode": test_code})
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONIOENCODING": "utf-8",
    }
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "-c", PYTHON_TRIAL_HARNESS],
            input=payload,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
        )
    except subprocess.TimeoutExpired:
        duration_ms = int((time.monotonic() - start) * 1000)
        return {
            "passed": False,
            "stdout": "",
            "stderr": f"Execution timed out after {int(timeout_sec * 1000)}ms",
            "timedOut": True,
            "pipFriendlyHint": build_pip_hint(False, "TimeoutError", None, "student", True),
            "durationMs": duration_ms,
        }
    except OSError as exc:
        duration_ms = int((time.monotonic() - start) * 1000)
        return {
            "passed": False,
            "stdout": "",
            "stderr": f"Failed to launch python3: {exc}",
            "timedOut": False,
            "pipFriendlyHint": "Pip couldn't wake up the Python engine.",
            "durationMs": duration_ms,
        }

    duration_ms = int((time.monotonic() - start) * 1000)
    try:
        parsed = json.loads(proc.stdout)
        passed = bool(parsed.get("passed", False))
        return {
            "passed": passed,
            "stdout": str(parsed.get("stdout", "")),
            "stderr": str(parsed.get("stderr", "") or proc.stderr),
            "timedOut": False,
            "pipFriendlyHint": build_pip_hint(
                passed,
                parsed.get("errorType"),
                parsed.get("errorMessage"),
                str(parsed.get("phase", "student")),
                False,
            ),
            "durationMs": duration_ms,
        }
    except json.JSONDecodeError:
        err_line = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else None
        return {
            "passed": False,
            "stdout": proc.stdout,
            "stderr": proc.stderr or "Unexpected runner output",
            "timedOut": False,
            "pipFriendlyHint": build_pip_hint(False, "RuntimeError", err_line, "student", False),
            "durationMs": duration_ms,
        }


def compute_concept_warnings(
    game: dict[str, Any], eras: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    concept_map: dict[str, dict[str, Any]] = {}
    for entry in game.get("conceptProgression") or []:
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            concept_map[entry["id"]] = entry

    era_order = game.get("eraOrder") or [e.get("id", "") for e in eras]

    def era_rank(era_id: str) -> int:
        try:
            return era_order.index(era_id)
        except ValueError:
            return 999

    cumulative_offset = 0
    for era in eras:
        era_id = str(era.get("id", ""))
        era_name = str(era.get("name", era_id))
        cur_rank = era_rank(era_id)
        realms = era.get("realms") or []
        for realm in realms:
            realm_id = str(realm.get("id", ""))
            realm_num = int(realm.get("number") or 0)
            realm_name = str(realm.get("name", realm_id))
            global_num = cumulative_offset + realm_num

            def check(concept_id: str, source: str, trial: dict[str, Any] | None = None) -> None:
                rule = concept_map.get(concept_id)
                if not rule or not isinstance(rule.get("maxBasicRealm"), (int, float)):
                    return
                max_basic = int(rule["maxBasicRealm"])
                min_rank = era_rank(str(rule.get("minEra", "")))
                exceeds_same = cur_rank == min_rank and realm_num > max_basic
                exceeds_later = cur_rank > min_rank and global_num > max_basic
                if exceeds_same or exceeds_later:
                    if trial is not None:
                        msg = (
                            f'Realm {realm_num} ({realm_name}) Trial "{trial.get("title", "")}" '
                            f'repeats basic concept "{concept_id}" past maxBasicRealm {max_basic}.'
                        )
                    else:
                        msg = (
                            f'Realm {realm_num} ({realm_name}) lists basic concept "{concept_id}" '
                            f"in primaryConcepts past maxBasicRealm {max_basic}."
                        )
                    item: dict[str, Any] = {
                        "eraId": era_id,
                        "eraName": era_name,
                        "realmId": realm_id,
                        "realmNumber": realm_num,
                        "realmName": realm_name,
                        "conceptId": concept_id,
                        "maxBasicRealm": max_basic,
                        "source": source,
                        "message": msg,
                    }
                    if trial is not None:
                        item["trialId"] = trial.get("id")
                        item["trialTitle"] = trial.get("title")
                    warnings.append(item)

            for c in realm.get("primaryConcepts") or []:
                check(str(c), "realm.primaryConcepts")
            for t in realm.get("trials") or []:
                for c in t.get("concepts") or []:
                    check(str(c), "trial.concepts", t)

        cumulative_offset += len(realms)

    return warnings


def _extract_string_set(state: dict[str, Any], *keys: str) -> set[str]:
    out: set[str] = set()
    for key in keys:
        val = state.get(key)
        if isinstance(val, list):
            for item in val:
                if item is not None:
                    out.add(str(item))
    return out


class PyriaDatabase:
    """Thread-safe SQLite storage for hero saves, trial attempts, and activity events."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_schema()

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS saves (
                    id TEXT PRIMARY KEY,
                    hero_name TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS trial_attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    save_id TEXT NOT NULL,
                    trial_id TEXT NOT NULL,
                    passed INTEGER NOT NULL,
                    hints_used INTEGER NOT NULL DEFAULT 0,
                    code TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (save_id) REFERENCES saves(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS activity_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    save_id TEXT NOT NULL,
                    hero_name TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    realm_id TEXT,
                    trial_id TEXT,
                    summary TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_saves_updated_at
                    ON saves(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_attempts_save_id
                    ON trial_attempts(save_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_activity_events_id
                    ON activity_events(id DESC);
                CREATE INDEX IF NOT EXISTS idx_activity_events_save_id
                    ON activity_events(save_id, id DESC);
                """
            )

    @staticmethod
    def _row_to_save(row: sqlite3.Row) -> dict[str, Any]:
        try:
            state = json.loads(row["state_json"])
            if not isinstance(state, dict):
                state = {}
        except json.JSONDecodeError:
            state = {}
        return {
            **state,
            "id": row["id"],
            "heroName": row["hero_name"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> dict[str, Any]:
        try:
            details = json.loads(row["details_json"])
        except json.JSONDecodeError:
            details = {}
        return {
            "id": int(row["id"]),
            "saveId": row["save_id"],
            "heroName": row["hero_name"],
            "eventType": row["event_type"],
            "realmId": row["realm_id"],
            "trialId": row["trial_id"],
            "summary": row["summary"],
            "details": details,
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _insert_event(
        conn: sqlite3.Connection,
        save_id: str,
        hero_name: str,
        event_type: str,
        summary: str,
        details: dict[str, Any],
        realm_id: str | None = None,
        trial_id: str | None = None,
        created_at: str | None = None,
    ) -> int:
        ts = created_at or utc_now_iso()
        cur = conn.execute(
            "INSERT INTO activity_events "
            "(save_id, hero_name, event_type, realm_id, trial_id, summary, details_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                save_id,
                hero_name,
                event_type,
                realm_id,
                trial_id,
                summary,
                json.dumps(details, ensure_ascii=False),
                ts,
            ),
        )
        return int(cur.lastrowid)

    def count_saves(self) -> int:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM saves").fetchone()
            return int(row["cnt"]) if row else 0

    def list_saves(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id, hero_name, state_json, created_at, updated_at "
                "FROM saves ORDER BY updated_at DESC, created_at DESC"
            ).fetchall()
            return [self._row_to_save(r) for r in rows]

    def get_save(self, save_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT id, hero_name, state_json, created_at, updated_at "
                "FROM saves WHERE id = ?",
                (save_id,),
            ).fetchone()
            return self._row_to_save(row) if row else None

    def create_save(self, payload: dict[str, Any]) -> dict[str, Any]:
        save_id = str(uuid.uuid4())
        hero_name = str(
            payload.get("heroName") or payload.get("hero_name") or "Code-Tamer"
        ).strip() or "Code-Tamer"
        now = utc_now_iso()
        state = {
            **payload,
            "id": save_id,
            "heroName": hero_name,
            "createdAt": now,
            "updatedAt": now,
        }
        state_json = json.dumps(state, ensure_ascii=False)
        realm_id = str(state.get("realmId") or "realm-01-meadow")
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO saves (id, hero_name, state_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (save_id, hero_name, state_json, now, now),
            )
            self._insert_event(
                conn,
                save_id=save_id,
                hero_name=hero_name,
                event_type="hero_created",
                realm_id=realm_id,
                summary=f"Forged new hero {hero_name}",
                details={"heroName": hero_name, "appearance": state.get("appearance")},
                created_at=now,
            )
        return state

    def update_save(
        self, save_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            existing = conn.execute(
                "SELECT id, hero_name, state_json, created_at, updated_at "
                "FROM saves WHERE id = ?",
                (save_id,),
            ).fetchone()
            if existing is None:
                return None

            try:
                prev_state = json.loads(existing["state_json"])
                if not isinstance(prev_state, dict):
                    prev_state = {}
            except json.JSONDecodeError:
                prev_state = {}

            hero_name = str(
                payload.get("heroName")
                or payload.get("hero_name")
                or existing["hero_name"]
            ).strip() or existing["hero_name"]
            now = utc_now_iso()
            state = {
                **payload,
                "id": save_id,
                "heroName": hero_name,
                "createdAt": existing["created_at"],
                "updatedAt": now,
            }
            state_json = json.dumps(state, ensure_ascii=False)
            conn.execute(
                "UPDATE saves SET hero_name = ?, state_json = ?, updated_at = ? "
                "WHERE id = ?",
                (hero_name, state_json, now, save_id),
            )

            # Diff previous vs new state to emit live activity events
            cur_realm = str(state.get("realmId") or prev_state.get("realmId") or "") or None
            prev_realm = str(prev_state.get("realmId") or "") or None

            prev_chests = _extract_string_set(prev_state, "openedChests")
            new_chests = _extract_string_set(state, "openedChests")
            for chest_id in sorted(new_chests - prev_chests):
                self._insert_event(
                    conn,
                    save_id=save_id,
                    hero_name=hero_name,
                    event_type="chest_opened",
                    realm_id=cur_realm,
                    summary=f"Opened treasure chest {chest_id}",
                    details={"chestId": chest_id, "byteShards": state.get("byteShards")},
                    created_at=now,
                )

            prev_unlocks = _extract_string_set(
                prev_state, "ownedUnlockIds", "unlockedItems", "unlockedIds"
            )
            new_unlocks = _extract_string_set(
                state, "ownedUnlockIds", "unlockedItems", "unlockedIds"
            )
            for unlock_id in sorted(new_unlocks - prev_unlocks):
                self._insert_event(
                    conn,
                    save_id=save_id,
                    hero_name=hero_name,
                    event_type="workshop_purchase",
                    realm_id=cur_realm,
                    summary=f"Unlocked {unlock_id} in Bram's Workshop",
                    details={"unlockId": unlock_id, "byteShards": state.get("byteShards")},
                    created_at=now,
                )

            prev_dragons = _extract_string_set(prev_state, "rescuedDragons")
            new_dragons = _extract_string_set(state, "rescuedDragons")
            for dragon_id in sorted(new_dragons - prev_dragons):
                self._insert_event(
                    conn,
                    save_id=save_id,
                    hero_name=hero_name,
                    event_type="dragon_rescued",
                    realm_id=cur_realm,
                    summary=f"Rescued dragon {dragon_id}!",
                    details={"dragonId": dragon_id},
                    created_at=now,
                )

            if prev_realm and cur_realm and prev_realm != cur_realm:
                self._insert_event(
                    conn,
                    save_id=save_id,
                    hero_name=hero_name,
                    event_type="realm_entered",
                    realm_id=cur_realm,
                    summary=f"Entered {cur_realm}",
                    details={"fromRealmId": prev_realm, "toRealmId": cur_realm},
                    created_at=now,
                )

            return state

    def delete_save(self, save_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM saves WHERE id = ?", (save_id,))
            return cur.rowcount > 0

    def log_attempt(
        self,
        save_id: str,
        trial_id: str,
        passed: bool,
        hints_used: int,
        code: str,
    ) -> int | None:
        now = utc_now_iso()
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT hero_name, state_json FROM saves WHERE id = ?",
                (save_id,),
            ).fetchone()
            if row is None:
                return None
            hero_name = str(row["hero_name"])
            try:
                st = json.loads(row["state_json"])
                realm_id = str(st.get("realmId") or "") or None if isinstance(st, dict) else None
            except json.JSONDecodeError:
                realm_id = None

            cur = conn.execute(
                "INSERT INTO trial_attempts "
                "(save_id, trial_id, passed, hints_used, code, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (save_id, trial_id, 1 if passed else 0, hints_used, code, now),
            )
            attempt_id = int(cur.lastrowid)

            self._insert_event(
                conn,
                save_id=save_id,
                hero_name=hero_name,
                event_type="trial_passed" if passed else "trial_failed",
                realm_id=realm_id,
                trial_id=trial_id,
                summary=(
                    f"Passed Trial {trial_id}"
                    if passed
                    else f"Attempted Trial {trial_id}"
                ),
                details={
                    "trialId": trial_id,
                    "passed": passed,
                    "hintsUsed": hints_used,
                    "code": code,
                    "attemptId": attempt_id,
                },
                created_at=now,
            )
            return attempt_id

    def list_attempts(self, save_id: str) -> list[dict[str, Any]] | None:
        with self._lock, self._connect() as conn:
            exists = conn.execute(
                "SELECT 1 FROM saves WHERE id = ?", (save_id,)
            ).fetchone()
            if exists is None:
                return None
            rows = conn.execute(
                "SELECT id, save_id, trial_id, passed, hints_used, code, created_at "
                "FROM trial_attempts WHERE save_id = ? "
                "ORDER BY created_at DESC, id DESC",
                (save_id,),
            ).fetchall()
            return [
                {
                    "id": int(r["id"]),
                    "saveId": r["save_id"],
                    "trialId": r["trial_id"],
                    "passed": bool(r["passed"]),
                    "hintsUsed": int(r["hints_used"]),
                    "code": r["code"],
                    "createdAt": r["created_at"],
                }
                for r in rows
            ]

    def get_activity_since(
        self, since_id: int = 0, limit: int = 50
    ) -> tuple[list[dict[str, Any]], int]:
        clamped_limit = max(1, min(limit, 200))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id, save_id, hero_name, event_type, realm_id, trial_id, "
                "summary, details_json, created_at "
                "FROM activity_events WHERE id > ? ORDER BY id ASC LIMIT ?",
                (since_id, clamped_limit),
            ).fetchall()
            latest_row = conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS latest_id FROM activity_events"
            ).fetchone()
            latest_id = int(latest_row["latest_id"]) if latest_row else 0
            return [self._row_to_event(r) for r in rows], latest_id

    def get_progress_snapshot(self) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            save_rows = conn.execute(
                "SELECT id, hero_name, state_json, created_at, updated_at "
                "FROM saves ORDER BY updated_at DESC, created_at DESC"
            ).fetchall()
            attempt_rows = conn.execute(
                "SELECT save_id, COUNT(*) AS attempt_count, "
                "SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count, "
                "SUM(hints_used) AS total_hints, "
                "MAX(created_at) AS last_attempt_at "
                "FROM trial_attempts GROUP BY save_id"
            ).fetchall()
            event_rows = conn.execute(
                "SELECT id, save_id, hero_name, event_type, realm_id, trial_id, "
                "summary, details_json, created_at "
                "FROM activity_events ORDER BY id DESC LIMIT 80"
            ).fetchall()

        attempts_by_save = {str(r["save_id"]): r for r in attempt_rows}
        enriched_saves: list[dict[str, Any]] = []
        total_attempts = 0
        total_passes = 0
        total_hints = 0
        total_dragons = 0

        for row in save_rows:
            save_id = str(row["id"])
            state = self._row_to_save(row)
            att = attempts_by_save.get(save_id)
            attempt_count = int(att["attempt_count"]) if att else 0
            pass_count = int(att["pass_count"] or 0) if att else 0
            hints_used = int(att["total_hints"] or 0) if att else 0
            last_attempt_at = str(att["last_attempt_at"]) if (att and att["last_attempt_at"]) else ""
            last_active = max(str(row["updated_at"]), last_attempt_at)

            solved_set = _extract_string_set(state, "solvedTrials", "completedTrials")
            rescued_set = _extract_string_set(state, "rescuedDragons")

            total_attempts += attempt_count
            total_passes += pass_count
            total_hints += hints_used
            total_dragons += len(rescued_set)

            enriched_saves.append(
                {
                    "id": save_id,
                    "heroName": str(row["hero_name"]),
                    "state": state,
                    "stats": {
                        "attemptCount": attempt_count,
                        "passCount": pass_count,
                        "totalHintsUsed": hints_used,
                        "solvedCount": len(solved_set),
                        "rescuedCount": len(rescued_set),
                        "lastActive": last_active,
                    },
                    "updatedAt": str(row["updated_at"]),
                }
            )

        pass_rate = round((total_passes / total_attempts) * 100, 1) if total_attempts > 0 else 0.0
        return {
            "saves": enriched_saves,
            "recentEvents": [self._row_to_event(r) for r in event_rows],
            "summary": {
                "totalSaves": len(enriched_saves),
                "totalAttempts": total_attempts,
                "passRate": pass_rate,
                "totalHintsUsed": total_hints,
                "totalDragonsRescued": total_dragons,
            },
        }

    def override_trial(
        self,
        save_id: str,
        trial_id: str,
        solved: bool,
        award_shards: bool,
        shard_reward: int,
    ) -> tuple[dict[str, Any], int] | None:
        now = utc_now_iso()
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT id, hero_name, state_json, created_at, updated_at "
                "FROM saves WHERE id = ?",
                (save_id,),
            ).fetchone()
            if row is None:
                return None

            state = self._row_to_save(row)
            hero_name = str(row["hero_name"])

            # Preserve order while deduplicating solvedTrials / completedTrials
            ordered_solved: list[str] = []
            seen: set[str] = set()
            for key in ("solvedTrials", "completedTrials"):
                val = state.get(key)
                if isinstance(val, list):
                    for item in val:
                        s = str(item)
                        if s not in seen:
                            seen.add(s)
                            ordered_solved.append(s)

            shards_delta = 0
            if solved:
                was_already_solved = trial_id in seen
                if not was_already_solved:
                    ordered_solved.append(trial_id)
                    if award_shards and shard_reward > 0:
                        shards_delta = int(shard_reward)
                        state["byteShards"] = int(state.get("byteShards") or 0) + shards_delta
                drafts = state.get("trialDrafts")
                if isinstance(drafts, dict) and trial_id in drafts:
                    drafts = dict(drafts)
                    drafts.pop(trial_id, None)
                    state["trialDrafts"] = drafts
                summary = (
                    f"Parent marked {trial_id} complete (+{shards_delta} Shards)"
                    if shards_delta > 0
                    else f"Parent marked {trial_id} complete"
                )
            else:
                ordered_solved = [t for t in ordered_solved if t != trial_id]
                summary = f"Parent reset {trial_id} to unsolved"

            state["solvedTrials"] = list(ordered_solved)
            state["completedTrials"] = list(ordered_solved)
            state["updatedAt"] = now

            conn.execute(
                "UPDATE saves SET state_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(state, ensure_ascii=False), now, save_id),
            )

            realm_id = str(state.get("realmId") or "") or None
            self._insert_event(
                conn,
                save_id=save_id,
                hero_name=hero_name,
                event_type="parent_override",
                realm_id=realm_id,
                trial_id=trial_id,
                summary=summary,
                details={
                    "trialId": trial_id,
                    "solved": solved,
                    "shardsDelta": shards_delta,
                    "byteShards": state.get("byteShards", 0),
                },
                created_at=now,
            )

            att = conn.execute(
                "SELECT COUNT(*) AS attempt_count, "
                "SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count, "
                "SUM(hints_used) AS total_hints, "
                "MAX(created_at) AS last_attempt_at "
                "FROM trial_attempts WHERE save_id = ?",
                (save_id,),
            ).fetchone()

        attempt_count = int(att["attempt_count"]) if att else 0
        pass_count = int(att["pass_count"] or 0) if att else 0
        hints_used = int(att["total_hints"] or 0) if att else 0
        last_attempt_at = str(att["last_attempt_at"]) if (att and att["last_attempt_at"]) else ""
        rescued_set = _extract_string_set(state, "rescuedDragons")

        enriched = {
            "id": save_id,
            "heroName": hero_name,
            "state": state,
            "stats": {
                "attemptCount": attempt_count,
                "passCount": pass_count,
                "totalHintsUsed": hints_used,
                "solvedCount": len(ordered_solved),
                "rescuedCount": len(rescued_set),
                "lastActive": max(now, last_attempt_at),
            },
            "updatedAt": now,
        }
        return enriched, shards_delta


class PyriaHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        root_dir: Path,
        db: PyriaDatabase,
    ) -> None:
        self.root_dir = root_dir.resolve()
        self.web_dir = (self.root_dir / "web").resolve()
        self.content_dir = (self.root_dir / "content").resolve()
        self.assets_dir = (self.root_dir / "assets").resolve()
        self.db = db
        self.content_lock = threading.Lock()
        super().__init__(server_address, PyriaRequestHandler)

    def load_game_and_catalog(self) -> tuple[dict[str, Any], dict[str, Any]]:
        game = json.loads((self.content_dir / "game.json").read_text(encoding="utf-8"))
        catalog = json.loads((self.content_dir / "catalog.json").read_text(encoding="utf-8"))
        return game, catalog

    def load_all_eras(self, game: dict[str, Any]) -> list[dict[str, Any]]:
        eras_dir = self.content_dir / "eras"
        ordered_ids: list[str] = list(game.get("eraOrder") or [])
        if eras_dir.is_dir():
            for p in sorted(eras_dir.glob("*.json")):
                if p.stem not in ordered_ids:
                    ordered_ids.append(p.stem)
        eras: list[dict[str, Any]] = []
        for era_id in ordered_ids:
            era_path = eras_dir / f"{era_id}.json"
            if era_path.is_file():
                eras.append(json.loads(era_path.read_text(encoding="utf-8")))
        return eras

    def resolve_era_path(self, era_id: str) -> Path | None:
        if not era_id or "/" in era_id or "\\" in era_id or ".." in era_id:
            return None
        eras_dir = (self.content_dir / "eras").resolve()
        target = (eras_dir / f"{era_id}.json").resolve()
        if not target.is_relative_to(eras_dir) or not target.is_file():
            return None
        return target

    def find_trial_shard_reward(self, trial_id: str) -> int:
        try:
            with self.content_lock:
                game, _ = self.load_game_and_catalog()
                eras = self.load_all_eras(game)
        except (FileNotFoundError, json.JSONDecodeError):
            return 0
        for era in eras:
            for realm in era.get("realms") or []:
                for trial in realm.get("trials") or []:
                    if trial.get("id") == trial_id:
                        try:
                            return max(0, int(trial.get("shardReward") or 0))
                        except (TypeError, ValueError):
                            return 0
        return 0


class PyriaRequestHandler(BaseHTTPRequestHandler):
    server: PyriaHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        if getattr(self.server, "quiet", False):
            return
        super().log_message(format, *args)

    def _send_json(
        self, status: int, data: dict[str, Any], no_store: bool = True
    ) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_json_body(self) -> tuple[dict[str, Any] | None, str | None]:
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            return None, "Missing Content-Length header"
        try:
            length = int(raw_len)
        except ValueError:
            return None, "Invalid Content-Length header"
        if length < 0 or length > MAX_BODY_BYTES:
            return None, f"Request body exceeds limit ({MAX_BODY_BYTES} bytes)"
        raw = self.rfile.read(length)
        if not raw:
            return {}, None
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return None, f"Invalid JSON body: {exc}"
        if not isinstance(parsed, dict):
            return None, "JSON body must be an object"
        return parsed, None

    def _check_builder_auth(self) -> bool:
        passcode = os.environ.get("PYRIA_BUILDER_PASSCODE", "")
        if not passcode:
            return True
        provided = self.headers.get("X-Builder-Passcode", "")
        if provided != passcode:
            self._send_json(
                HTTPStatus.UNAUTHORIZED,
                {"error": "Invalid or missing X-Builder-Passcode header"},
            )
            return False
        return True

    @staticmethod
    def _has_traversal(raw_path: str) -> bool:
        decoded = unquote(raw_path)
        if "\x00" in decoded or "\\" in decoded:
            return True
        segments = decoded.split("/")
        return any(seg == ".." for seg in segments)

    def _serve_static(self, raw_path: str) -> None:
        if self._has_traversal(raw_path):
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden path"})
            return

        decoded = unquote(raw_path)
        no_store = False

        if decoded.startswith("/content/"):
            base_dir = self.server.content_dir
            rel = decoded[len("/content/") :]
            no_store = True
        elif decoded.startswith("/assets/"):
            base_dir = self.server.assets_dir
            rel = decoded[len("/assets/") :]
        elif decoded == "/builder" or decoded == "/builder/":
            base_dir = self.server.web_dir
            rel = "builder/index.html"
        elif decoded.startswith("/builder/"):
            base_dir = self.server.web_dir
            rel = decoded.lstrip("/")
        else:
            base_dir = self.server.web_dir
            rel = "index.html" if decoded in ("", "/") else decoded.lstrip("/")

        if not rel or rel.endswith("/"):
            rel = f"{rel}index.html"

        try:
            target = (base_dir / rel).resolve()
        except (OSError, ValueError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid path"})
            return

        if not target.is_relative_to(base_dir):
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden path"})
            return

        if not target.exists() or not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "File not found"})
            return

        mime = MIME_TYPES.get(target.suffix.lower())
        if mime is None:
            guessed, _ = mimetypes.guess_type(str(target))
            mime = guessed or "application/octet-stream"

        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        is_app_code = target.suffix.lower() in {".html", ".css", ".js", ".mjs", ".webmanifest"}
        self.send_header(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, max-age=0" if (no_store or is_app_code) else "no-cache",
        )
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _handle_builder_get(self, path: str, query: str) -> None:
        if not self._check_builder_auth():
            return

        if path == "/api/builder/progress":
            snapshot = self.server.db.get_progress_snapshot()
            try:
                game, _ = self.server.load_game_and_catalog()
                global_diff = game.get("globalDifficultyOverride", {})
            except (FileNotFoundError, json.JSONDecodeError):
                global_diff = {}
            snapshot["globalDifficultyOverride"] = global_diff
            self._send_json(HTTPStatus.OK, snapshot)
            return

        if path == "/api/builder/activity":
            qs = parse_qs(query)
            try:
                since_id = int(qs.get("since", ["0"])[0])
            except ValueError:
                since_id = 0
            try:
                limit = int(qs.get("limit", ["50"])[0])
            except ValueError:
                limit = 50
            events, latest_id = self.server.db.get_activity_since(
                since_id=max(0, since_id), limit=limit
            )
            self._send_json(
                HTTPStatus.OK, {"events": events, "latestId": latest_id}
            )
            return

        if path == "/api/builder/overview":
            try:
                with self.server.content_lock:
                    game, catalog = self.server.load_game_and_catalog()
                    eras = self.server.load_all_eras(game)
            except FileNotFoundError as exc:
                self._send_json(
                    HTTPStatus.NOT_FOUND,
                    {"error": f"Content file missing: {exc.filename}"},
                )
                return
            except json.JSONDecodeError as exc:
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Invalid content JSON: {exc}"},
                )
                return
            warnings = compute_concept_warnings(game, eras)
            self._send_json(
                HTTPStatus.OK,
                {
                    "game": game,
                    "catalog": catalog,
                    "eras": eras,
                    "conceptWarnings": warnings,
                },
            )
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown builder API endpoint"})

    def _handle_api_get(self, path: str, query: str) -> None:
        if path.startswith("/api/builder/"):
            self._handle_builder_get(path, query)
            return

        if path == "/api/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "dbPath": str(self.server.db.db_path),
                    "saveCount": self.server.db.count_saves(),
                },
            )
            return

        if path == "/api/config":
            try:
                game, catalog = self.server.load_game_and_catalog()
            except FileNotFoundError as exc:
                self._send_json(
                    HTTPStatus.NOT_FOUND,
                    {"error": f"Content file missing: {exc.filename}"},
                )
                return
            except json.JSONDecodeError as exc:
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"Invalid content JSON: {exc}"},
                )
                return
            self._send_json(HTTPStatus.OK, {"game": game, "catalog": catalog})
            return

        if path == "/api/saves":
            self._send_json(
                HTTPStatus.OK, {"saves": self.server.db.list_saves()}
            )
            return

        parts = [p for p in path.split("/") if p]
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "saves":
            save = self.server.db.get_save(parts[2])
            if save is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(HTTPStatus.OK, {"save": save})
            return

        if (
            len(parts) == 4
            and parts[0] == "api"
            and parts[1] == "saves"
            and parts[3] == "attempts"
        ):
            attempts = self.server.db.list_attempts(parts[2])
            if attempts is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(HTTPStatus.OK, {"attempts": attempts})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown API endpoint"})

    def do_HEAD(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api_get(parsed.path, parsed.query)
        else:
            self._serve_static(parsed.path)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api_get(parsed.path, parsed.query)
        else:
            self._serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path

        if path == "/api/builder/test-trial":
            if not self._check_builder_auth():
                return
            body, err = self._read_json_body()
            if err is not None or body is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
                return
            code = str(body.get("code", ""))
            test_code = str(body.get("testCode", ""))
            result = run_sandboxed_trial_test(code, test_code, timeout_sec=3.0)
            self._send_json(HTTPStatus.OK, result)
            return

        parts = [p for p in path.split("/") if p]
        # POST /api/builder/saves/<saveId>/override-trial
        if (
            len(parts) == 5
            and parts[0] == "api"
            and parts[1] == "builder"
            and parts[2] == "saves"
            and parts[4] == "override-trial"
        ):
            if not self._check_builder_auth():
                return
            body, err = self._read_json_body()
            if err is not None or body is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
                return
            trial_id = str(body.get("trialId") or "").strip()
            if not trial_id:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "trialId is required"}
                )
                return
            if "solved" not in body or not isinstance(body["solved"], bool):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "solved must be a boolean"},
                )
                return
            solved = body["solved"]
            award_shards = bool(body.get("awardShards", True)) if solved else False
            shard_reward = (
                self.server.find_trial_shard_reward(trial_id)
                if (solved and award_shards)
                else 0
            )
            override_res = self.server.db.override_trial(
                save_id=unquote(parts[3]),
                trial_id=trial_id,
                solved=solved,
                award_shards=award_shards,
                shard_reward=shard_reward,
            )
            if override_res is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            enriched_save, shards_delta = override_res
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "save": enriched_save, "shardsDelta": shards_delta},
            )
            return

        if path == "/api/saves":
            body, err = self._read_json_body()
            if err is not None or body is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
                return
            if (
                "save" in body
                and len(body) == 1
                and isinstance(body["save"], dict)
            ):
                body = body["save"]
            save = self.server.db.create_save(body)
            self._send_json(HTTPStatus.CREATED, {"save": save})
            return

        if (
            len(parts) == 4
            and parts[0] == "api"
            and parts[1] == "saves"
            and parts[3] == "attempts"
        ):
            body, err = self._read_json_body()
            if err is not None or body is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
                return
            trial_id = str(
                body.get("trialId") or body.get("trial_id") or ""
            ).strip()
            if not trial_id:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "trialId is required"}
                )
                return
            passed = bool(body.get("passed", False))
            try:
                hints_used = int(
                    body.get("hintsUsed", body.get("hints_used", 0))
                )
            except (TypeError, ValueError):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "hintsUsed must be an integer"},
                )
                return
            code = str(body.get("code", ""))
            attempt_id = self.server.db.log_attempt(
                save_id=parts[2],
                trial_id=trial_id,
                passed=passed,
                hints_used=max(0, hints_used),
                code=code,
            )
            if attempt_id is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(
                HTTPStatus.CREATED, {"ok": True, "attemptId": attempt_id}
            )
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown API endpoint"})

    def _handle_builder_put(self, parts: list[str]) -> None:
        if not self._check_builder_auth():
            return
        body, err = self._read_json_body()
        if err is not None or body is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
            return

        # PUT /api/builder/difficulty
        if parts == ["api", "builder", "difficulty"]:
            scope = str(body.get("scope", ""))
            if scope not in ("global", "realm", "trial"):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "scope must be 'global', 'realm', or 'trial'"},
                )
                return
            override = body.get("override")
            with self.server.content_lock:
                if scope == "global":
                    game_path = self.server.content_dir / "game.json"
                    game = json.loads(game_path.read_text(encoding="utf-8"))
                    cur = dict(game.get("globalDifficultyOverride") or {})
                    if isinstance(override, dict):
                        if "mode" in override:
                            cur["mode"] = override["mode"]
                        if "showRawTracebacks" in override:
                            cur["showRawTracebacks"] = bool(override["showRawTracebacks"])
                        if "maxHintsAllowed" in override:
                            cur["maxHintsAllowed"] = int(override["maxHintsAllowed"])
                    if "maxHintsAllowed" in body and body["maxHintsAllowed"] is not None:
                        cur["maxHintsAllowed"] = int(body["maxHintsAllowed"])
                    game["globalDifficultyOverride"] = cur
                    write_json_atomic(game_path, game)
                    self._send_json(
                        HTTPStatus.OK,
                        {"scope": "global", "globalDifficultyOverride": cur},
                    )
                    return

                realm_id = str(body.get("realmId") or "")
                era_id = str(body.get("eraId") or "")
                if not realm_id:
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "realmId is required for realm/trial scope"},
                    )
                    return

                era_path = self.server.resolve_era_path(era_id) if era_id else None
                if era_path is None:
                    # Search all eras for realm_id
                    game, _ = self.server.load_game_and_catalog()
                    for candidate in self.server.load_all_eras(game):
                        if any(r.get("id") == realm_id for r in candidate.get("realms") or []):
                            era_id = str(candidate.get("id"))
                            era_path = self.server.resolve_era_path(era_id)
                            break
                if era_path is None:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Era or Realm not found"})
                    return

                era = json.loads(era_path.read_text(encoding="utf-8"))
                realms = era.get("realms") or []
                realm = next((r for r in realms if r.get("id") == realm_id), None)
                if realm is None:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Realm not found"})
                    return

                if scope == "realm":
                    realm["difficultyOverride"] = override
                    write_json_atomic(era_path, era)
                    self._send_json(HTTPStatus.OK, {"scope": "realm", "realm": realm})
                    return

                trial_id = str(body.get("trialId") or "")
                trials = realm.get("trials") or []
                trial = next((t for t in trials if t.get("id") == trial_id), None)
                if trial is None:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Trial not found"})
                    return
                trial["difficultyOverride"] = override
                write_json_atomic(era_path, era)
                self._send_json(
                    HTTPStatus.OK, {"scope": "trial", "realm": realm, "trial": trial}
                )
                return

        # PUT /api/builder/realms/<eraId>/<realmId>
        if len(parts) == 5 and parts[:3] == ["api", "builder", "realms"]:
            era_id, realm_id = unquote(parts[3]), unquote(parts[4])
            era_path = self.server.resolve_era_path(era_id)
            if era_path is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Era not found"})
                return
            with self.server.content_lock:
                era = json.loads(era_path.read_text(encoding="utf-8"))
                realms = era.get("realms") or []
                idx = next((i for i, r in enumerate(realms) if r.get("id") == realm_id), -1)
                if idx < 0:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Realm not found"})
                    return
                realm = dict(realms[idx])
                for field in (
                    "name",
                    "storyIntro",
                    "storyOutro",
                    "miniVisualUpgrade",
                    "primaryConcepts",
                    "difficultyOverride",
                ):
                    if field in body:
                        realm[field] = body[field]
                if isinstance(body.get("dragon"), dict):
                    realm["dragon"] = {**(realm.get("dragon") or {}), **body["dragon"]}
                realms[idx] = realm
                write_json_atomic(era_path, era)
                self._send_json(HTTPStatus.OK, {"eraId": era_id, "realm": realm})
                return

        # PUT /api/builder/realms/<eraId>/<realmId>/trials/<trialId>
        if (
            len(parts) == 7
            and parts[:3] == ["api", "builder", "realms"]
            and parts[5] == "trials"
        ):
            era_id = unquote(parts[3])
            realm_id = unquote(parts[4])
            trial_id = unquote(parts[6])
            era_path = self.server.resolve_era_path(era_id)
            if era_path is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Era not found"})
                return
            with self.server.content_lock:
                era = json.loads(era_path.read_text(encoding="utf-8"))
                realms = era.get("realms") or []
                realm = next((r for r in realms if r.get("id") == realm_id), None)
                if realm is None:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Realm not found"})
                    return
                trials = list(realm.get("trials") or [])
                t_idx = next((i for i, t in enumerate(trials) if t.get("id") == trial_id), -1)
                trial_data = {**body, "id": trial_id}
                created = t_idx < 0
                if created:
                    trials.append(trial_data)
                    merged = trial_data
                else:
                    existing_t = trials[t_idx]
                    merged = {
                        **existing_t,
                        **trial_data,
                        "starterCode": {
                            **(existing_t.get("starterCode") or {}),
                            **(trial_data.get("starterCode") or {}),
                        },
                        "hints": {
                            **(existing_t.get("hints") or {}),
                            **(trial_data.get("hints") or {}),
                        },
                    }
                    trials[t_idx] = merged
                realm["trials"] = trials
                write_json_atomic(era_path, era)
                self._send_json(
                    HTTPStatus.OK,
                    {"eraId": era_id, "realm": realm, "trial": merged, "created": created},
                )
                return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown builder API endpoint"})

    def do_PUT(self) -> None:
        parsed = urlsplit(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "api" and parts[1] == "builder":
            self._handle_builder_put(parts)
            return

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "saves":
            body, err = self._read_json_body()
            if err is not None or body is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": err})
                return
            if (
                "save" in body
                and len(body) == 1
                and isinstance(body["save"], dict)
            ):
                body = body["save"]
            updated = self.server.db.update_save(parts[2], body)
            if updated is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(HTTPStatus.OK, {"save": updated})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown API endpoint"})

    def do_DELETE(self) -> None:
        parsed = urlsplit(self.path)
        parts = [p for p in parsed.path.split("/") if p]

        # DELETE /api/builder/realms/<eraId>/<realmId>/trials/<trialId>
        if (
            len(parts) == 7
            and parts[:3] == ["api", "builder", "realms"]
            and parts[5] == "trials"
        ):
            if not self._check_builder_auth():
                return
            era_id = unquote(parts[3])
            realm_id = unquote(parts[4])
            trial_id = unquote(parts[6])
            era_path = self.server.resolve_era_path(era_id)
            if era_path is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Era not found"})
                return
            with self.server.content_lock:
                era = json.loads(era_path.read_text(encoding="utf-8"))
                realm = next((r for r in era.get("realms") or [] if r.get("id") == realm_id), None)
                if realm is None:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Realm not found"})
                    return
                trials = list(realm.get("trials") or [])
                next_trials = [t for t in trials if t.get("id") != trial_id]
                if len(next_trials) == len(trials):
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "Trial not found"})
                    return
                realm["trials"] = next_trials
                write_json_atomic(era_path, era)
                self._send_json(
                    HTTPStatus.OK,
                    {"eraId": era_id, "realm": realm, "deletedTrialId": trial_id},
                )
                return

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "saves":
            deleted = self.server.db.delete_save(parts[2])
            if not deleted:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(
                HTTPStatus.OK, {"ok": True, "deletedId": parts[2]}
            )
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown API endpoint"})


def create_server(
    host: str, port: int, root_dir: Path, db_path: Path, quiet: bool = False
) -> PyriaHTTPServer:
    db = PyriaDatabase(db_path)
    srv = PyriaHTTPServer((host, port), root_dir, db)
    setattr(srv, "quiet", quiet)
    return srv


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    default_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Pyria Python-learning RPG server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    parser.add_argument(
        "--root",
        type=Path,
        default=default_root,
        help="Repository root containing web/, content/, assets/ (default: ..)",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help="SQLite database path (default: <root>/data/pyria.sqlite3)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    root_dir = args.root.resolve()
    db_path = args.db.resolve() if args.db else (root_dir / "data" / "pyria.sqlite3")
    srv = create_server(args.host, args.port, root_dir, db_path)
    actual_host, actual_port = srv.server_address[:2]
    print(
        f"Pyria server listening on http://{actual_host}:{actual_port} "
        f"(root={root_dir}, db={db_path})",
        flush=True,
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Pyria server...", flush=True)
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
