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
import unicodedata
import uuid
from datetime import date, datetime, timedelta, timezone
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
MAX_SAVE_BODY_BYTES = 128 * 1024  # 128 KiB raw request body cap for save endpoints
MAX_SAVE_STATE_BYTES = 128 * 1024  # 128 KiB serialized state_json cap per save
MAX_ATTEMPT_BODY_BYTES = 64 * 1024  # 64 KiB raw request body cap for attempt logging
MAX_ATTEMPT_CODE_BYTES = 32 * 1024  # 32 KiB max code payload per trial attempt

HERO_NAME_MIN_LEN = 2
HERO_NAME_MAX_LEN = 24
MAX_TRIAL_ID_LEN = 128
MAX_SAVE_STRING_LEN = 128
MAX_SAVE_LIST_ITEMS = 1000
MAX_TRIAL_DRAFTS = 512
MAX_APPEARANCE_KEYS = 32
MAX_BYTE_SHARDS = 1_000_000_000
MAX_DIFF_EVENTS_PER_UPDATE = 100
MAX_ERROR_TYPE_LEN = 64
MAX_DURATION_MS = 86_400_000
VALID_DIFFICULTY_MODES: frozenset[str] = frozenset({"explorer", "standard", "challenge"})
VALID_DIFFICULTY_FILTERS: frozenset[str] = frozenset({"all", "explorer", "standard", "challenge"})
VALID_DAYS_FILTERS: frozenset[str] = frozenset({"7", "30", "90", "all"})
ERROR_TYPE_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CSV_FORMULA_PREFIX_RE = re.compile(r"^(?:[=+\-@\t\r]|\s+[=+\-@])")

DEFAULT_MAX_SAVES_PER_ACCOUNT = 10
DEFAULT_MAX_TOTAL_SAVES = 100
DEFAULT_MAX_ATTEMPT_CODE_ROWS = 500
DEFAULT_MAX_ATTEMPTS_PER_SAVE = 5000
DEFAULT_MAX_EVENTS_PER_SAVE = 500

ALLOWED_SAVE_KEYS: frozenset[str] = frozenset(
    {
        "id",
        "heroName",
        "hero_name",
        "ownerEmail",
        "owner_email",
        "createdAt",
        "created_at",
        "updatedAt",
        "updated_at",
        "appearance",
        "eraId",
        "realmId",
        "visualEra",
        "byteShards",
        "stats",
        "solvedTrials",
        "completedTrials",
        "trialDrafts",
        "seenCutscenes",
        "foundEasterEggs",
        "unlockedSpells",
        "rescuedDragons",
        "openedChests",
        "ownedUnlockIds",
        "unlockedItems",
        "unlockedIds",
        "position",
    }
)

_SAVE_STRING_LIST_KEYS: frozenset[str] = frozenset(
    {
        "solvedTrials",
        "completedTrials",
        "seenCutscenes",
        "foundEasterEggs",
        "unlockedSpells",
        "rescuedDragons",
        "openedChests",
        "ownedUnlockIds",
        "unlockedItems",
        "unlockedIds",
    }
)

_SAVE_SCALAR_STRING_KEYS: frozenset[str] = frozenset(
    {
        "eraId",
        "realmId",
        "visualEra",
    }
)

_SERVER_MANAGED_SAVE_KEYS: frozenset[str] = frozenset(
    {
        "id",
        "heroName",
        "hero_name",
        "ownerEmail",
        "owner_email",
        "createdAt",
        "created_at",
        "updatedAt",
        "updated_at",
    }
)

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


