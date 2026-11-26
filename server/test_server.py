#!/usr/bin/env python3
"""Automated unit & integration tests for server/app.py."""

from __future__ import annotations

import http.client
import json
import os
import shutil
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
        os.environ.pop("PYRIA_BUILDER_PASSCODE", None)
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=3)
        self._tmpdir.cleanup()

    def _request(
        self,
        method: str,
        path: str,
        body: dict | str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=10)
        headers: dict[str, str] = dict(extra_headers or {})
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
        status, _, raw = self._request("GET", "/api/saves")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["saves"], [])

        create_body = {
            "heroName": "Rowan",
            "appearance": {"skin": "peach", "hair": "spiky", "tunic": "emerald"},
            "realmId": "realm-01-meadow",
            "byteShards": 0,
            "solvedTrials": [],
            "openedChests": [],
            "ownedUnlockIds": [],
            "rescuedDragons": [],
        }
        status, _, raw = self._request("POST", "/api/saves", create_body)
        self.assertEqual(status, 201)
        created = json.loads(raw)["save"]
        save_id = created["id"]
        self.assertEqual(created["heroName"], "Rowan")
        self.assertEqual(created["appearance"]["tunic"], "emerald")

        status, _, raw = self._request("GET", f"/api/saves/{save_id}")
        self.assertEqual(status, 200)
        fetched = json.loads(raw)["save"]
        self.assertEqual(fetched["id"], save_id)

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

        status, _, raw = self._request("GET", f"/api/saves/{save_id}/attempts")
        self.assertEqual(status, 200)
        attempts = json.loads(raw)["attempts"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["trialId"], "trial-01-01")
        self.assertTrue(attempts[0]["passed"])

        # 404 & 400 checks
        self.assertEqual(self._request("GET", "/api/saves/does-not-exist")[0], 404)
        self.assertEqual(
            self._request("PUT", "/api/saves/does-not-exist", {"heroName": "X"})[0],
            404,
        )
        self.assertEqual(
            self._request("POST", f"/api/saves/{save_id}/attempts", {"passed": True})[0],
            400,
        )
        self.assertEqual(self._request("POST", "/api/saves", "{bad json")[0], 400)

        status, _, raw = self._request("GET", "/api/health")
        self.assertEqual(json.loads(raw)["saveCount"], 1)

    def test_static_serving_and_traversal_rejection(self) -> None:
        status, headers, raw = self._request("GET", "/content/game.json")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers.get("content-type", ""))
        self.assertEqual(json.loads(raw)["currencyName"], "Byte Shards")

        status, headers, raw = self._request("GET", "/assets/sprites/manifest.json")
        self.assertEqual(status, 200)
        self.assertIn("layers", json.loads(raw))

        status, headers, raw = self._request("GET", "/assets/sprites/8bit/shadow.png")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("content-type"), "image/png")
        self.assertTrue(raw.startswith(b"\x89PNG\r\n\x1a\n"))

        for bad_path in (
            "/../LICENSE",
            "/content/../LICENSE",
            "/builder/../../LICENSE",
            "/assets/%2e%2e/%2e%2e/etc/passwd",
            "/%2e%2e/server/app.py",
        ):
            status, _, _ = self._request("GET", bad_path)
            self.assertEqual(status, 403, f"Expected 403 for {bad_path}, got {status}")

    def test_builder_activity_stream_and_progress(self) -> None:
        # 1. Create hero -> hero_created
        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {
                "heroName": "Leo",
                "realmId": "realm-01-meadow",
                "byteShards": 0,
                "solvedTrials": [],
                "openedChests": [],
                "ownedUnlockIds": [],
                "rescuedDragons": [],
            },
        )
        self.assertEqual(status, 201)
        save = json.loads(raw)["save"]
        save_id = save["id"]

        # 2. Failed attempt + Passed attempt
        self.assertEqual(
            self._request(
                "POST",
                f"/api/saves/{save_id}/attempts",
                {"trialId": "trial-01-01", "passed": False, "hintsUsed": 1, "code": "print()"},
            )[0],
            201,
        )
        self.assertEqual(
            self._request(
                "POST",
                f"/api/saves/{save_id}/attempts",
                {
                    "trialId": "trial-01-01",
                    "passed": True,
                    "hintsUsed": 1,
                    "code": 'print("Hello, Pyria!")',
                },
            )[0],
            201,
        )

        # 3. PUT save with chest, workshop purchase, dragon rescue, realm change
        status, _, raw = self._request(
            "PUT",
            f"/api/saves/{save_id}",
            {
                **save,
                "realmId": "realm-02-ruins",
                "byteShards": 50,
                "solvedTrials": ["trial-01-01"],
                "openedChests": ["chest-01-01"],
                "ownedUnlockIds": ["hat-explorer"],
                "rescuedDragons": ["dragon-spark"],
            },
        )
        self.assertEqual(status, 200)

        # 4. Check /api/builder/activity?since=0
        status, _, raw = self._request("GET", "/api/builder/activity?since=0&limit=50")
        self.assertEqual(status, 200)
        act = json.loads(raw)
        event_types = [e["eventType"] for e in act["events"]]
        self.assertIn("hero_created", event_types)
        self.assertIn("trial_failed", event_types)
        self.assertIn("trial_passed", event_types)
        self.assertIn("chest_opened", event_types)
        self.assertIn("workshop_purchase", event_types)
        self.assertIn("dragon_rescued", event_types)
        self.assertIn("realm_entered", event_types)
        self.assertGreater(act["latestId"], 0)

        # Incremental polling with since=latestId returns empty
        status, _, raw = self._request(
            "GET", f"/api/builder/activity?since={act['latestId']}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["events"], [])

        # 5. Check /api/builder/progress
        status, _, raw = self._request("GET", "/api/builder/progress")
        self.assertEqual(status, 200)
        prog = json.loads(raw)
        self.assertEqual(prog["summary"]["totalSaves"], 1)
        self.assertEqual(prog["summary"]["totalAttempts"], 2)
        self.assertEqual(prog["summary"]["passRate"], 50.0)
        self.assertEqual(prog["summary"]["totalHintsUsed"], 2)
        self.assertEqual(prog["summary"]["totalDragonsRescued"], 1)
        self.assertEqual(prog["saves"][0]["stats"]["solvedCount"], 1)
        self.assertEqual(prog["saves"][0]["stats"]["rescuedCount"], 1)
        self.assertIn("globalDifficultyOverride", prog)
        self.assertGreaterEqual(len(prog["recentEvents"]), 7)

    def test_builder_overview_passcode_and_test_trial(self) -> None:
        # Overview
        status, _, raw = self._request("GET", "/api/builder/overview")
        self.assertEqual(status, 200)
        ov = json.loads(raw)
        self.assertIn("game", ov)
        self.assertIn("catalog", ov)
        self.assertGreaterEqual(len(ov["eras"]), 2)
        self.assertIsInstance(ov["conceptWarnings"], list)

        # Passcode protection when PYRIA_BUILDER_PASSCODE is set
        os.environ["PYRIA_BUILDER_PASSCODE"] = "secret-dragon"
        self.assertEqual(self._request("GET", "/api/builder/overview")[0], 401)
        self.assertEqual(
            self._request(
                "GET",
                "/api/builder/overview",
                extra_headers={"X-Builder-Passcode": "secret-dragon"},
            )[0],
            200,
        )
        os.environ.pop("PYRIA_BUILDER_PASSCODE", None)

        # /api/builder/test-trial PASS
        status, _, raw = self._request(
            "POST",
            "/api/builder/test-trial",
            {
                "code": 'print("Hello, Pyria!")\n',
                "testCode": 'assert "Hello, Pyria!" in OUTPUT',
            },
        )
        self.assertEqual(status, 200)
        res = json.loads(raw)
        self.assertTrue(res["passed"])
        self.assertFalse(res["timedOut"])
        self.assertIn("Hello, Pyria!", res["stdout"])
        self.assertTrue(res["pipFriendlyHint"])

        # /api/builder/test-trial FAIL
        status, _, raw = self._request(
            "POST",
            "/api/builder/test-trial",
            {
                "code": 'print("Oops")\n',
                "testCode": 'assert "Hello, Pyria!" in OUTPUT, "Missing greeting"',
            },
        )
        self.assertEqual(status, 200)
        res = json.loads(raw)
        self.assertFalse(res["passed"])
        self.assertIn("Missing greeting", res["pipFriendlyHint"])

        # /api/builder/test-trial TIMEOUT
        status, _, raw = self._request(
            "POST",
            "/api/builder/test-trial",
            {"code": "while True:\n    pass\n", "testCode": ""},
        )
        self.assertEqual(status, 200)
        res = json.loads(raw)
        self.assertFalse(res["passed"])
        self.assertTrue(res["timedOut"])
        self.assertIn("3 seconds", res["pipFriendlyHint"])

    def test_builder_static_and_content_mutations_isolated(self) -> None:
        # Spin up a second server against a temporary copied root so mutations never dirty repo content/
        with tempfile.TemporaryDirectory() as iso_tmp:
            iso_root = Path(iso_tmp) / "repo"
            shutil.copytree(REPO_ROOT / "content", iso_root / "content")
            (iso_root / "web" / "builder").mkdir(parents=True, exist_ok=True)
            (iso_root / "web" / "builder" / "index.html").write_text(
                "<!doctype html><title>Builder</title>", encoding="utf-8"
            )
            (iso_root / "assets").mkdir(parents=True, exist_ok=True)

            iso_srv = create_server(
                host="127.0.0.1",
                port=0,
                root_dir=iso_root,
                db_path=Path(iso_tmp) / "iso.sqlite3",
                quiet=True,
            )
            host, port = iso_srv.server_address[:2]
            t = threading.Thread(target=iso_srv.serve_forever, daemon=True)
            t.start()
            try:
                def req(method: str, path: str, body: dict | None = None):
                    conn = http.client.HTTPConnection(host, port, timeout=5)
                    headers = {"Content-Type": "application/json"} if body is not None else {}
                    payload = json.dumps(body).encode("utf-8") if body is not None else None
                    conn.request(method, path, body=payload, headers=headers)
                    r = conn.getresponse()
                    data = r.read()
                    conn.close()
                    return r.status, data

                # Static /builder and /builder/
                st, body = req("GET", "/builder")
                self.assertEqual(st, 200)
                self.assertIn(b"Builder", body)
                st, _ = req("GET", "/builder/")
                self.assertEqual(st, 200)

                # PUT /api/builder/difficulty (global)
                st, raw = req(
                    "PUT",
                    "/api/builder/difficulty",
                    {
                        "scope": "global",
                        "override": {
                            "mode": "explorer",
                            "showRawTracebacks": True,
                            "maxHintsAllowed": 2,
                        },
                    },
                )
                self.assertEqual(st, 200)
                self.assertEqual(
                    json.loads(raw)["globalDifficultyOverride"]["mode"], "explorer"
                )

                # PUT /api/builder/realms/<eraId>/<realmId>
                st, raw = req(
                    "PUT",
                    "/api/builder/realms/era-01-8bit/realm-01-meadow",
                    {"miniVisualUpgrade": "Golden Firefly Glow"},
                )
                self.assertEqual(st, 200)
                self.assertEqual(
                    json.loads(raw)["realm"]["miniVisualUpgrade"], "Golden Firefly Glow"
                )

                # PUT + DELETE Trial
                st, raw = req(
                    "PUT",
                    "/api/builder/realms/era-01-8bit/realm-01-meadow/trials/trial-custom-99",
                    {
                        "title": "Custom Test Trial",
                        "storyPrompt": "Test",
                        "objective": "Print hi",
                        "concepts": ["print_output"],
                        "shardReward": 10,
                        "unlockId": None,
                        "starterCode": {"explorer": "", "standard": "", "challenge": ""},
                        "referenceSolution": 'print("hi")',
                        "testCode": 'assert "hi" in OUTPUT',
                        "hints": {
                            "tier1_nudge": "a",
                            "tier2_pattern": "b",
                            "tier3_walkthrough": "c",
                        },
                        "difficultyOverride": None,
                    },
                )
                self.assertEqual(st, 200)
                self.assertTrue(json.loads(raw)["created"])

                st, raw = req(
                    "DELETE",
                    "/api/builder/realms/era-01-8bit/realm-01-meadow/trials/trial-custom-99",
                )
                self.assertEqual(st, 200)
                self.assertEqual(json.loads(raw)["deletedTrialId"], "trial-custom-99")
            finally:
                iso_srv.shutdown()
                iso_srv.server_close()
                t.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
