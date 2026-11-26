#!/usr/bin/env python3
"""Pyria lightweight Python 3 stdlib + SQLite game server.

Runs identically on macOS (local dev) and Debian 13 (elzar) with zero
third-party dependencies.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


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


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class PyriaDatabase:
    """Thread-safe SQLite storage for hero saves and trial attempts."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

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

                CREATE INDEX IF NOT EXISTS idx_saves_updated_at
                    ON saves(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_attempts_save_id
                    ON trial_attempts(save_id, created_at DESC);
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
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO saves (id, hero_name, state_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (save_id, hero_name, state_json, now, now),
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
            exists = conn.execute(
                "SELECT 1 FROM saves WHERE id = ?", (save_id,)
            ).fetchone()
            if exists is None:
                return None
            cur = conn.execute(
                "INSERT INTO trial_attempts "
                "(save_id, trial_id, passed, hints_used, code, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (save_id, trial_id, 1 if passed else 0, hints_used, code, now),
            )
            return int(cur.lastrowid)

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
        super().__init__(server_address, PyriaRequestHandler)


class PyriaRequestHandler(BaseHTTPRequestHandler):
    server: PyriaHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        # Concise structured log to stderr; can be silenced in tests via quiet flag
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
        self.send_header(
            "Cache-Control", "no-store" if no_store else "no-cache"
        )
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _handle_api_get(self, path: str) -> None:
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
            game_path = self.server.content_dir / "game.json"
            catalog_path = self.server.content_dir / "catalog.json"
            try:
                game = json.loads(game_path.read_text(encoding="utf-8"))
                catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
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
        # /api/saves/<id>
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "saves":
            save = self.server.db.get_save(parts[2])
            if save is None:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": "Save not found"}
                )
                return
            self._send_json(HTTPStatus.OK, {"save": save})
            return

        # /api/saves/<id>/attempts
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
            self._handle_api_get(parsed.path)
        else:
            self._serve_static(parsed.path)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api_get(parsed.path)
        else:
            self._serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path

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

        parts = [p for p in path.split("/") if p]
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

    def do_PUT(self) -> None:
        parsed = urlsplit(self.path)
        parts = [p for p in parsed.path.split("/") if p]
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