class SaveValidationError(Exception):
    """Raised when save or attempt input validation fails."""

    def __init__(
        self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


class SaveQuotaError(Exception):
    """Raised when a per-account or global save quota limit is exceeded."""

    def __init__(
        self, message: str, status: HTTPStatus = HTTPStatus.TOO_MANY_REQUESTS
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _env_positive_int(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        return val if val >= 1 else default
    except ValueError:
        return default


def _has_control_chars(value: str) -> bool:
    for ch in value:
        if ch == "\u200d":  # Allow ZWJ for multi-codepoint emoji sequences
            continue
        code = ord(ch)
        if (
            code < 0x20
            or 0x7F <= code <= 0x9F
            or unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Zl", "Zp")
        ):
            return True
    return False


def _has_surrogates_or_nul(value: str) -> bool:
    return any(ch == "\x00" or 0xD800 <= ord(ch) <= 0xDFFF for ch in value)


def _coerce_byte_shards(raw: Any, fallback: int = 0) -> int:
    if isinstance(raw, bool):
        return max(0, min(fallback, MAX_BYTE_SHARDS))
    try:
        return max(0, min(int(raw), MAX_BYTE_SHARDS))
    except (TypeError, ValueError, OverflowError):
        return max(0, min(fallback, MAX_BYTE_SHARDS))


def _truncate_utf8_bytes(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode("utf-8", errors="ignore")


def validate_hero_name(
    raw: Any, *, allowed_legacy_name: str | None = None
) -> str:
    if not isinstance(raw, str):
        raise SaveValidationError("heroName must be a string")
    if allowed_legacy_name is not None and raw == allowed_legacy_name:
        return raw
    if _has_control_chars(raw):
        raise SaveValidationError("heroName must not contain control characters")
    cleaned = raw.strip()
    if len(cleaned) < HERO_NAME_MIN_LEN or len(cleaned) > HERO_NAME_MAX_LEN:
        raise SaveValidationError(
            f"heroName must be between {HERO_NAME_MIN_LEN} and {HERO_NAME_MAX_LEN} characters"
        )
    return cleaned


def validate_save_payload(
    payload: dict[str, Any],
    *,
    require_hero_name: bool,
    allowed_legacy_hero_name: str | None = None,
    sanitize_drafts: bool = False,
) -> tuple[dict[str, Any], str | None]:
    unknown_keys = sorted(k for k in payload.keys() if k not in ALLOWED_SAVE_KEYS)
    if unknown_keys:
        preview = ", ".join(unknown_keys[:8])
        if len(unknown_keys) > 8:
            preview += f" (+{len(unknown_keys) - 8} more)"
        raise SaveValidationError(f"Disallowed save field(s): {preview}")

    hero_name: str | None = None
    if "heroName" in payload:
        hero_name = validate_hero_name(
            payload["heroName"], allowed_legacy_name=allowed_legacy_hero_name
        )
    elif "hero_name" in payload:
        hero_name = validate_hero_name(
            payload["hero_name"], allowed_legacy_name=allowed_legacy_hero_name
        )
    elif require_hero_name:
        raise SaveValidationError("heroName is required")

    for email_key in ("ownerEmail", "owner_email"):
        if email_key in payload and payload[email_key] is not None:
            val = payload[email_key]
            if not isinstance(val, str) or len(val) > 254 or _has_control_chars(val):
                raise SaveValidationError(f"{email_key} must be a valid string or null")

    sanitized: dict[str, Any] = {}
    for key, val in payload.items():
        if key in _SERVER_MANAGED_SAVE_KEYS:
            continue

        if key in _SAVE_SCALAR_STRING_KEYS:
            if val is not None:
                if (
                    not isinstance(val, str)
                    or len(val) > MAX_SAVE_STRING_LEN
                    or _has_control_chars(val)
                ):
                    raise SaveValidationError(
                        f"{key} must be a string up to {MAX_SAVE_STRING_LEN} characters without control characters"
                    )
            sanitized[key] = val
            continue

        if key in _SAVE_STRING_LIST_KEYS:
            if val is not None:
                if not isinstance(val, list):
                    raise SaveValidationError(f"{key} must be a list of strings")
                if len(val) > MAX_SAVE_LIST_ITEMS:
                    raise SaveValidationError(
                        f"{key} exceeds maximum item count ({MAX_SAVE_LIST_ITEMS})"
                    )
                for item in val:
                    if (
                        not isinstance(item, str)
                        or len(item) > MAX_SAVE_STRING_LEN
                        or _has_control_chars(item)
                    ):
                        raise SaveValidationError(
                            f"{key} items must be strings up to {MAX_SAVE_STRING_LEN} characters without control characters"
                        )
            sanitized[key] = val
            continue

        if key == "appearance":
            if val is not None:
                if not isinstance(val, dict):
                    raise SaveValidationError("appearance must be an object")
                if len(val) > MAX_APPEARANCE_KEYS:
                    raise SaveValidationError(
                        f"appearance exceeds maximum key count ({MAX_APPEARANCE_KEYS})"
                    )
                for ak, av in val.items():
                    if (
                        not isinstance(ak, str)
                        or len(ak) > 64
                        or _has_control_chars(ak)
                    ):
                        raise SaveValidationError("Invalid appearance key")
                    if av is not None and not isinstance(av, (str, bool, int, float)):
                        raise SaveValidationError(
                            f"appearance.{ak} must be a scalar value or null"
                        )
                    if isinstance(av, float) and not math.isfinite(av):
                        raise SaveValidationError(
                            f"appearance.{ak} must be a finite number"
                        )
                    if isinstance(av, str) and (
                        len(av) > MAX_SAVE_STRING_LEN or _has_control_chars(av)
                    ):
                        raise SaveValidationError(
                            f"appearance.{ak} must be a string up to {MAX_SAVE_STRING_LEN} characters without control characters"
                        )
            sanitized[key] = val
            continue

        if key == "stats":
            if val is not None:
                if not isinstance(val, dict):
                    raise SaveValidationError("stats must be an object")
                if len(val) > 32:
                    raise SaveValidationError("stats exceeds maximum key count (32)")
                for sk, sv in val.items():
                    if (
                        not isinstance(sk, str)
                        or len(sk) > 64
                        or _has_control_chars(sk)
                    ):
                        raise SaveValidationError("Invalid stats key")
                    if sv is not None and (
                        isinstance(sv, bool)
                        or not isinstance(sv, (int, float))
                        or not math.isfinite(sv)
                    ):
                        raise SaveValidationError(
                            f"stats.{sk} must be a finite number or null"
                        )
            sanitized[key] = val
            continue

        if key == "position":
            if val is not None:
                if not isinstance(val, dict):
                    raise SaveValidationError("position must be an object or null")
                if len(val) > 16:
                    raise SaveValidationError(
                        "position exceeds maximum key count (16)"
                    )
                for pk, pv in val.items():
                    if (
                        not isinstance(pk, str)
                        or len(pk) > 64
                        or _has_control_chars(pk)
                    ):
                        raise SaveValidationError("Invalid position key")
                    if pv is not None:
                        if isinstance(pv, bool):
                            raise SaveValidationError(
                                f"position.{pk} must be a string, number, or null"
                            )
                        if isinstance(pv, str):
                            if (
                                len(pv) > MAX_SAVE_STRING_LEN
                                or _has_control_chars(pv)
                            ):
                                raise SaveValidationError(
                                    f"position.{pk} must be a valid string"
                                )
                        elif not isinstance(pv, (int, float)) or not math.isfinite(pv):
                            raise SaveValidationError(
                                f"position.{pk} must be a finite number"
                            )
            sanitized[key] = val
            continue

        if key == "trialDrafts":
            if val is not None:
                if not isinstance(val, dict):
                    if sanitize_drafts:
                        sanitized[key] = {}
                        continue
                    raise SaveValidationError("trialDrafts must be an object")
                if not sanitize_drafts and len(val) > MAX_TRIAL_DRAFTS:
                    raise SaveValidationError(
                        f"trialDrafts exceeds maximum entry count ({MAX_TRIAL_DRAFTS})"
                    )
                cleaned_drafts: dict[str, str] = {}
                for dk, dv in val.items():
                    if (
                        not isinstance(dk, str)
                        or not dk.strip()
                        or len(dk) > MAX_TRIAL_ID_LEN
                        or _has_control_chars(dk)
                    ):
                        if sanitize_drafts:
                            continue
                        raise SaveValidationError("Invalid trialDrafts key")
                    if not isinstance(dv, str):
                        if sanitize_drafts:
                            continue
                        raise SaveValidationError(
                            f"trialDrafts.{dk} must be a string"
                        )
                    if _has_surrogates_or_nul(dv):
                        raise SaveValidationError(
                            f"trialDrafts.{dk} must not contain NUL bytes or lone Unicode surrogates"
                        )
                    if len(dv.encode("utf-8")) > MAX_ATTEMPT_CODE_BYTES:
                        if sanitize_drafts:
                            dv = _truncate_utf8_bytes(dv, MAX_ATTEMPT_CODE_BYTES)
                        else:
                            raise SaveValidationError(
                                f"trialDrafts.{dk} exceeds maximum length ({MAX_ATTEMPT_CODE_BYTES} bytes)",
                                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                            )
                    cleaned_drafts[dk] = dv
                if sanitize_drafts and len(cleaned_drafts) > MAX_TRIAL_DRAFTS:
                    # Keep the most recently inserted entries up to MAX_TRIAL_DRAFTS
                    kept_keys = list(cleaned_drafts.keys())[-MAX_TRIAL_DRAFTS:]
                    cleaned_drafts = {k: cleaned_drafts[k] for k in kept_keys}
                sanitized[key] = cleaned_drafts
            else:
                sanitized[key] = val
            continue

        # byteShards is coerced safely in create_save/update_save
        sanitized[key] = val

    return sanitized, hero_name


def _round1(val: float) -> float:
    return round(val, 1)


def compute_percentile(sorted_values: list[float | int], percentile: float) -> float | None:
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return _round1(float(sorted_values[0]))
    idx = percentile * (len(sorted_values) - 1)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    interpolated = sorted_values[lo] + (idx - lo) * (sorted_values[hi] - sorted_values[lo])
    return _round1(float(interpolated))


def is_valid_iso_date(value: str) -> bool:
    if not ISO_DATE_RE.match(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def sanitize_csv_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    if CSV_FORMULA_PREFIX_RE.match(text):
        text = f"'{text}"
    if any(ch in text for ch in (",", '"', "\n", "\r")):
        return '"' + text.replace('"', '""') + '"'
    return text


def format_trial_metrics_csv(trials: list[dict[str, Any]]) -> str:
    headers = [
        "trialId",
        "title",
        "eraId",
        "realmId",
        "trialType",
        "concepts",
        "uniqueHeroes",
        "uniqueSolvers",
        "attempts",
        "passes",
        "completionRate",
        "firstTryPassRate",
        "medianAttemptsToSolve",
        "p75AttemptsToSolve",
        "hintUsageRate",
        "tier3HintRate",
        "parentOverrides",
        "parentOverrideRate",
        "topError",
        "flag",
        "flagReasons",
    ]
    lines = [",".join(headers)]
    for t in trials:
        top_errors = t.get("topErrors") or []
        top_err = f"{top_errors[0]['errorType']} ({top_errors[0]['count']})" if top_errors else ""
        row = [
            t.get("trialId", ""),
            t.get("title", ""),
            t.get("eraId", ""),
            t.get("realmId", ""),
            t.get("trialType", ""),
            "; ".join(t.get("concepts") or []),
            t.get("uniqueHeroes", 0),
            t.get("uniqueSolvers", 0),
            t.get("attempts", 0),
            t.get("passes", 0),
            "" if t.get("completionRate") is None else t["completionRate"],
            "" if t.get("firstTryPassRate") is None else t["firstTryPassRate"],
            "" if t.get("medianAttemptsToSolve") is None else t["medianAttemptsToSolve"],
            "" if t.get("p75AttemptsToSolve") is None else t["p75AttemptsToSolve"],
            "" if t.get("hintUsageRate") is None else t["hintUsageRate"],
            "" if t.get("tier3HintRate") is None else t["tier3HintRate"],
            t.get("parentOverrides", 0),
            "" if t.get("parentOverrideRate") is None else t["parentOverrideRate"],
            top_err,
            t.get("flag", ""),
            "; ".join(t.get("flagReasons") or []),
        ]
        lines.append(",".join(sanitize_csv_cell(v) for v in row))
    return "\r\n".join(lines) + "\r\n"


def parse_trial_metrics_filters(qs: dict[str, list[str]]) -> dict[str, Any]:
    def opt_str(name: str, max_len: int) -> str | None:
        raw = (qs.get(name, [""])[0] or "").strip()
        if not raw:
            return None
        if len(raw) > max_len or _has_control_chars(raw):
            raise SaveValidationError(f"Invalid {name} filter")
        return raw

    era_id = opt_str("eraId", 128)
    realm_id = opt_str("realmId", 128)
    trial_type = opt_str("trialType", 64)

    difficulty = (qs.get("difficulty", ["all"])[0] or "all").strip().lower() or "all"
    if difficulty not in VALID_DIFFICULTY_FILTERS:
        raise SaveValidationError("difficulty must be 'all', 'explorer', 'standard', or 'challenge'")

    days = (qs.get("days", ["30"])[0] or "30").strip().lower() or "30"
    if days not in VALID_DAYS_FILTERS:
        raise SaveValidationError("days must be '7', '30', '90', or 'all'")

    raw_since = (qs.get("since", [""])[0] or "").strip()
    since: str | None = None
    if raw_since:
        if not is_valid_iso_date(raw_since):
            raise SaveValidationError("since must be a valid YYYY-MM-DD date")
        since = raw_since

    raw_min_heroes = (qs.get("minHeroes", [""])[0] or "").strip()
    min_heroes = 5
    if raw_min_heroes:
        if not raw_min_heroes.isdigit():
            raise SaveValidationError("minHeroes must be an integer >= 1")
        min_heroes = int(raw_min_heroes)
        if min_heroes < 1 or min_heroes > 10000:
            raise SaveValidationError("minHeroes must be between 1 and 10000")

    raw_practice = (qs.get("includePractice", ["0"])[0] or "0").strip().lower()
    if raw_practice in ("1", "true"):
        include_practice = True
    elif raw_practice in ("0", "false", ""):
        include_practice = False
    else:
        raise SaveValidationError("includePractice must be '0' or '1'")

    fmt = (qs.get("format", ["json"])[0] or "json").strip().lower() or "json"
    if fmt not in ("json", "csv"):
        raise SaveValidationError("format must be 'json' or 'csv'")

    return {
        "eraId": era_id,
        "realmId": realm_id,
        "trialType": trial_type,
        "difficulty": difficulty,
        "days": days,
        "since": since,
        "minHeroes": min_heroes,
        "includePractice": include_practice,
        "format": fmt,
    }


def compute_min_day(filters: dict[str, Any], now_utc: datetime | None = None) -> str | None:
    if filters.get("since"):
        return str(filters["since"])
    days = str(filters.get("days") or "30")
    if days == "all":
        return None
    now_dt = now_utc or datetime.now(timezone.utc)
    cutoff = now_dt.date() - timedelta(days=int(days) - 1)
    return cutoff.isoformat()


def _evaluate_calibration_flag(
    *,
    trial_type: str,
    unique_heroes: int,
    min_heroes: int,
    attempts: int,
    passes: int,
    completion_rate: float | None,
    first_try_pass_rate: float | None,
    median_attempts: float | None,
    hint_usage_rate: float | None,
    tier3_hint_rate: float | None,
    parent_override_rate: float | None,
    assertion_error_count: int,
) -> tuple[str, list[str]]:
    if unique_heroes < min_heroes:
        if unique_heroes == 0:
            return "low_data", ["No attempts recorded"]
        return "low_data", [f"Only {unique_heroes} hero(es) attempted (minimum {min_heroes})"]

    bug_reasons: list[str] = []
    hard_reasons: list[str] = []
    easy_reasons: list[str] = []

    failed_attempts = max(0, attempts - passes)
    if (
        failed_attempts >= 3
        and (assertion_error_count / failed_attempts) >= 0.6
        and ((tier3_hint_rate or 0.0) >= 20.0 or (completion_rate if completion_rate is not None else 100.0) < 60.0)
    ):
        pct = _round1((assertion_error_count / failed_attempts) * 100.0)
        bug_reasons.append(f"High AssertionError share of failures ({pct}%) despite hints/low completion")

    if completion_rate is not None and completion_rate < 60.0:
        hard_reasons.append(f"Low completion rate ({completion_rate}%)")
    if median_attempts is not None and median_attempts >= 5.0:
        hard_reasons.append(f"High median attempts to solve ({median_attempts})")
    if tier3_hint_rate is not None and tier3_hint_rate >= 35.0:
        hard_reasons.append(f"High Tier-3 walkthrough hint rate ({tier3_hint_rate}%)")
    if parent_override_rate is not None and parent_override_rate >= 15.0:
        hard_reasons.append(f"Elevated parent override rate ({parent_override_rate}%)")

    easy_threshold = 95.0 if trial_type == "multiple_choice" else 90.0
    if (
        first_try_pass_rate is not None
        and first_try_pass_rate >= easy_threshold
        and (hint_usage_rate or 0.0) <= 5.0
        and (median_attempts is None or median_attempts <= 1.0)
    ):
        easy_reasons.append(
            f"Very high first-try pass rate ({first_try_pass_rate}%) with minimal hints ({hint_usage_rate or 0.0}%)"
        )

    if bug_reasons:
        return "possible_bug", bug_reasons + hard_reasons
    if hard_reasons:
        return "too_hard", hard_reasons
    if easy_reasons:
        return "too_easy", easy_reasons
    return "ok", []


def extract_trial_catalog(eras: list[dict[str, Any]]) -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    for era in eras:
        era_id = str(era.get("id") or "")
        era_name = str(era.get("name") or era_id)
        for realm in era.get("realms") or []:
            realm_id = str(realm.get("id") or "")
            realm_name = str(realm.get("name") or realm_id)
            for trial in realm.get("trials") or []:
                tid = trial.get("id")
                if not tid:
                    continue
                concepts = trial.get("concepts")
                catalog.append(
                    {
                        "trialId": str(tid),
                        "title": str(trial.get("title") or tid),
                        "eraId": era_id,
                        "eraName": era_name,
                        "realmId": realm_id,
                        "realmName": realm_name,
                        "trialType": str(trial.get("trialType") or "code"),
                        "concepts": [str(c) for c in concepts] if isinstance(concepts, list) else [],
                    }
                )
    return catalog


def compute_trial_metrics_from_conn(
    conn: sqlite3.Connection,
    catalog: list[dict[str, Any]],
    filters: dict[str, Any],
    *,
    now_utc: datetime | None = None,
    max_day: str | None = None,
) -> dict[str, Any]:
    min_day = compute_min_day(filters, now_utc=now_utc)
    difficulty = str(filters.get("difficulty") or "all")
    include_practice = bool(filters.get("includePractice", False))
    min_heroes = int(filters.get("minHeroes") or 5)

    # Check whether trial_stats_daily & enriched columns exist (graceful for older DBs)
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    attempt_cols = {
        r["name"] for r in conn.execute("PRAGMA table_info(trial_attempts)").fetchall()
    }
    has_diff_col = "difficulty_mode" in attempt_cols
    has_practice_col = "is_practice" in attempt_cols
    has_error_col = "error_type" in attempt_cols

    rollup_by_trial: dict[str, dict[str, dict[str, int]]] = {}
    if "trial_stats_daily" in tables:
        r_where: list[str] = []
        r_params: list[Any] = []
        if min_day:
            r_where.append("day >= ?")
            r_params.append(min_day)
        if max_day:
            r_where.append("day < ?")
            r_params.append(max_day)
        if difficulty != "all":
            r_where.append("difficulty_mode = ?")
            r_params.append(difficulty)
        r_sql = (
            "SELECT day, trial_id, "
            "SUM(attempts) AS attempts, SUM(passes) AS passes, "
            "SUM(first_try_passes) AS first_try_passes, "
            "SUM(unique_solvers) AS unique_solvers, "
            "SUM(total_hints) AS total_hints, SUM(tier3_hints) AS tier3_hints, "
            "SUM(parent_overrides) AS parent_overrides "
            "FROM trial_stats_daily "
            + (f"WHERE {' AND '.join(r_where)} " if r_where else "")
            + "GROUP BY day, trial_id ORDER BY day ASC"
        )
        for row in conn.execute(r_sql, r_params).fetchall():
            tid = str(row["trial_id"])
            day = str(row["day"])
            rollup_by_trial.setdefault(tid, {})[day] = {
                "attempts": int(row["attempts"] or 0),
                "passes": int(row["passes"] or 0),
                "first_try_passes": int(row["first_try_passes"] or 0),
                "unique_solvers": int(row["unique_solvers"] or 0),
                "total_hints": int(row["total_hints"] or 0),
                "tier3_hints": int(row["tier3_hints"] or 0),
                "parent_overrides": int(row["parent_overrides"] or 0),
            }

    raw_by_trial: dict[str, list[sqlite3.Row]] = {}
    if "trial_attempts" in tables:
        a_where: list[str] = []
        a_params: list[Any] = []
        if min_day:
            a_where.append("created_at >= ?")
            a_params.append(min_day)
        if max_day:
            a_where.append("SUBSTR(created_at, 1, 10) < ?")
            a_params.append(max_day)
        if difficulty != "all":
            if has_diff_col:
                a_where.append("COALESCE(difficulty_mode, 'standard') = ?")
                a_params.append(difficulty)
            elif difficulty != "standard":
                a_where.append("1 = 0")
        if not include_practice and has_practice_col:
            a_where.append("COALESCE(is_practice, 0) = 0")

        practice_expr = "COALESCE(is_practice, 0)" if has_practice_col else "0"
        error_expr = "error_type" if has_error_col else "NULL"
        a_sql = (
            f"SELECT save_id, trial_id, passed, hints_used, "
            f"{practice_expr} AS is_practice, {error_expr} AS error_type, "
            "SUBSTR(created_at, 1, 10) AS day "
            "FROM trial_attempts "
            + (f"WHERE {' AND '.join(a_where)} " if a_where else "")
            + "ORDER BY trial_id ASC, save_id ASC, created_at ASC, id ASC"
        )
        for row in conn.execute(a_sql, a_params).fetchall():
            raw_by_trial.setdefault(str(row["trial_id"]), []).append(row)

    meta_by_id: dict[str, dict[str, Any]] = {}
    ordered_meta: list[dict[str, Any]] = []
    for meta in catalog:
        meta_by_id[meta["trialId"]] = meta
        ordered_meta.append(meta)
    for tid in sorted(set(rollup_by_trial.keys()) | set(raw_by_trial.keys())):
        if tid not in meta_by_id:
            fallback = {
                "trialId": tid,
                "title": tid,
                "eraId": "unknown",
                "eraName": "Unknown Era",
                "realmId": "unknown",
                "realmName": "Unknown Realm",
                "trialType": "code",
                "concepts": [],
            }
            meta_by_id[tid] = fallback
            ordered_meta.append(fallback)

    era_filter = filters.get("eraId")
    realm_filter = filters.get("realmId")
    type_filter = filters.get("trialType")
    filtered_meta = [
        m
        for m in ordered_meta
        if (not era_filter or m["eraId"] == era_filter)
        and (not realm_filter or m["realmId"] == realm_filter)
        and (not type_filter or m["trialType"] == type_filter)
    ]

    trial_rows: list[dict[str, Any]] = []
    all_medians: list[float] = []
    trials_with_data = 0
    flagged_too_hard = 0
    flagged_too_easy = 0
    flagged_possible_bug = 0
    flagged_low_data = 0
    total_overrides = 0

    for meta in filtered_meta:
        tid = meta["trialId"]
        raw_rows = raw_by_trial.get(tid) or []
        rollup_days = rollup_by_trial.get(tid) or {}

        raw_np_by_day: dict[str, dict[str, int]] = {}
        raw_pr_by_day: dict[str, dict[str, int]] = {}

        hero_saves: set[str] = set()
        hero_solved: set[str] = set()
        hero_first_passed: set[str] = set()
        hero_attempts_before_solve: dict[str, int] = {}
        hero_solved_counts: dict[str, int] = {}

        hint_breakdown = {"tier0": 0, "tier1": 0, "tier2": 0, "tier3": 0}
        error_counts: dict[str, int] = {}
        raw_attempts_with_hints = 0
        raw_np_count = 0
        raw_np_total_hints = 0
        raw_np_tier3 = 0

        for r in raw_rows:
            save_id = str(r["save_id"])
            passed = bool(r["passed"])
            hints = int(r["hints_used"] or 0)
            is_practice = bool(r["is_practice"])
            day = str(r["day"])
            err_type = r["error_type"]

            if hints <= 0:
                hint_breakdown["tier0"] += 1
            elif hints == 1:
                hint_breakdown["tier1"] += 1
            elif hints == 2:
                hint_breakdown["tier2"] += 1
            else:
                hint_breakdown["tier3"] += 1

            if hints > 0:
                raw_attempts_with_hints += 1

            if not passed and err_type:
                err_str = str(err_type)
                error_counts[err_str] = error_counts.get(err_str, 0) + 1

            target_map = raw_pr_by_day if is_practice else raw_np_by_day
            bucket = target_map.setdefault(
                day, {"attempts": 0, "passes": 0, "total_hints": 0, "tier3_hints": 0}
            )
            bucket["attempts"] += 1
            if passed:
                bucket["passes"] += 1
            bucket["total_hints"] += hints
            if hints >= 3:
                bucket["tier3_hints"] += 1

            if not is_practice:
                raw_np_count += 1
                raw_np_total_hints += hints
                if hints >= 3:
                    raw_np_tier3 += 1

            is_first = save_id not in hero_saves
            hero_saves.add(save_id)
            if is_first and passed:
                hero_first_passed.add(save_id)
            if save_id not in hero_solved:
                next_cnt = hero_attempts_before_solve.get(save_id, 0) + 1
                hero_attempts_before_solve[save_id] = next_cnt
                if passed:
                    hero_solved.add(save_id)
                    hero_solved_counts[save_id] = next_cnt

        all_days = sorted(
            set(rollup_days.keys()) | set(raw_np_by_day.keys()) | set(raw_pr_by_day.keys())
        )
        merged_np_attempts = 0
        merged_np_passes = 0
        merged_np_total_hints = 0
        merged_np_tier3 = 0
        rollup_first_try_total = 0
        rollup_unique_solvers_total = 0
        parent_overrides = 0

        practice_attempts = 0
        practice_passes = 0
        practice_tier3 = 0
        daily_trend: list[dict[str, Any]] = []

        for day in all_days:
            r_day = rollup_days.get(day)
            np_day = raw_np_by_day.get(day)
            pr_day = raw_pr_by_day.get(day)

            day_np_attempts = max(
                np_day["attempts"] if np_day else 0,
                r_day["attempts"] if r_day else 0,
            )
            day_np_passes = max(
                np_day["passes"] if np_day else 0,
                r_day["passes"] if r_day else 0,
            )
            day_np_total_hints = max(
                np_day["total_hints"] if np_day else 0,
                r_day["total_hints"] if r_day else 0,
            )
            day_np_tier3 = max(
                np_day["tier3_hints"] if np_day else 0,
                r_day["tier3_hints"] if r_day else 0,
            )

            merged_np_attempts += day_np_attempts
            merged_np_passes += day_np_passes
            merged_np_total_hints += day_np_total_hints
            merged_np_tier3 += day_np_tier3

            if r_day:
                rollup_first_try_total += r_day["first_try_passes"]
                rollup_unique_solvers_total += r_day["unique_solvers"]
                parent_overrides += r_day["parent_overrides"]

            day_pr_attempts = pr_day["attempts"] if pr_day else 0
            day_pr_passes = pr_day["passes"] if pr_day else 0
            practice_attempts += day_pr_attempts
            practice_passes += day_pr_passes
            practice_tier3 += pr_day["tier3_hints"] if pr_day else 0

            day_tot_attempts = day_np_attempts + day_pr_attempts
            day_tot_passes = day_np_passes + day_pr_passes
            if day_tot_attempts > 0 or day_tot_passes > 0:
                daily_trend.append(
                    {"day": day, "attempts": day_tot_attempts, "passes": day_tot_passes}
                )

        attempts = merged_np_attempts + practice_attempts
        passes = merged_np_passes + practice_passes
        tier3_hints = merged_np_tier3 + practice_tier3

        pruned_np_attempts = max(0, merged_np_attempts - raw_np_count)
        pruned_np_tier3 = max(0, merged_np_tier3 - raw_np_tier3)
        pruned_np_hints = max(0, merged_np_total_hints - raw_np_total_hints)
        if pruned_np_tier3 > 0:
            hint_breakdown["tier3"] += pruned_np_tier3

        unique_solvers = max(len(hero_solved), rollup_unique_solvers_total)
        first_try_passes = min(
            unique_solvers, max(len(hero_first_passed), rollup_first_try_total)
        )
        unique_heroes = max(len(hero_saves), unique_solvers)
        if unique_heroes == 0 and attempts > 0:
            unique_heroes = 1

        completion_rate = (
            _round1(min(100.0, (unique_solvers / unique_heroes) * 100.0))
            if unique_heroes > 0
            else None
        )
        first_try_pass_rate = (
            _round1(min(100.0, (first_try_passes / unique_heroes) * 100.0))
            if unique_heroes > 0
            else None
        )

        solved_sorted = sorted(hero_solved_counts.values())
        median_attempts = compute_percentile(solved_sorted, 0.5)
        p75_attempts = compute_percentile(solved_sorted, 0.75)

        est_pruned_hinted = min(pruned_np_attempts, pruned_np_hints)
        attempts_with_hints = min(attempts, raw_attempts_with_hints + est_pruned_hinted)
        hint_usage_rate = (
            _round1((attempts_with_hints / attempts) * 100.0) if attempts > 0 else None
        )
        tier3_hint_rate = (
            _round1((tier3_hints / attempts) * 100.0) if attempts > 0 else None
        )

        if unique_heroes > 0:
            parent_override_rate = _round1((parent_overrides / unique_heroes) * 100.0)
        elif parent_overrides > 0:
            parent_override_rate = 100.0
        else:
            parent_override_rate = None

        top_errors = [
            {"errorType": k, "count": v}
            for k, v in sorted(error_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        ]

        flag, flag_reasons = _evaluate_calibration_flag(
            trial_type=meta["trialType"],
            unique_heroes=unique_heroes,
            min_heroes=min_heroes,
            attempts=attempts,
            passes=passes,
            completion_rate=completion_rate,
            first_try_pass_rate=first_try_pass_rate,
            median_attempts=median_attempts,
            hint_usage_rate=hint_usage_rate,
            tier3_hint_rate=tier3_hint_rate,
            parent_override_rate=parent_override_rate,
            assertion_error_count=error_counts.get("AssertionError", 0),
        )

        if attempts > 0 or parent_overrides > 0:
            trials_with_data += 1
        if median_attempts is not None:
            all_medians.append(median_attempts)
        total_overrides += parent_overrides
        if flag == "too_hard":
            flagged_too_hard += 1
        elif flag == "too_easy":
            flagged_too_easy += 1
        elif flag == "possible_bug":
            flagged_possible_bug += 1
        elif flag == "low_data":
            flagged_low_data += 1

        trial_rows.append(
            {
                "trialId": meta["trialId"],
                "title": meta["title"],
                "eraId": meta["eraId"],
                "eraName": meta["eraName"],
                "realmId": meta["realmId"],
                "realmName": meta["realmName"],
                "trialType": meta["trialType"],
                "concepts": meta["concepts"],
                "uniqueHeroes": unique_heroes,
                "uniqueSolvers": unique_solvers,
                "attempts": attempts,
                "passes": passes,
                "completionRate": completion_rate,
                "firstTryPassRate": first_try_pass_rate,
                "medianAttemptsToSolve": median_attempts,
                "p75AttemptsToSolve": p75_attempts,
                "hintUsageRate": hint_usage_rate,
                "tier3HintRate": tier3_hint_rate,
                "hintTierBreakdown": hint_breakdown,
                "parentOverrides": parent_overrides,
                "parentOverrideRate": parent_override_rate,
                "topErrors": top_errors,
                "dailyTrend": daily_trend,
                "flag": flag,
                "flagReasons": flag_reasons,
            }
        )

    all_medians.sort()
    overall_median = compute_percentile(all_medians, 0.5)

    return {
        "filters": filters,
        "summary": {
            "totalTrials": len(trial_rows),
            "trialsWithData": trials_with_data,
            "flaggedTooHard": flagged_too_hard,
            "flaggedTooEasy": flagged_too_easy,
            "flaggedPossibleBug": flagged_possible_bug,
            "flaggedLowData": flagged_low_data,
            "overallMedianAttempts": overall_median,
            "totalOverrides": total_overrides,
        },
        "trials": trial_rows,
    }


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

    def __init__(
        self,
        db_path: Path,
        *,
        max_saves_per_account: int | None = None,
        max_total_saves: int | None = None,
        max_attempt_code_rows: int | None = None,
        max_attempts_per_save: int | None = None,
        max_events_per_save: int | None = None,
    ) -> None:
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.max_saves_per_account = max(
            1,
            max_saves_per_account
            if max_saves_per_account is not None
            else _env_positive_int(
                "PYRIA_MAX_SAVES_PER_ACCOUNT", DEFAULT_MAX_SAVES_PER_ACCOUNT
            ),
        )
        self.max_total_saves = max(
            1,
            max_total_saves
            if max_total_saves is not None
            else _env_positive_int("PYRIA_MAX_TOTAL_SAVES", DEFAULT_MAX_TOTAL_SAVES),
        )
        self.max_attempt_code_rows = max(
            1,
            max_attempt_code_rows
            if max_attempt_code_rows is not None
            else _env_positive_int(
                "PYRIA_MAX_ATTEMPT_CODE_ROWS", DEFAULT_MAX_ATTEMPT_CODE_ROWS
            ),
        )
        self.max_attempts_per_save = max(
            1,
            max_attempts_per_save
            if max_attempts_per_save is not None
            else _env_positive_int(
                "PYRIA_MAX_ATTEMPTS_PER_SAVE", DEFAULT_MAX_ATTEMPTS_PER_SAVE
            ),
        )
        self.max_events_per_save = max(
            1,
            max_events_per_save
            if max_events_per_save is not None
            else _env_positive_int(
                "PYRIA_MAX_EVENTS_PER_SAVE", DEFAULT_MAX_EVENTS_PER_SAVE
            ),
        )
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
                    difficulty_mode TEXT,
                    is_practice INTEGER NOT NULL DEFAULT 0,
                    error_type TEXT,
                    duration_ms INTEGER,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (save_id) REFERENCES saves(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS trial_stats_daily (
                    day TEXT NOT NULL,
                    trial_id TEXT NOT NULL,
                    difficulty_mode TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    passes INTEGER NOT NULL DEFAULT 0,
                    first_try_passes INTEGER NOT NULL DEFAULT 0,
                    unique_solvers INTEGER NOT NULL DEFAULT 0,
                    total_hints INTEGER NOT NULL DEFAULT 0,
                    tier3_hints INTEGER NOT NULL DEFAULT 0,
                    parent_overrides INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (day, trial_id, difficulty_mode)
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
                CREATE INDEX IF NOT EXISTS idx_attempts_trial_id
                    ON trial_attempts(trial_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_trial_stats_daily_trial
                    ON trial_stats_daily(trial_id, day DESC);
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
            attempt_cols = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(trial_attempts)").fetchall()
            }
            if "difficulty_mode" not in attempt_cols:
                conn.execute("ALTER TABLE trial_attempts ADD COLUMN difficulty_mode TEXT")
            if "is_practice" not in attempt_cols:
                conn.execute(
                    "ALTER TABLE trial_attempts ADD COLUMN is_practice INTEGER NOT NULL DEFAULT 0"
                )
            if "error_type" not in attempt_cols:
                conn.execute("ALTER TABLE trial_attempts ADD COLUMN error_type TEXT")
            if "duration_ms" not in attempt_cols:
                conn.execute("ALTER TABLE trial_attempts ADD COLUMN duration_ms INTEGER")

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

    def _prune_events(self, conn: sqlite3.Connection, save_id: str) -> None:
        conn.execute(
            "DELETE FROM activity_events "
            "WHERE save_id = ? AND id NOT IN ("
            "SELECT id FROM activity_events WHERE save_id = ? ORDER BY id DESC LIMIT ?"
            ")",
            (save_id, save_id, self.max_events_per_save),
        )

    def _insert_event(
        self,
        conn: sqlite3.Connection,
        save_id: str,
        hero_name: str,
        event_type: str,
        summary: str,
        details: dict[str, Any],
        realm_id: str | None = None,
        trial_id: str | None = None,
        created_at: str | None = None,
        prune: bool = True,
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
        event_id = int(cur.lastrowid)
        if prune:
            self._prune_events(conn, save_id)
        return event_id

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
        sanitized, validated_name = validate_save_payload(
            payload, require_hero_name=True
        )
        assert validated_name is not None
        save_id = str(uuid.uuid4())
        hero_name = validated_name
        norm_owner = normalize_email(owner_email)
        now = utc_now_iso()
        state = {
            **sanitized,
            "id": save_id,
            "heroName": hero_name,
            "ownerEmail": norm_owner,
            "createdAt": now,
            "updatedAt": now,
        }
        if "byteShards" in state:
            state["byteShards"] = _coerce_byte_shards(state["byteShards"], 0)
        state_json = json.dumps(state, ensure_ascii=False, allow_nan=False)
        if len(state_json.encode("utf-8")) > MAX_SAVE_STATE_BYTES:
            raise SaveValidationError(
                f"Save state exceeds maximum size ({MAX_SAVE_STATE_BYTES} bytes)",
                status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        realm_id = str(state.get("realmId") or "realm-01-meadow")
        with self._lock, self._connect() as conn:
            if norm_owner is not None:
                acct_row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM saves "
                    "WHERE LOWER(COALESCE(owner_email, '')) = ?",
                    (norm_owner,),
                ).fetchone()
            else:
                acct_row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM saves "
                    "WHERE owner_email IS NULL OR TRIM(owner_email) = ''"
                ).fetchone()
            acct_count = int(acct_row["cnt"]) if acct_row else 0
            if acct_count >= self.max_saves_per_account:
                raise SaveQuotaError(
                    f"Save limit reached ({self.max_saves_per_account} saves per account)"
                )
            total_row = conn.execute("SELECT COUNT(*) AS cnt FROM saves").fetchone()
            total_count = int(total_row["cnt"]) if total_row else 0
            if total_count >= self.max_total_saves:
                raise SaveQuotaError(
                    f"Server save limit reached ({self.max_total_saves} total saves)"
                )

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

            existing_hero_name = str(existing["hero_name"])
            sanitized, validated_name = validate_save_payload(
                payload,
                require_hero_name=False,
                allowed_legacy_hero_name=existing_hero_name,
                sanitize_drafts=True,
            )

            try:
                prev_state = json.loads(existing["state_json"])
                if not isinstance(prev_state, dict):
                    prev_state = {}
            except json.JSONDecodeError:
                prev_state = {}

            hero_name = (
                validated_name
                if validated_name is not None
                else existing_hero_name
            )
            now = utc_now_iso()
            state = {
                **sanitized,
                "id": save_id,
                "heroName": hero_name,
                "ownerEmail": existing["owner_email"],
                "createdAt": existing["created_at"],
                "updatedAt": now,
            }
            if "byteShards" in state:
                prev_shards = _coerce_byte_shards(prev_state.get("byteShards"), 0)
                state["byteShards"] = _coerce_byte_shards(
                    state["byteShards"], prev_shards
                )
            state_json = json.dumps(state, ensure_ascii=False, allow_nan=False)
            if len(state_json.encode("utf-8")) > MAX_SAVE_STATE_BYTES:
                raise SaveValidationError(
                    f"Save state exceeds maximum size ({MAX_SAVE_STATE_BYTES} bytes)",
                    status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                )
            conn.execute(
                "UPDATE saves SET hero_name = ?, state_json = ?, updated_at = ? "
                "WHERE id = ?",
                (hero_name, state_json, now, save_id),
            )

            # Diff previous vs new state to emit live activity events (bounded per PUT, pruned once)
            cur_realm = str(state.get("realmId") or prev_state.get("realmId") or "") or None
            prev_realm = str(prev_state.get("realmId") or "") or None
            max_diff_events = min(MAX_DIFF_EVENTS_PER_UPDATE, self.max_events_per_save)
            emitted_events = 0

            def emit_diff_event(
                event_type: str, summary: str, details: dict[str, Any]
            ) -> None:
                nonlocal emitted_events
                if emitted_events >= max_diff_events:
                    return
                self._insert_event(
                    conn,
                    save_id=save_id,
                    hero_name=hero_name,
                    event_type=event_type,
                    realm_id=cur_realm,
                    summary=summary,
                    details=details,
                    created_at=now,
                    prune=False,
                )
                emitted_events += 1

            prev_chests = _extract_string_set(prev_state, "openedChests")
            new_chests = _extract_string_set(state, "openedChests")
            for chest_id in sorted(new_chests - prev_chests):
                emit_diff_event(
                    "chest_opened",
                    f"Opened treasure chest {chest_id}",
                    {"chestId": chest_id, "byteShards": state.get("byteShards")},
                )

            prev_unlocks = _extract_string_set(
                prev_state, "ownedUnlockIds", "unlockedItems", "unlockedIds"
            )
            new_unlocks = _extract_string_set(
                state, "ownedUnlockIds", "unlockedItems", "unlockedIds"
            )
            for unlock_id in sorted(new_unlocks - prev_unlocks):
                emit_diff_event(
                    "workshop_purchase",
                    f"Unlocked {unlock_id} in Bram's Workshop",
                    {"unlockId": unlock_id, "byteShards": state.get("byteShards")},
                )

            prev_dragons = _extract_string_set(prev_state, "rescuedDragons")
            new_dragons = _extract_string_set(state, "rescuedDragons")
            for dragon_id in sorted(new_dragons - prev_dragons):
                emit_diff_event(
                    "dragon_rescued",
                    f"Rescued dragon {dragon_id}!",
                    {"dragonId": dragon_id},
                )

            prev_eggs = _extract_string_set(prev_state, "foundEasterEggs")
            new_eggs = _extract_string_set(state, "foundEasterEggs")
            for egg_id in sorted(new_eggs - prev_eggs):
                emit_diff_event(
                    "easter_egg_found",
                    f"Found hidden Easter Egg: {egg_id}",
                    {"eggId": egg_id, "byteShards": state.get("byteShards")},
                )

            if prev_realm and cur_realm and prev_realm != cur_realm:
                emit_diff_event(
                    "realm_entered",
                    f"Entered {cur_realm}",
                    {"fromRealmId": prev_realm, "toRealmId": cur_realm},
                )

            if emitted_events > 0:
                self._prune_events(conn, save_id)

            return state

    def delete_save(self, save_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM saves WHERE id = ?", (save_id,))
            if cur.rowcount > 0:
                conn.execute(
                    "DELETE FROM activity_events WHERE save_id = ?", (save_id,)
                )
                return True
            return False

    def log_attempt(
        self,
        save_id: str,
        trial_id: str,
        passed: bool,
        hints_used: int,
        code: str,
        difficulty_mode: str = "standard",
        is_practice: bool = False,
        error_type: str | None = None,
        duration_ms: int | None = None,
    ) -> int | None:
        now = utc_now_iso()
        day = now[:10]
        eff_difficulty = difficulty_mode if difficulty_mode in VALID_DIFFICULTY_MODES else "standard"
        eff_error_type = None if passed else error_type
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

            first_try_inc = 0
            unique_solver_inc = 0
            if not is_practice and passed:
                prior = conn.execute(
                    "SELECT COUNT(*) AS prior_attempts, "
                    "SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS prior_passes "
                    "FROM trial_attempts "
                    "WHERE save_id = ? AND trial_id = ? AND COALESCE(is_practice, 0) = 0",
                    (save_id, trial_id),
                ).fetchone()
                prior_attempts = int(prior["prior_attempts"] or 0) if prior else 0
                prior_passes = int(prior["prior_passes"] or 0) if prior else 0
                if prior_attempts == 0:
                    first_try_inc = 1
                if prior_passes == 0:
                    unique_solver_inc = 1

            cur = conn.execute(
                "INSERT INTO trial_attempts "
                "(save_id, trial_id, passed, hints_used, code, difficulty_mode, is_practice, error_type, duration_ms, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    save_id,
                    trial_id,
                    1 if passed else 0,
                    hints_used,
                    code,
                    eff_difficulty,
                    1 if is_practice else 0,
                    eff_error_type,
                    duration_ms,
                    now,
                ),
            )
            attempt_id = int(cur.lastrowid)

            if not is_practice:
                conn.execute(
                    "INSERT INTO trial_stats_daily "
                    "(day, trial_id, difficulty_mode, attempts, passes, first_try_passes, unique_solvers, total_hints, tier3_hints, parent_overrides) "
                    "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0) "
                    "ON CONFLICT(day, trial_id, difficulty_mode) DO UPDATE SET "
                    "attempts = attempts + excluded.attempts, "
                    "passes = passes + excluded.passes, "
                    "first_try_passes = first_try_passes + excluded.first_try_passes, "
                    "unique_solvers = unique_solvers + excluded.unique_solvers, "
                    "total_hints = total_hints + excluded.total_hints, "
                    "tier3_hints = tier3_hints + excluded.tier3_hints",
                    (
                        day,
                        trial_id,
                        eff_difficulty,
                        1 if passed else 0,
                        first_try_inc,
                        unique_solver_inc,
                        hints_used,
                        1 if hints_used >= 3 else 0,
                    ),
                )

            # Blank code blobs on older attempts while preserving aggregate stats
            conn.execute(
                "UPDATE trial_attempts SET code = '' "
                "WHERE save_id = ? AND code != '' AND id NOT IN ("
                "SELECT id FROM trial_attempts WHERE save_id = ? ORDER BY id DESC LIMIT ?"
                ")",
                (save_id, save_id, self.max_attempt_code_rows),
            )
            # Hard row cap for abuse protection
            conn.execute(
                "DELETE FROM trial_attempts "
                "WHERE save_id = ? AND id NOT IN ("
                "SELECT id FROM trial_attempts WHERE save_id = ? ORDER BY id DESC LIMIT ?"
                ")",
                (save_id, save_id, self.max_attempts_per_save),
            )

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
                    "difficultyMode": eff_difficulty,
                    "isPractice": is_practice,
                    "errorType": eff_error_type,
                    "durationMs": duration_ms,
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
                "SELECT id, save_id, trial_id, passed, hints_used, code, "
                "COALESCE(difficulty_mode, 'standard') AS difficulty_mode, "
                "COALESCE(is_practice, 0) AS is_practice, "
                "error_type, duration_ms, created_at "
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
                    "difficultyMode": str(r["difficulty_mode"] or "standard"),
                    "isPractice": bool(r["is_practice"]),
                    "errorType": r["error_type"],
                    "durationMs": int(r["duration_ms"]) if r["duration_ms"] is not None else None,
                    "createdAt": r["created_at"],
                }
                for r in rows
            ]

    def get_trial_metrics(
        self,
        catalog: list[dict[str, Any]],
        filters: dict[str, Any],
    ) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            return compute_trial_metrics_from_conn(conn, catalog, filters)

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
            was_already_solved = trial_id in seen
            if solved:
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

            if solved and not was_already_solved:
                day = now[:10]
                prefs = state.get("preferences")
                override_diff = (
                    prefs.get("difficulty")
                    if isinstance(prefs, dict) and prefs.get("difficulty") in VALID_DIFFICULTY_MODES
                    else "standard"
                )
                conn.execute(
                    "INSERT INTO trial_stats_daily "
                    "(day, trial_id, difficulty_mode, attempts, passes, first_try_passes, unique_solvers, total_hints, tier3_hints, parent_overrides) "
                    "VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 1) "
                    "ON CONFLICT(day, trial_id, difficulty_mode) DO UPDATE SET "
                    "parent_overrides = parent_overrides + 1",
                    (day, trial_id, override_diff),
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
        max_bytes: int = MAX_JSON_BODY_BYTES,
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
        if length > max_bytes:
            return (
                None,
                f"Request body exceeds limit ({max_bytes} bytes)",
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
        elif decoded in ("/builder", "/builder/", "/console", "/console/"):
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
        is_py_sandbox = False
        if base_dir == self.server.web_dir:
            web_rel_parts = target.relative_to(self.server.web_dir).parts
            is_py_sandbox = (
                len(web_rel_parts) == 1
                and web_rel_parts[0].lower() == "py-sandbox.html"
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

        if path in ("/api/builder/trial-metrics", "/api/admin/trial-metrics"):
            qs = parse_qs(query)
            try:
                filters = parse_trial_metrics_filters(qs)
            except SaveValidationError as exc:
                self._send_json(exc.status, {"error": exc.message})
                return
            try:
                with self.server.content_lock:
                    game, _ = self.server.load_game_and_catalog()
                    eras = self.server.load_all_eras(game)
            except (FileNotFoundError, json.JSONDecodeError):
                eras = []
            catalog = extract_trial_catalog(eras)
            metrics = self.server.db.get_trial_metrics(catalog, filters)
            if filters["format"] == "csv":
                csv_bytes = format_trial_metrics_csv(metrics["trials"]).encode("utf-8")
                self._sec_headers_sent = False
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header(
                    "Content-Disposition",
                    'attachment; filename="pyria-trial-metrics.csv"',
                )
                self.send_header("Content-Length", str(len(csv_bytes)))
                self.send_header("Cache-Control", "no-store")
                self._send_security_headers()
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(csv_bytes)
                return
            self._send_json(HTTPStatus.OK, metrics)
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown builder API endpoint"})

    def _handle_api_get(self, path: str, query: str) -> None:
        if path.startswith("/api/builder/") or path == "/api/admin/trial-metrics":
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
            role = "admin" if is_admin else ("player" if email else "guest")
            self._send_json(
                HTTPStatus.OK,
                {
                    "mode": "local",
                    "auth": {
                        "role": role,
                        "heroSaveId": None,
                        "heroName": None,
                        "parentEmail": email,
                        "isAdmin": is_admin,
                        "googleOAuthEnabled": False,
                    },
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
            body, err, err_status = self._read_json_body(
                max_bytes=MAX_SAVE_BODY_BYTES
            )
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
            try:
                save = self.server.db.create_save(body, owner_email=owner_email)
            except (SaveValidationError, SaveQuotaError) as exc:
                self._send_json(exc.status, {"error": exc.message})
                return
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
            body, err, err_status = self._read_json_body(
                max_bytes=MAX_ATTEMPT_BODY_BYTES
            )
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
                return
            raw_trial_id = body.get("trialId")
            if raw_trial_id is None and "trial_id" in body:
                raw_trial_id = body.get("trial_id")
            if not isinstance(raw_trial_id, str) or _has_control_chars(raw_trial_id):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "trialId is required and must be a valid string"},
                )
                return
            trial_id = raw_trial_id.strip()
            if not trial_id or len(trial_id) > MAX_TRIAL_ID_LEN:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "error": f"trialId must be between 1 and {MAX_TRIAL_ID_LEN} characters"
                    },
                )
                return
            passed = bool(body.get("passed", False))
            raw_hints = body.get("hintsUsed", body.get("hints_used", 0))
            if isinstance(raw_hints, bool):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "hintsUsed must be an integer"},
                )
                return
            try:
                hints_used = int(raw_hints)
            except (TypeError, ValueError):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "hintsUsed must be an integer"},
                )
                return
            raw_code = body.get("code", "")
            if raw_code is None:
                code = ""
            elif isinstance(raw_code, str):
                code = raw_code
            else:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "code must be a string"}
                )
                return
            if _has_surrogates_or_nul(code):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "error": "code must not contain NUL bytes or lone Unicode surrogates"
                    },
                )
                return
            if len(code.encode("utf-8")) > MAX_ATTEMPT_CODE_BYTES:
                self._send_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {
                        "error": f"Attempt code exceeds maximum length ({MAX_ATTEMPT_CODE_BYTES} bytes)"
                    },
                )
                return

            raw_diff = (
                body.get("difficultyMode")
                if "difficultyMode" in body
                else body.get("difficulty_mode")
            )
            difficulty_mode = "standard"
            if raw_diff is not None:
                if not isinstance(raw_diff, str) or raw_diff not in VALID_DIFFICULTY_MODES:
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "difficultyMode must be 'explorer', 'standard', or 'challenge'"},
                    )
                    return
                difficulty_mode = raw_diff

            raw_practice = (
                body.get("isPractice")
                if "isPractice" in body
                else body.get("is_practice")
            )
            is_practice = False
            if raw_practice is not None:
                if not isinstance(raw_practice, bool):
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "isPractice must be a boolean"},
                    )
                    return
                is_practice = raw_practice

            raw_error_type = (
                body.get("errorType")
                if "errorType" in body
                else body.get("error_type")
            )
            error_type: str | None = None
            if raw_error_type is not None and raw_error_type != "":
                if (
                    not isinstance(raw_error_type, str)
                    or len(raw_error_type) > MAX_ERROR_TYPE_LEN
                    or not ERROR_TYPE_RE.match(raw_error_type)
                ):
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {
                            "error": f"errorType must be a string up to {MAX_ERROR_TYPE_LEN} characters matching /^[A-Za-z0-9_.:-]+$/"
                        },
                    )
                    return
                error_type = raw_error_type
            if passed:
                error_type = None

            raw_duration = (
                body.get("durationMs")
                if "durationMs" in body
                else body.get("duration_ms")
            )
            duration_ms: int | None = None
            if raw_duration is not None:
                if (
                    isinstance(raw_duration, bool)
                    or not isinstance(raw_duration, int)
                    or raw_duration < 0
                    or raw_duration > MAX_DURATION_MS
                ):
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": f"durationMs must be an integer between 0 and {MAX_DURATION_MS}"},
                    )
                    return
                duration_ms = raw_duration

            attempt_id = self.server.db.log_attempt(
                save_id=parts[2],
                trial_id=trial_id,
                passed=passed,
                hints_used=max(0, min(hints_used, 1000)),
                code=code,
                difficulty_mode=difficulty_mode,
                is_practice=is_practice,
                error_type=error_type,
                duration_ms=duration_ms,
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
            body, err, err_status = self._read_json_body(
                max_bytes=MAX_SAVE_BODY_BYTES
            )
            if err is not None or body is None:
                self._send_json(err_status, {"error": err})
                return
            if (
                "save" in body
                and len(body) == 1
                and isinstance(body["save"], dict)
            ):
                body = body["save"]
            try:
                updated = self.server.db.update_save(parts[2], body)
            except SaveValidationError as exc:
                self._send_json(exc.status, {"error": exc.message})
                return
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
    *,
    max_saves_per_account: int | None = None,
    max_total_saves: int | None = None,
    max_attempt_code_rows: int | None = None,
    max_attempts_per_save: int | None = None,
    max_events_per_save: int | None = None,
) -> PyriaHTTPServer:
    db = PyriaDatabase(
        db_path,
        max_saves_per_account=max_saves_per_account,
        max_total_saves=max_total_saves,
        max_attempt_code_rows=max_attempt_code_rows,
        max_attempts_per_save=max_attempts_per_save,
        max_events_per_save=max_events_per_save,
    )
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
