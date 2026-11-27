#!/usr/bin/env python3
"""Pyria lightweight Python 3 stdlib + SQLite game & builder server.

Runs identically on macOS (local dev) and Debian 13 (elzar) with zero
third-party dependencies.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import sqlite3
import threading
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

MAX_JSON_BODY_BYTES = 512 * 1024  # 512 KiB

PYODIDE_CDN_ORIGIN_PATH = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"

CSP_DEFAULT = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "worker-src 'none'; "
    "frame-src 'self'; "
    "connect-src 'self'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self'"
)

CSP_ASSET_PREVIEW = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self'"
)


def build_py_sandbox_csp(html_bytes: bytes) -> str:
    """Build strict opaque-origin CSP for /py-sandbox.html using inline script SHA-256 hashes."""
    html_text = html_bytes.decode("utf-8", errors="replace")
    hashes: list[str] = []
    for match in re.finditer(
        r"<script(?:\s[^>]*)?>(.*?)</script>", html_text, re.DOTALL | re.IGNORECASE
    ):
        digest = base64.b64encode(
            hashlib.sha256(match.group(1).encode("utf-8")).digest()
        ).decode("ascii")
        hashes.append(f"'sha256-{digest}'")
    script_sources = " ".join(
        [*hashes, "blob:", PYODIDE_CDN_ORIGIN_PATH, "'wasm-unsafe-eval'"]
    )
    return (
        "sandbox allow-scripts; "
        "default-src 'none'; "
        f"script-src {script_sources}; "
        "worker-src blob:; "
        f"connect-src {PYODIDE_CDN_ORIGIN_PATH}; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "form-action 'none'; "
        "frame-ancestors 'self'"
    )


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"Disallowed JSON constant: {value}")


def _parse_finite_float(value: str) -> float:
    num = float(value)
    if not math.isfinite(num):
        raise ValueError(f"Non-finite JSON number: {value}")
    return num


def get_admin_emails() -> set[str]:
    raw = os.environ.get("PYRIA_ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def is_env_dev_mode() -> bool:
    return os.environ.get("PYRIA_DEV_MODE", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def normalize_email(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    return cleaned or None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    tmp_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp_path, path)


def _normalize_host(netloc: str, scheme: str | None = None) -> str:
    host = netloc.strip().lower()
    if scheme == "http" and host.endswith(":80"):
        return host[:-3]
    if scheme == "https" and host.endswith(":443"):
        return host[:-4]
    return host


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
                    owner_email TEXT,
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
            cols = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(saves)").fetchall()
            }
            if "owner_email" not in cols:
                conn.execute("ALTER TABLE saves ADD COLUMN owner_email TEXT")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_saves_owner_email ON saves(owner_email)"
            )

    @staticmethod
    def _row_to_save(row: sqlite3.Row) -> dict[str, Any]:
        try:
            state = json.loads(row["state_json"])
            if not isinstance(state, dict):
                state = {}
        except json.JSONDecodeError:
            state = {}
        owner_email = row["owner_email"] if "owner_email" in row.keys() else None
        return {
            **state,
            "id": row["id"],
            "heroName": row["hero_name"],
            "ownerEmail": owner_email,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> dict[str, Any]:
        try:
            details = json.loads(row["details_json"])
        except json.JSONDecodeError:
            details = {}
        owner_email = row["owner_email"] if "owner_email" in row.keys() else None
        return {
            "id": int(row["id"]),
            "saveId": row["save_id"],
            "heroName": row["hero_name"],
            "ownerEmail": owner_email,
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
                json.dumps(details, ensure_ascii=False, allow_nan=False),
                ts,
            ),
        )
        return int(cur.lastrowid)

    def count_saves(self) -> int:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM saves").fetchone()
            return int(row["cnt"]) if row else 0

    def list_accounts(self, extra_email: str | None = None) -> list[str]:
        accounts: set[str] = set()
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT LOWER(TRIM(owner_email)) AS email "
                "FROM saves WHERE owner_email IS NOT NULL AND TRIM(owner_email) != ''"
            ).fetchall()
            for r in rows:
                if r["email"]:
                    accounts.add(str(r["email"]))
        norm_extra = normalize_email(extra_email)
        if norm_extra:
            accounts.add(norm_extra)
        return sorted(accounts)

    def get_save_owner(self, save_id: str) -> tuple[bool, str | None]:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT owner_email FROM saves WHERE id = ?", (save_id,)
            ).fetchone()
            if row is None:
                return False, None
            return True, normalize_email(row["owner_email"])

    def list_saves(self, owner_filter: str | None = None) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            if owner_filter is not None:
                rows = conn.execute(
                    "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
                    "FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ? "
                    "ORDER BY updated_at DESC, created_at DESC",
                    (owner_filter.lower(),),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
                    "FROM saves ORDER BY updated_at DESC, created_at DESC"
                ).fetchall()
            return [self._row_to_save(r) for r in rows]

    def get_save(self, save_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
                "FROM saves WHERE id = ?",
                (save_id,),
            ).fetchone()
            return self._row_to_save(row) if row else None

    def create_save(
        self, payload: dict[str, Any], owner_email: str | None = None
    ) -> dict[str, Any]:
        save_id = str(uuid.uuid4())
        hero_name = str(
            payload.get("heroName") or payload.get("hero_name") or "Code-Tamer"
        ).strip() or "Code-Tamer"
        norm_owner = normalize_email(owner_email)
        now = utc_now_iso()
        state = {
            **payload,
            "id": save_id,
            "heroName": hero_name,
            "ownerEmail": norm_owner,
            "createdAt": now,
            "updatedAt": now,
        }
        if "byteShards" in state:
            try:
                state["byteShards"] = max(0, int(state["byteShards"]))
            except (TypeError, ValueError, OverflowError):
                state["byteShards"] = 0
        state_json = json.dumps(state, ensure_ascii=False, allow_nan=False)
        realm_id = str(state.get("realmId") or "realm-01-meadow")
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO saves (id, hero_name, owner_email, state_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (save_id, hero_name, norm_owner, state_json, now, now),
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

    def assign_owner(
        self, save_id: str, owner_email: str | None
    ) -> dict[str, Any] | None:
        norm_owner = normalize_email(owner_email)
        now = utc_now_iso()
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
                "FROM saves WHERE id = ?",
                (save_id,),
            ).fetchone()
            if row is None:
                return None
            state = self._row_to_save(row)
            state["ownerEmail"] = norm_owner
            state["updatedAt"] = now
            conn.execute(
                "UPDATE saves SET owner_email = ?, state_json = ?, updated_at = ? WHERE id = ?",
                (
                    norm_owner,
                    json.dumps(state, ensure_ascii=False, allow_nan=False),
                    now,
                    save_id,
                ),
            )
            return state

    def update_save(
        self, save_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            existing = conn.execute(
                "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
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
                "ownerEmail": existing["owner_email"],
                "createdAt": existing["created_at"],
                "updatedAt": now,
            }
            if "byteShards" in state:
                try:
                    state["byteShards"] = max(0, int(state["byteShards"]))
                except (TypeError, ValueError, OverflowError):
                    state["byteShards"] = int(prev_state.get("byteShards") or 0)
            state_json = json.dumps(state, ensure_ascii=False, allow_nan=False)
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

            prev_eggs = _extract_string_set(prev_state, "foundEasterEggs")
            new_eggs = _extract_string_set(state, "foundEasterEggs")
            for egg_id in sorted(new_eggs - prev_eggs):
                self._insert_event(
                    conn,
                    save_id=save_id,
                    hero_name=hero_name,
                    event_type="easter_egg_found",
                    realm_id=cur_realm,
                    summary=f"Found hidden Easter Egg: {egg_id}",
                    details={"eggId": egg_id, "byteShards": state.get("byteShards")},
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
                "SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type, "
                "e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at "
                "FROM activity_events e "
                "LEFT JOIN saves s ON s.id = e.save_id "
                "WHERE e.id > ? ORDER BY e.id ASC LIMIT ?",
                (since_id, clamped_limit),
            ).fetchall()
            latest_row = conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS latest_id FROM activity_events"
            ).fetchone()
            latest_id = int(latest_row["latest_id"]) if latest_row else 0
            return [self._row_to_event(r) for r in rows], latest_id

    def get_progress_snapshot(
        self,
        owner_filter: str | None = None,
        extra_account: str | None = None,
    ) -> dict[str, Any]:
        norm_filter = normalize_email(owner_filter) if owner_filter and owner_filter.lower() != "all" else None
        with self._lock, self._connect() as conn:
            if norm_filter:
                save_rows = conn.execute(
                    "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
                    "FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ? "
                    "ORDER BY updated_at DESC, created_at DESC",
                    (norm_filter,),
                ).fetchall()
            else:
                save_rows = conn.execute(
                    "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
                    "FROM saves ORDER BY updated_at DESC, created_at DESC"
                ).fetchall()
            attempt_rows = conn.execute(
                "SELECT save_id, COUNT(*) AS attempt_count, "
                "SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count, "
                "SUM(hints_used) AS total_hints, "
                "MAX(created_at) AS last_attempt_at "
                "FROM trial_attempts GROUP BY save_id"
            ).fetchall()
            if norm_filter:
                event_rows = conn.execute(
                    "SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type, "
                    "e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at "
                    "FROM activity_events e "
                    "LEFT JOIN saves s ON s.id = e.save_id "
                    "WHERE LOWER(COALESCE(s.owner_email, '')) = ? "
                    "ORDER BY e.id DESC LIMIT 80",
                    (norm_filter,),
                ).fetchall()
            else:
                event_rows = conn.execute(
                    "SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type, "
                    "e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at "
                    "FROM activity_events e "
                    "LEFT JOIN saves s ON s.id = e.save_id "
                    "ORDER BY e.id DESC LIMIT 80"
                ).fetchall()

        accounts = self.list_accounts(extra_email=extra_account)
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
                    "ownerEmail": row["owner_email"],
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
            "accounts": accounts,
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
                "SELECT id, hero_name, owner_email, state_json, created_at, updated_at "
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
                (
                    json.dumps(state, ensure_ascii=False, allow_nan=False),
                    now,
                    save_id,
                ),
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
            "ownerEmail": row["owner_email"],
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
        dev_mode: bool = False,
    ) -> None:
        self.root_dir = root_dir.resolve()
        self.web_dir = (self.root_dir / "web").resolve()
        self.content_dir = (self.root_dir / "content").resolve()
        self.assets_dir = (self.root_dir / "assets").resolve()
        self.db = db
        self.dev_mode = dev_mode
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
                if p.name.startswith("."):
                    continue
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

    def _send_security_headers(
        self,
        allow_inline_script: bool = False,
        csp_override: str | None = None,
    ) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        csp = (
            csp_override
            if csp_override is not None
            else (CSP_ASSET_PREVIEW if allow_inline_script else CSP_DEFAULT)
        )
        self.send_header("Content-Security-Policy", csp)
        self._sec_headers_sent = True

    def end_headers(self) -> None:
        if not getattr(self, "_sec_headers_sent", False):
            self._send_security_headers()
        self._sec_headers_sent = False
        super().end_headers()

    def _send_json(
        self, status: int, data: dict[str, Any], no_store: bool = True
    ) -> None:
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._sec_headers_sent = False
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self._send_security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _check_same_origin(self) -> bool:
        """Reject cross-site / cross-origin state-mutating requests (CSRF defense)."""
        sec_fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if sec_fetch_site == "cross-site":
            self._send_json(
                HTTPStatus.FORBIDDEN, {"error": "Cross-site request blocked"}
            )
            return False

        origin = self.headers.get("Origin")
        if origin is not None:
            origin_clean = origin.strip()
            if not origin_clean or origin_clean.lower() == "null":
                self._send_json(
                    HTTPStatus.FORBIDDEN, {"error": "Invalid Origin header"}
                )
                return False
            parsed = urlsplit(origin_clean)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                self._send_json(
                    HTTPStatus.FORBIDDEN, {"error": "Invalid Origin header"}
                )
                return False
            origin_host = _normalize_host(parsed.netloc, parsed.scheme)
            fwd_host = (
                (self.headers.get("X-Forwarded-Host") or "")
                .split(",")[0]
                .strip()
            )
            host_hdr = (self.headers.get("Host") or "").strip()
            expected_raw = fwd_host or host_hdr
            expected_host = _normalize_host(expected_raw, parsed.scheme)
            if not expected_host or origin_host != expected_host:
                self._send_json(
                    HTTPStatus.FORBIDDEN, {"error": "Cross-origin request blocked"}
                )
                return False
        return True

    def _read_json_body(
        self,
    ) -> tuple[dict[str, Any] | None, str | None, HTTPStatus]:
        content_type = (
            (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        )
        if content_type != "application/json":
            return (
                None,
                "Content-Type must be application/json",
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
            )
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            return None, "Missing Content-Length header", HTTPStatus.BAD_REQUEST
        try:
            length = int(raw_len)
        except ValueError:
            return None, "Invalid Content-Length header", HTTPStatus.BAD_REQUEST
        if length < 0:
            return None, "Invalid Content-Length header", HTTPStatus.BAD_REQUEST
        if length > MAX_JSON_BODY_BYTES:
            return (
                None,
                f"Request body exceeds limit ({MAX_JSON_BODY_BYTES} bytes)",
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        raw = self.rfile.read(length)
        if not raw:
            return {}, None, HTTPStatus.OK
        try:
            parsed = json.loads(
                raw.decode("utf-8"),
                parse_constant=_reject_json_constant,
                parse_float=_parse_finite_float,
            )
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            return None, f"Invalid JSON body: {exc}", HTTPStatus.BAD_REQUEST
        if not isinstance(parsed, dict):
            return None, "JSON body must be an object", HTTPStatus.BAD_REQUEST
        return parsed, None, HTTPStatus.OK

    def _is_dev_mode(self) -> bool:
        return bool(getattr(self.server, "dev_mode", False)) or is_env_dev_mode()

    def _get_identity(self) -> tuple[str | None, bool, set[str]]:
        email = normalize_email(
            self.headers.get("Cf-Access-Authenticated-User-Email")
        )
        admin_emails = get_admin_emails()
        dev_mode = self._is_dev_mode()
        is_admin = bool(
            (email and email in admin_emails)
            or (dev_mode and not admin_emails and email is None)
        )
        return email, is_admin, admin_emails

    def _require_save_access(self, save_id: str) -> bool:
        """Verify save exists (404) and caller owns it or is admin (403)."""
        exists, owner_email = self.server.db.get_save_owner(save_id)
        if not exists:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Save not found"})
            return False
        email, is_admin, _ = self._get_identity()
        if is_admin:
            return True
        if not email or owner_email != email:
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
            return False
        return True

    def _send_html(self, status: int, html: str) -> None:
        body = html.encode("utf-8")
        self._sec_headers_sent = False
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._send_security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _check_builder_auth(self, html: bool = False) -> bool:
        _, is_admin, _ = self._get_identity()
        if not is_admin:
            if html:
                self._send_html(
                    HTTPStatus.FORBIDDEN,
                    "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
                    "<title>403 — Parent / Admin Access Only</title>"
                    "<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;"
                    "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}"
                    ".card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px 32px;"
                    "max-width:420px;text-align:center}a{color:#38bdf8;text-decoration:none;font-weight:600}</style>"
                    "</head><body><div class='card'><h1>403 — Parent / Admin Access Only</h1>"
                    "<p>The Pyria Builder &amp; Parent Console is restricted to admin accounts.</p>"
                    "<p><a href='/'>← Back to Pyria</a></p></div></body></html>",
                )
            else:
                self._send_json(
                    HTTPStatus.FORBIDDEN, {"error": "Admin access required"}
                )
            return False

        passcode = os.environ.get("PYRIA_BUILDER_PASSCODE", "")
        if not passcode:
            return True
        provided = self.headers.get("X-Builder-Passcode", "")
        if not hmac.compare_digest(provided, passcode):
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
            if not self._check_builder_auth(html=True):
                return
            base_dir = self.server.web_dir
            rel = "builder/index.html"
        elif decoded.startswith("/builder/"):
            if not self._check_builder_auth(html=True):
                return
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

        # Defense-in-depth: gate any resolved path inside web/builder/ (prevents /%2fbuilder/, /./builder/, /BUILDER/ bypasses)
        if base_dir == self.server.web_dir:
            rel_parts = target.relative_to(self.server.web_dir).parts
            if rel_parts and rel_parts[0].lower() == "builder":
                if not self._check_builder_auth(html=True):
                    return

        if not target.exists() or not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "File not found"})
            return

        mime = MIME_TYPES.get(target.suffix.lower())
        if mime is None:
            guessed, _ = mimetypes.guess_type(str(target))
            mime = guessed or "application/octet-stream"

        data = target.read_bytes()
        self._sec_headers_sent = False
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        is_app_code = target.suffix.lower() in {".html", ".css", ".js", ".mjs", ".webmanifest"}
        self.send_header(
            "Cache-Control",
            "no-store, no-cache, must-revalidate, max-age=0" if (no_store or is_app_code) else "no-cache",
        )
        is_asset_preview = (
            decoded.startswith("/assets/") and target.name == "preview.html"
        )
        is_py_sandbox = (
            base_dir == self.server.web_dir
            and target.relative_to(self.server.web_dir).parts == ("py-sandbox.html",)
        )
        csp_override = build_py_sandbox_csp(data) if is_py_sandbox else None
        self._send_security_headers(
            allow_inline_script=is_asset_preview,
            csp_override=csp_override,
        )
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _handle_builder_get(self, path: str, query: str) -> None:
        if not self._check_builder_auth():
            return

        if path == "/api/builder/progress":
            email, _, _ = self._get_identity()
            qs = parse_qs(query)
            owner_param = qs.get("owner", [None])[0]
            snapshot = self.server.db.get_progress_snapshot(
                owner_filter=owner_param, extra_account=email
            )
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
            _, is_admin, _ = self._get_identity()
            payload: dict[str, Any] = {"ok": True}
            if is_admin:
                payload["dbPath"] = str(self.server.db.db_path)
                payload["saveCount"] = self.server.db.count_saves()
            self._send_json(HTTPStatus.OK, payload)
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

        if path == "/api/me":
            email, is_admin, _ = self._get_identity()
            if is_admin:
                accounts = self.server.db.list_accounts(extra_email=email)
            else:
                accounts = [email] if email else []
            self._send_json(
                HTTPStatus.OK,
                {
                    "authenticated": bool(email),
                    "email": email,
                    "isAdmin": is_admin,
                    "accounts": accounts,
                },
            )
            return

        if path == "/api/saves":
            email, is_admin, _ = self._get_identity()
            qs = parse_qs(query)
            owner_param = (qs.get("owner", [""])[0] or "").strip().lower()
            if not is_admin:
                if email:
                    saves = self.server.db.list_saves(owner_filter=email)
                else:
                    saves = []
            else:
                if owner_param == "all" or (not owner_param and email is None):
                    saves = self.server.db.list_saves(owner_filter=None)
                elif owner_param:
                    saves = self.server.db.list_saves(owner_filter=owner_param)
                else:
                    saves = self.server.db.list_saves(owner_filter=email)
            self._send_json(HTTPStatus.OK, {"saves": saves})
            return

        parts = [p for p in path.split("/") if p]
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "saves":
            if not self._require_save_access(parts[2]):
                return
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
            if not self._require_save_access(parts[2]):
                return
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
        if not self._check_same_origin():
            return
        parsed = urlsplit(self.path)
        path = parsed.path

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
            body, err, err_status = self._read_json_body()
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
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

        # POST /api/builder/saves/<saveId>/assign-owner
        if (
            len(parts) == 5
            and parts[0] == "api"
            and parts[1] == "builder"
            and parts[2] == "saves"
            and parts[4] == "assign-owner"
        ):
            if not self._check_builder_auth():
                return
            body, err, err_status = self._read_json_body()
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
                return
            if "ownerEmail" not in body:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "ownerEmail is required"}
                )
                return
            owner_val = body.get("ownerEmail")
            if owner_val is not None and not isinstance(owner_val, str):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "ownerEmail must be a string or null"},
                )
                return
            updated = self.server.db.assign_owner(unquote(parts[3]), owner_val)
            if updated is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(HTTPStatus.OK, {"ok": True, "save": updated})
            return

        if path == "/api/saves":
            email, is_admin, admin_emails = self._get_identity()
            if email is None and (admin_emails or not self._is_dev_mode()):
                self._send_json(
                    HTTPStatus.UNAUTHORIZED,
                    {"error": "Authentication required"},
                )
                return
            body, err, err_status = self._read_json_body()
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
                return
            if (
                "save" in body
                and len(body) == 1
                and isinstance(body["save"], dict)
            ):
                body = body["save"]
            requested_owner = normalize_email(body.get("ownerEmail"))
            owner_email = requested_owner if (is_admin and requested_owner) else email
            save = self.server.db.create_save(body, owner_email=owner_email)
            self._send_json(HTTPStatus.CREATED, {"save": save})
            return

        if (
            len(parts) == 4
            and parts[0] == "api"
            and parts[1] == "saves"
            and parts[3] == "attempts"
        ):
            if not self._require_save_access(parts[2]):
                return
            body, err, err_status = self._read_json_body()
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
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
        body, err, err_status = self._read_json_body()
        if err is not None or body is None:
            self._send_json(err_status, {"error": err})
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
        if not self._check_same_origin():
            return
        parsed = urlsplit(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "api" and parts[1] == "builder":
            self._handle_builder_put(parts)
            return

        if len(parts) == 3 and parts[0] == "api" and parts[1] == "saves":
            if not self._require_save_access(parts[2]):
                return
            body, err, err_status = self._read_json_body()
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
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
        if not self._check_same_origin():
            return
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
            if not self._require_save_access(parts[2]):
                return
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
    host: str,
    port: int,
    root_dir: Path,
    db_path: Path,
    quiet: bool = False,
    dev_mode: bool = False,
) -> PyriaHTTPServer:
    db = PyriaDatabase(db_path)
    srv = PyriaHTTPServer((host, port), root_dir, db, dev_mode=dev_mode)
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
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Enable local unauthenticated dev admin mode when PYRIA_ADMIN_EMAILS is unset",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    root_dir = args.root.resolve()
    db_path = args.db.resolve() if args.db else (root_dir / "data" / "pyria.sqlite3")
    srv = create_server(args.host, args.port, root_dir, db_path, dev_mode=args.dev)
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
