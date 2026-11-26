#!/usr/bin/env python3
"""Automated unit & integration tests for server/app.py."""

from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app import create_server  # noqa: E402


class PyriaServerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_pyria.sqlite3"
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            root_dir=REPO_ROOT,
            db_path=self.db_path,
            quiet=True,
        )
        self.host, self.port = self.server.server_address[:2]
        self._thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self._thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=3)
        self._tmpdir.cleanup()

    def _request(
        self,
        method: str,
        path: str,
        body: dict | str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        headers: dict[str, str] = {}
        payload: bytes | None = None
        if isinstance(body, dict):
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif isinstance(body, str):
            payload = body.encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        conn.close()
        return resp.status, resp_headers, raw

    def test_health_and_config(self) -> None:
        status, _, raw = self._request("GET", "/api/health")
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertTrue(data["ok"])
        self.assertEqual(data["saveCount"], 0)
        self.assertEqual(Path(data["dbPath"]).resolve(), self.db_path.resolve())

        status, _, raw = self._request("GET", "/api/config")
        self.assertEqual(status, 200)
        cfg = json.loads(raw)
        self.assertIn("game", cfg)
        self.assertIn("catalog", cfg)
        self.assertEqual(cfg["game"]["currencyName"], "Byte Shards")
        self.assertTrue(len(cfg["catalog"]["unlockables"]) > 0)

    def test_save_crud_and_attempt_logging(self) -> None:
        # Initially empty
        status, _, raw = self._request("GET", "/api/saves")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["saves"], [])

        # Create save
        create_body = {
            "heroName": "Rowan",
            "appearance": {"skin": "peach", "hair": "spiky", "tunic": "emerald"},
            "byteShards": 0,
            "solvedTrials": [],
        }
        status, _, raw = self._request("POST", "/api/saves", create_body)
        self.assertEqual(status, 201)
        created = json.loads(raw)["save"]
        save_id = created["id"]
        self.assertEqual(created["heroName"], "Rowan")
        self.assertEqual(created["appearance"]["tunic"], "emerald")

        # Get save
        status, _, raw = self._request("GET", f"/api/saves/{save_id}")
        self.assertEqual(status, 200)
        fetched = json.loads(raw)["save"]
        self.assertEqual(fetched["id"], save_id)
        self.assertEqual(fetched["heroName"], "Rowan")

        # Update save
        updated_body = {
            **fetched,
            "heroName": "Rowan the Brave",
            "byteShards": 35,
            "solvedTrials": ["trial-01-01"],
        }
        status, _, raw = self._request("PUT", f"/api/saves/{save_id}", updated_body)
        self.assertEqual(status, 200)
        updated = json.loads(raw)["save"]
        self.assertEqual(updated["heroName"], "Rowan the Brave")
        self.assertEqual(updated["byteShards"], 35)
        self.assertEqual(updated["solvedTrials"], ["trial-01-01"])

        # Log trial attempt
        status, _, raw = self._request(
            "POST",
            f"/api/saves/{save_id}/attempts",
            {
                "trialId": "trial-01-01",
                "passed": True,
                "hintsUsed": 1,
                "code": 'print("Hello, Pyria!")\n',
            },
        )
        self.assertEqual(status, 201)
        attempt_res = json.loads(raw)
        self.assertTrue(attempt_res["ok"])
        self.assertIsInstance(attempt_res["attemptId"], int)

        # List attempts
        status, _, raw = self._request("GET", f"/api/saves/{save_id}/attempts")
        self.assertEqual(status, 200)
        attempts = json.loads(raw)["attempts"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["trialId"], "trial-01-01")
        self.assertTrue(attempts[0]["passed"])
        self.assertEqual(attempts[0]["hintsUsed"], 1)

        # 404 & 400 checks
        status, _, _ = self._request("GET", "/api/saves/does-not-exist")
        self.assertEqual(status, 404)
        status, _, _ = self._request("PUT", "/api/saves/does-not-exist", {"heroName": "X"})
        self.assertEqual(status, 404)
        status, _, _ = self._request(
            "POST", f"/api/saves/{save_id}/attempts", {"passed": True}
        )
        self.assertEqual(status, 400)
        status, _, _ = self._request("POST", "/api/saves", "{bad json")
        self.assertEqual(status, 400)

        # Health reflects saveCount = 1
        status, _, raw = self._request("GET", "/api/health")
        self.assertEqual(json.loads(raw)["saveCount"], 1)

    def test_static_serving_and_traversal_rejection(self) -> None:
        # Static /content/game.json
        status, headers, raw = self._request("GET", "/content/game.json")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("content-type", ""))
        self.assertEqual(json.loads(raw)["currencyName"], "Byte Shards")

        # Static /assets/sprites/manifest.json
        status, headers, raw = self._request("GET", "/assets/sprites/manifest.json")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("content-type", ""))
        self.assertIn("layers", json.loads(raw))

        # Static PNG asset
        status, headers, raw = self._request("GET", "/assets/sprites/8bit/shadow.png")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("content-type"), "image/png")
        self.assertTrue(raw.startswith(b"\x89PNG\r\n\x1a\n"))

        # Path traversal rejection
        for bad_path in (
            "/../LICENSE",
            "/content/../LICENSE",
            "/assets/%2e%2e/%2e%2e/etc/passwd",
            "/%2e%2e/server/app.py",
        ):
            status, _, _ = self._request("GET", bad_path)
            self.assertEqual(status, 403, f"Expected 403 for {bad_path}, got {status}")


if __name__ == "__main__":
    unittest.main()
