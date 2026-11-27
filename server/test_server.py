#!/usr/bin/env python3
"""Automated unit & integration tests for server/app.py."""

from __future__ import annotations

import base64
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

import app as pyria_app  # noqa: E402
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
            dev_mode=True,
        )
        self.host, self.port = self.server.server_address[:2]
        self._thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self._thread.start()

    def tearDown(self) -> None:
        os.environ.pop("PYRIA_BUILDER_PASSCODE", None)
        os.environ.pop("PYRIA_ADMIN_EMAILS", None)
        os.environ.pop("PYRIA_DEV_MODE", None)
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
                "foundEasterEggs": ["egg-01-a"],
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
        self.assertIn("easter_egg_found", event_types)
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

        # /api/builder/test-trial has been removed (zero server-side Python execution)
        status, _, _ = self._request(
            "POST",
            "/api/builder/test-trial",
            {
                "code": 'print("Hello, Pyria!")\n',
                "testCode": 'assert "Hello, Pyria!" in OUTPUT',
            },
        )
        self.assertEqual(status, 404)
        self.assertFalse(hasattr(pyria_app, "run_sandboxed_trial_test"))
        self.assertFalse(hasattr(pyria_app, "PYTHON_TRIAL_HARNESS"))
        self.assertFalse(hasattr(pyria_app, "subprocess"))

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
                dev_mode=True,
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

    def test_parent_trial_override_endpoint(self) -> None:
        # Create a hero with a trial draft in place
        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {
                "heroName": "Aria",
                "realmId": "realm-01-meadow",
                "byteShards": 10,
                "solvedTrials": [],
                "completedTrials": [],
                "trialDrafts": {"trial-01-01": "print('wip')"},
            },
        )
        self.assertEqual(status, 201)
        save_id = json.loads(raw)["save"]["id"]

        # 404 on unknown save
        self.assertEqual(
            self._request(
                "POST",
                "/api/builder/saves/missing-id/override-trial",
                {"trialId": "trial-01-01", "solved": True},
            )[0],
            404,
        )

        # 400 on missing trialId / non-bool solved
        self.assertEqual(
            self._request(
                "POST",
                f"/api/builder/saves/{save_id}/override-trial",
                {"solved": True},
            )[0],
            400,
        )
        self.assertEqual(
            self._request(
                "POST",
                f"/api/builder/saves/{save_id}/override-trial",
                {"trialId": "trial-01-01"},
            )[0],
            400,
        )

        # Passcode guard respected
        os.environ["PYRIA_BUILDER_PASSCODE"] = "dad-key"
        self.assertEqual(
            self._request(
                "POST",
                f"/api/builder/saves/{save_id}/override-trial",
                {"trialId": "trial-01-01", "solved": True},
            )[0],
            401,
        )
        os.environ.pop("PYRIA_BUILDER_PASSCODE", None)

        # 1. Mark trial-01-01 complete (default awardShards=True)
        status, _, raw = self._request(
            "POST",
            f"/api/builder/saves/{save_id}/override-trial",
            {"trialId": "trial-01-01", "solved": True, "awardShards": True},
        )
        self.assertEqual(status, 200)
        res1 = json.loads(raw)
        self.assertTrue(res1["ok"])
        self.assertGreater(res1["shardsDelta"], 0)
        expected_shards = 10 + res1["shardsDelta"]
        self.assertEqual(res1["save"]["state"]["byteShards"], expected_shards)
        self.assertIn("trial-01-01", res1["save"]["state"]["solvedTrials"])
        self.assertIn("trial-01-01", res1["save"]["state"]["completedTrials"])
        self.assertNotIn("trial-01-01", res1["save"]["state"].get("trialDrafts", {}))
        self.assertEqual(res1["save"]["stats"]["solvedCount"], 1)

        # 2. Idempotency: marking already-solved trial complete again awards 0 shards
        status, _, raw = self._request(
            "POST",
            f"/api/builder/saves/{save_id}/override-trial",
            {"trialId": "trial-01-01", "solved": True, "awardShards": True},
        )
        self.assertEqual(status, 200)
        res2 = json.loads(raw)
        self.assertEqual(res2["shardsDelta"], 0)
        self.assertEqual(res2["save"]["state"]["byteShards"], expected_shards)
        self.assertEqual(res2["save"]["state"]["solvedTrials"].count("trial-01-01"), 1)

        # 3. Reset trial-01-01 to unsolved
        status, _, raw = self._request(
            "POST",
            f"/api/builder/saves/{save_id}/override-trial",
            {"trialId": "trial-01-01", "solved": False},
        )
        self.assertEqual(status, 200)
        res3 = json.loads(raw)
        self.assertEqual(res3["shardsDelta"], 0)
        self.assertNotIn("trial-01-01", res3["save"]["state"]["solvedTrials"])
        self.assertNotIn("trial-01-01", res3["save"]["state"]["completedTrials"])
        self.assertEqual(res3["save"]["stats"]["solvedCount"], 0)

        # 4. Verify parent_override events logged in activity_events
        status, _, raw = self._request("GET", "/api/builder/activity?since=0&limit=50")
        self.assertEqual(status, 200)
        override_events = [
            e for e in json.loads(raw)["events"] if e["eventType"] == "parent_override"
        ]
        self.assertEqual(len(override_events), 3)
        self.assertIn("complete", override_events[0]["summary"])
        self.assertIn("reset", override_events[2]["summary"].lower())

    def test_cloudflare_access_auth_isolation_and_admin_switching(self) -> None:
        # 1. Local dev (no PYRIA_ADMIN_EMAILS, no CF header) -> local admin
        status, _, raw = self._request("GET", "/api/me")
        self.assertEqual(status, 200)
        me_local = json.loads(raw)
        self.assertFalse(me_local["authenticated"])
        self.assertIsNone(me_local["email"])
        self.assertTrue(me_local["isAdmin"])

        # Enable admin email enforcement
        os.environ["PYRIA_ADMIN_EMAILS"] = "dknowles2@gmail.com"
        admin_hdr = {"Cf-Access-Authenticated-User-Email": "DKnowles2@gmail.com"}
        kid_hdr = {"Cf-Access-Authenticated-User-Email": "jacob.elliott.knowles@gmail.com"}
        other_hdr = {"Cf-Access-Authenticated-User-Email": "guest@example.com"}

        # Helper to construct an unsigned JWT payload — MUST be ignored (no unverified JWT fallback)
        jwt_payload = base64.urlsafe_b64encode(
            json.dumps({"email": "dknowles2@gmail.com"}).encode("utf-8")
        ).decode("ascii").rstrip("=")
        forged_jwt_hdr = {"Cf-Access-Jwt-Assertion": f"eyJhbGciOiJSUzI1NiJ9.{jwt_payload}.sig"}

        # 2. /api/me for kid via email header; forged unsigned JWT must NOT authenticate
        status, _, raw = self._request("GET", "/api/me", extra_headers=kid_hdr)
        self.assertEqual(status, 200)
        me_kid = json.loads(raw)
        self.assertTrue(me_kid["authenticated"])
        self.assertEqual(me_kid["email"], "jacob.elliott.knowles@gmail.com")
        self.assertFalse(me_kid["isAdmin"])
        self.assertEqual(me_kid["accounts"], ["jacob.elliott.knowles@gmail.com"])

        status, _, raw = self._request("GET", "/api/me", extra_headers=forged_jwt_hdr)
        self.assertEqual(status, 200)
        me_forged = json.loads(raw)
        self.assertFalse(me_forged["authenticated"])
        self.assertIsNone(me_forged["email"])
        self.assertFalse(me_forged["isAdmin"])

        # /api/health hides dbPath & saveCount from non-admin players, exposes to admin
        status, _, raw = self._request("GET", "/api/health", extra_headers=kid_hdr)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"ok": True})
        status, _, raw = self._request("GET", "/api/health", extra_headers=admin_hdr)
        self.assertEqual(status, 200)
        self.assertIn("dbPath", json.loads(raw))
        self.assertIn("saveCount", json.loads(raw))

        # Unauthenticated POST /api/saves rejected with 401 when auth is enabled
        self.assertEqual(
            self._request("POST", "/api/saves", {"heroName": "Anon"})[0],
            401,
        )

        # 3. Kid creates a hero; admin creates a hero for self and one for guest
        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "JacobHero", "ownerEmail": "spoofed@evil.com"},
            extra_headers=kid_hdr,
        )
        self.assertEqual(status, 201)
        kid_save = json.loads(raw)["save"]
        # Non-admin cannot spoof ownerEmail
        self.assertEqual(kid_save["ownerEmail"], "jacob.elliott.knowles@gmail.com")

        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "DadHero"},
            extra_headers=admin_hdr,
        )
        self.assertEqual(status, 201)
        dad_save = json.loads(raw)["save"]
        self.assertEqual(dad_save["ownerEmail"], "dknowles2@gmail.com")

        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "GuestHero", "ownerEmail": "guest@example.com"},
            extra_headers=admin_hdr,
        )
        self.assertEqual(status, 201)
        guest_save = json.loads(raw)["save"]
        self.assertEqual(guest_save["ownerEmail"], "guest@example.com")

        # 4. Per-email save isolation for non-admin
        status, _, raw = self._request("GET", "/api/saves", extra_headers=kid_hdr)
        self.assertEqual(status, 200)
        kid_saves = json.loads(raw)["saves"]
        self.assertEqual([s["id"] for s in kid_saves], [kid_save["id"]])

        # Cross-user 403 on GET / PUT / DELETE / attempts
        self.assertEqual(
            self._request("GET", f"/api/saves/{dad_save['id']}", extra_headers=kid_hdr)[0],
            403,
        )
        self.assertEqual(
            self._request(
                "PUT",
                f"/api/saves/{dad_save['id']}",
                {"heroName": "Hacked"},
                extra_headers=kid_hdr,
            )[0],
            403,
        )
        self.assertEqual(
            self._request("DELETE", f"/api/saves/{dad_save['id']}", extra_headers=kid_hdr)[0],
            403,
        )
        self.assertEqual(
            self._request(
                "POST",
                f"/api/saves/{dad_save['id']}/attempts",
                {"trialId": "trial-01-01", "passed": True},
                extra_headers=kid_hdr,
            )[0],
            403,
        )
        self.assertEqual(
            self._request("GET", f"/api/saves/{dad_save['id']}/attempts", extra_headers=kid_hdr)[0],
            403,
        )

        # 5. Admin /api/me accounts list & ?owner=all / ?owner=<email> switching
        status, _, raw = self._request("GET", "/api/me", extra_headers=admin_hdr)
        self.assertEqual(status, 200)
        me_admin = json.loads(raw)
        self.assertTrue(me_admin["isAdmin"])
        self.assertEqual(
            me_admin["accounts"],
            ["dknowles2@gmail.com", "guest@example.com", "jacob.elliott.knowles@gmail.com"],
        )

        # Admin default (no owner param) -> own saves
        status, _, raw = self._request("GET", "/api/saves", extra_headers=admin_hdr)
        self.assertEqual([s["id"] for s in json.loads(raw)["saves"]], [dad_save["id"]])

        # Admin ?owner=all -> all 3 saves
        status, _, raw = self._request("GET", "/api/saves?owner=all", extra_headers=admin_hdr)
        self.assertEqual(len(json.loads(raw)["saves"]), 3)

        # Admin ?owner=jacob... -> Jacob's save
        status, _, raw = self._request(
            "GET",
            "/api/saves?owner=jacob.elliott.knowles@gmail.com",
            extra_headers=admin_hdr,
        )
        self.assertEqual([s["id"] for s in json.loads(raw)["saves"]], [kid_save["id"]])

        # 6. Lock /builder and /api/builder/* to admins
        status, headers, raw = self._request("GET", "/builder", extra_headers=kid_hdr)
        self.assertEqual(status, 403)
        self.assertIn("text/html", headers.get("content-type", ""))
        self.assertIn(b"403", raw)

        self.assertEqual(
            self._request("GET", "/builder/builder.js", extra_headers=kid_hdr)[0],
            403,
        )
        self.assertEqual(
            self._request("GET", "/api/builder/progress", extra_headers=kid_hdr)[0],
            403,
        )
        self.assertEqual(
            self._request("GET", "/api/builder/overview", extra_headers=other_hdr)[0],
            403,
        )

        # Admin gets 200 on /builder and /api/builder/progress (with accounts + ?owner= filter)
        self.assertEqual(
            self._request("GET", "/builder", extra_headers=admin_hdr)[0], 200
        )
        status, _, raw = self._request(
            "GET", "/api/builder/progress", extra_headers=admin_hdr
        )
        self.assertEqual(status, 200)
        prog_all = json.loads(raw)
        self.assertEqual(len(prog_all["saves"]), 3)
        self.assertEqual(
            prog_all["accounts"],
            ["dknowles2@gmail.com", "guest@example.com", "jacob.elliott.knowles@gmail.com"],
        )

        status, _, raw = self._request(
            "GET",
            "/api/builder/progress?owner=jacob.elliott.knowles@gmail.com",
            extra_headers=admin_hdr,
        )
        self.assertEqual(status, 200)
        prog_kid = json.loads(raw)
        self.assertEqual(len(prog_kid["saves"]), 1)
        self.assertEqual(prog_kid["saves"][0]["ownerEmail"], "jacob.elliott.knowles@gmail.com")

        # 7. POST /api/builder/saves/<id>/assign-owner
        status, _, raw = self._request(
            "POST",
            f"/api/builder/saves/{guest_save['id']}/assign-owner",
            {"ownerEmail": "jacob.elliott.knowles@gmail.com"},
            extra_headers=admin_hdr,
        )
        self.assertEqual(status, 200)
        reassigned = json.loads(raw)
        self.assertTrue(reassigned["ok"])
        self.assertEqual(
            reassigned["save"]["ownerEmail"], "jacob.elliott.knowles@gmail.com"
        )

        # Kid now sees 2 saves
        status, _, raw = self._request("GET", "/api/saves", extra_headers=kid_hdr)
        self.assertEqual(len(json.loads(raw)["saves"]), 2)

        # Builder path normalization bypasses must still return 403 for non-admin
        for bypass_path in (
            "/%2fbuilder/",
            "/%2Fbuilder/builder.js",
            "/./builder/",
            "/./builder/index.html",
            "//builder/",
        ):
            st, _, _ = self._request("GET", bypass_path, extra_headers=kid_hdr)
            self.assertEqual(st, 403, f"Expected 403 for {bypass_path}, got {st}")

    def test_security_headers_csrf_and_body_limit(self) -> None:
        # 1. Security headers present on API, HTML, and static responses
        for path in ("/api/health", "/", "/assets/world/preview.html"):
            status, headers, _ = self._request("GET", path)
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(headers.get("x-frame-options"), "SAMEORIGIN")
            self.assertEqual(headers.get("referrer-policy"), "same-origin")
            self.assertIn("camera=()", headers.get("permissions-policy", ""))
            csp = headers.get("content-security-policy", "")
            self.assertIn("frame-ancestors 'self'", csp)
            if path == "/assets/world/preview.html":
                self.assertIn("'unsafe-inline'", csp)
            else:
                self.assertIn("script-src 'self'", csp)
                self.assertIn("frame-src 'self'", csp)
                self.assertIn("worker-src 'none'", csp)
                self.assertNotIn("'wasm-unsafe-eval'", csp)
                self.assertNotIn("https://cdn.jsdelivr.net", csp)

        # 2. CSRF / Same-Origin protection on POST / PUT / DELETE
        same_origin = f"http://{self.host}:{self.port}"
        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "SameOriginHero"},
            extra_headers={"Origin": same_origin, "Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(status, 201)
        save_id = json.loads(raw)["save"]["id"]

        # Reject Sec-Fetch-Site: cross-site
        self.assertEqual(
            self._request(
                "POST",
                "/api/saves",
                {"heroName": "Evil"},
                extra_headers={"Sec-Fetch-Site": "cross-site"},
            )[0],
            403,
        )
        # Reject mismatched Origin on POST, PUT, DELETE
        for method, path, body in (
            ("POST", "/api/saves", {"heroName": "Evil"}),
            ("PUT", f"/api/saves/{save_id}", {"heroName": "Evil"}),
            ("DELETE", f"/api/saves/{save_id}", None),
        ):
            st, _, _ = self._request(
                method,
                path,
                body,
                extra_headers={"Origin": "https://evil.example.com"},
            )
            self.assertEqual(st, 403, f"Expected 403 for cross-origin {method} {path}")

        # Reject Origin: null
        self.assertEqual(
            self._request(
                "POST",
                "/api/saves",
                {"heroName": "NullOrigin"},
                extra_headers={"Origin": "null"},
            )[0],
            403,
        )

        # Allow matching X-Forwarded-Host
        self.assertEqual(
            self._request(
                "PUT",
                f"/api/saves/{save_id}",
                {"heroName": "ProxyHero"},
                extra_headers={
                    "Origin": "https://pyria.example.com",
                    "X-Forwarded-Host": "pyria.example.com",
                },
            )[0],
            200,
        )

        # 3. Request body size limit -> 413 Payload Too Large
        oversized = json.dumps({"heroName": "Big", "pad": "A" * (520 * 1024)})
        status, _, _ = self._request("POST", "/api/saves", oversized)
        self.assertEqual(status, 413)

        # 4. Defense-in-depth numeric coercion of byteShards & strict JSON (reject NaN/Infinity)
        status, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "SafeHero", "byteShards": "<svg onload=alert(1)>"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(raw)["save"]["byteShards"], 0)

        for bad_json in (
            '{"heroName": "Poison", "junk": NaN}',
            '{"heroName": "Poison", "junk": Infinity}',
            '{"heroName": "Poison", "byteShards": 1e400}',
        ):
            st, _, _ = self._request("POST", "/api/saves", bad_json)
            self.assertEqual(st, 400, f"Expected 400 for {bad_json}, got {st}")

        # 5. Content-Type: application/json required on JSON POST/PUT mutations -> 415
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        conn.request(
            "POST",
            "/api/saves",
            body=b'{"heroName": "Plain"}',
            headers={"Content-Type": "text/plain"},
        )
        resp = conn.getresponse()
        resp.read()
        conn.close()
        self.assertEqual(resp.status, 415)

    def test_pyodide_sandbox_isolation_headers_and_assets(self) -> None:
        # 1. /py-sandbox.html is served with strict opaque-origin sandbox CSP
        for sandbox_path in (
            "/py-sandbox.html",
            "/py-sandbox.html?v=test",
            "/./py-sandbox.html",
            "//py-sandbox.html",
            "/PY-SANDBOX.HTML",
            "/Py-Sandbox.html",
        ):
            status, headers, raw = self._request("GET", sandbox_path)
            if status == 404 and sandbox_path in ("/PY-SANDBOX.HTML", "/Py-Sandbox.html"):
                # On case-sensitive filesystems (Linux), uppercase paths 404 cleanly;
                # on case-insensitive filesystems (macOS APFS), they must still get sandbox CSP.
                continue
            self.assertEqual(status, 200, f"Expected 200 for {sandbox_path}")
            self.assertIn("text/html", headers.get("content-type", ""))
            self.assertEqual(headers.get("x-frame-options"), "SAMEORIGIN")
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")

            csp = headers.get("content-security-policy", "")
            self.assertIn("sandbox allow-scripts;", csp)
            self.assertNotIn("allow-same-origin", csp)
            self.assertIn("default-src 'none';", csp)
            self.assertIn("'sha256-", csp)
            self.assertNotIn("'unsafe-inline'", csp)
            self.assertIn("'wasm-unsafe-eval'", csp)
            self.assertIn("worker-src blob:;", csp)
            self.assertIn(
                "connect-src https://cdn.jsdelivr.net/pyodide/v0.26.4/full/;",
                csp,
            )
            self.assertNotIn("connect-src 'self'", csp)
            self.assertNotIn("https://cdn.jsdelivr.net;", csp)
            self.assertNotIn("https://cdn.jsdelivr.net ", csp)
            self.assertIn("object-src 'none';", csp)
            self.assertIn("base-uri 'none';", csp)
            self.assertIn("form-action 'none';", csp)
            self.assertIn("frame-ancestors 'self'", csp)
            self.assertEqual(csp, pyria_app.build_py_sandbox_csp(raw))

        # 2. Legacy same-origin pyWorker.js has been removed
        self.assertEqual(self._request("GET", "/js/pyWorker.js")[0], 404)

        # 3. pyRunner.js uses sandbox="allow-scripts" (never allow-same-origin)
        py_runner_src = (REPO_ROOT / "web" / "js" / "pyRunner.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("'sandbox', 'allow-scripts'", py_runner_src)
        self.assertNotIn("new Worker(", py_runner_src)
        self.assertNotIn("pyWorker.js", py_runner_src)

        # 4. py-sandbox.html fails closed unless loaded in an opaque origin
        sandbox_src = (REPO_ROOT / "web" / "py-sandbox.html").read_text(
            encoding="utf-8"
        )
        self.assertIn("window.origin !== 'null'", sandbox_src)
        self.assertIn("_PYRIA_BLOCKED_MODULES", sandbox_src)
        self.assertIn("redirect_stderr", sandbox_src)

    def test_fail_closed_when_not_dev_mode(self) -> None:
        # Spin up a production-mode (dev_mode=False) server with PYRIA_ADMIN_EMAILS unset
        os.environ.pop("PYRIA_ADMIN_EMAILS", None)
        os.environ.pop("PYRIA_DEV_MODE", None)
        with tempfile.TemporaryDirectory() as tmp:
            srv = create_server(
                host="127.0.0.1",
                port=0,
                root_dir=REPO_ROOT,
                db_path=Path(tmp) / "prod.sqlite3",
                quiet=True,
                dev_mode=False,
            )
            host, port = srv.server_address[:2]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
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

                st, raw = req("GET", "/api/me")
                self.assertEqual(st, 200)
                self.assertFalse(json.loads(raw)["isAdmin"])

                st, raw = req("GET", "/api/health")
                self.assertEqual(st, 200)
                self.assertEqual(json.loads(raw), {"ok": True})

                self.assertEqual(req("GET", "/builder")[0], 403)
                self.assertEqual(req("GET", "/api/builder/overview")[0], 403)
                self.assertEqual(req("POST", "/api/saves", {"heroName": "Anon"})[0], 401)
            finally:
                srv.shutdown()
                srv.server_close()
                t.join(timeout=3)

    def test_hero_name_and_save_field_validation(self) -> None:
        # 1. Full client save schema (matching web/js/api.js createDefaultSaveState) succeeds
        full_client_save = {
            "heroName": "Al",  # exact min boundary (2 chars)
            "appearance": {
                "skin": "warm_tan",
                "hair": "spiky",
                "tunic": "emerald",
                "hat": None,
                "boots": "boots_default",
                "shield": None,
                "cloak": None,
                "aura": None,
                "pipScarf": None,
            },
            "eraId": "era-01-8bit",
            "realmId": "realm-01-meadow",
            "visualEra": "8bit",
            "byteShards": 0,
            "stats": {"charisma": 0, "courage": 0},
            "solvedTrials": [],
            "completedTrials": [],
            "trialDrafts": {"trial-01-01": 'print("hi")\n'},
            "seenCutscenes": ["intro-01"],
            "foundEasterEggs": [],
            "unlockedSpells": [],
            "rescuedDragons": [],
            "openedChests": [],
            "ownedUnlockIds": [],
            "position": {"realmId": "realm-01-meadow", "x": 120, "y": 240},
        }
        status, _, raw = self._request("POST", "/api/saves", full_client_save)
        self.assertEqual(status, 201)
        created = json.loads(raw)["save"]
        save_id = created["id"]
        self.assertEqual(created["heroName"], "Al")

        # 2. Exact max boundary (24 chars) and whitespace trimming
        max_name = "A" * 24
        status, _, raw = self._request(
            "PUT", f"/api/saves/{save_id}", {**created, "heroName": f"  {max_name}  "}
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["save"]["heroName"], max_name)

        # Partial PUT omitting heroName preserves existing heroName
        status, _, raw = self._request(
            "PUT", f"/api/saves/{save_id}", {"byteShards": 42}
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["save"]["heroName"], max_name)
        self.assertEqual(json.loads(raw)["save"]["byteShards"], 42)

        # 3. Reject invalid heroName on POST and PUT
        for bad_name in (
            "",
            " ",
            "A",
            "  A  ",
            "B" * 25,
            "龍" * 25,
            "Rowan\nEvil",
            "Rowan\rEvil",
            "Rowan\tTab",
            "Rowan\x00Null",
            "Rowan\x1b[31m",
            "Rowan\u202eBidi",
            "Rowan\u2028LineSep",
            "Rowan\u2029ParaSep",
            123,
            None,
            ["Rowan"],
        ):
            st, _, raw = self._request("POST", "/api/saves", {"heroName": bad_name})
            self.assertEqual(st, 400, f"Expected 400 for POST heroName={bad_name!r}, got {st}")
            self.assertIn("error", json.loads(raw))

            st, _, raw = self._request(
                "PUT", f"/api/saves/{save_id}", {"heroName": bad_name}
            )
            self.assertEqual(st, 400, f"Expected 400 for PUT heroName={bad_name!r}, got {st}")
            self.assertIn("error", json.loads(raw))

        # Non-ASCII exact max (24 CJK chars) and ZWJ emoji hero names accepted
        cjk_24 = "龍" * 24
        st, _, raw = self._request("POST", "/api/saves", {"heroName": cjk_24})
        self.assertEqual(st, 201)
        self.assertEqual(json.loads(raw)["save"]["heroName"], cjk_24)

        zwj_name = "👨‍👩‍👧 Kid"
        st, _, raw = self._request("POST", "/api/saves", {"heroName": zwj_name})
        self.assertEqual(st, 201)
        self.assertEqual(json.loads(raw)["save"]["heroName"], zwj_name)

        # byteShards clamped to [0, MAX_BYTE_SHARDS] and bool rejected to fallback
        st, _, raw = self._request(
            "PUT", f"/api/saves/{save_id}", {"byteShards": -50}
        )
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)["save"]["byteShards"], 0)

        st, _, raw = self._request(
            "PUT", f"/api/saves/{save_id}", {"byteShards": 10**20}
        )
        self.assertEqual(st, 200)
        self.assertEqual(
            json.loads(raw)["save"]["byteShards"], pyria_app.MAX_BYTE_SHARDS
        )

        st, _, raw = self._request(
            "POST", "/api/saves", {"heroName": "BoolShards", "byteShards": True}
        )
        self.assertEqual(st, 201)
        self.assertEqual(json.loads(raw)["save"]["byteShards"], 0)

        # Legacy save with non-conforming heroName ("X") can still be PUT when echoing "X",
        # while renaming to another invalid name ("Y") is rejected with 400
        legacy_id = "legacy-save-001"
        with self.server.db._connect() as conn:
            conn.execute(
                "INSERT INTO saves (id, hero_name, owner_email, state_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    legacy_id,
                    "X",
                    None,
                    json.dumps({"id": legacy_id, "heroName": "X", "byteShards": 5}),
                    "2026-01-01T00:00:00Z",
                    "2026-01-01T00:00:00Z",
                ),
            )
        st, _, raw = self._request(
            "PUT",
            f"/api/saves/{legacy_id}",
            {"heroName": "X", "byteShards": 15, "solvedTrials": ["trial-01-01"]},
        )
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)["save"]["heroName"], "X")
        self.assertEqual(json.loads(raw)["save"]["byteShards"], 15)

        st, _, _ = self._request(
            "PUT", f"/api/saves/{legacy_id}", {"heroName": "Y", "byteShards": 20}
        )
        self.assertEqual(st, 400)

        # Missing heroName on POST -> 400
        st, _, raw = self._request("POST", "/api/saves", {"realmId": "realm-01-meadow"})
        self.assertEqual(st, 400)
        self.assertIn("heroName", json.loads(raw)["error"])

        # 4. Disallowed top-level keys -> 400 on POST and PUT
        st, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "Rowan", "evilKey": "boom", "extraBlob": [1, 2, 3]},
        )
        self.assertEqual(st, 400)
        self.assertIn("Disallowed save field", json.loads(raw)["error"])

        st, _, raw = self._request(
            "PUT",
            f"/api/saves/{save_id}",
            {"heroName": "Rowan", "injectedField": True},
        )
        self.assertEqual(st, 400)
        self.assertIn("Disallowed save field", json.loads(raw)["error"])

        # 5. Invalid types on allowed fields -> 400
        for bad_payload in (
            {"heroName": "Rowan", "solvedTrials": "not-a-list"},
            {"heroName": "Rowan", "solvedTrials": [123]},
            {"heroName": "Rowan", "appearance": "not-a-dict"},
            {"heroName": "Rowan", "stats": {"courage": True}},
            {"heroName": "Rowan", "position": ["x", "y"]},
            {"heroName": "Rowan", "trialDrafts": {"trial-01-01": 999}},
            {"heroName": "Rowan", "realmId": "realm-01\x00bad"},
        ):
            st, _, raw = self._request("POST", "/api/saves", bad_payload)
            self.assertEqual(st, 400, f"Expected 400 for {bad_payload!r}, got {st}")
            self.assertIn("error", json.loads(raw))

    def test_save_payload_size_and_attempt_code_caps(self) -> None:
        # 1. Raw body > 128 KiB on POST /api/saves -> 413
        big_drafts = {
            f"trial-{i:03d}": "x" * (28 * 1024) for i in range(6)
        }  # ~168 KiB raw
        st, _, raw = self._request(
            "POST", "/api/saves", {"heroName": "Rowan", "trialDrafts": big_drafts}
        )
        self.assertEqual(st, 413)
        self.assertIn("error", json.loads(raw))

        # 2. Single trialDraft > 32 KiB -> 413
        st, _, raw = self._request(
            "POST",
            "/api/saves",
            {
                "heroName": "Rowan",
                "trialDrafts": {
                    "trial-01-01": "a" * (pyria_app.MAX_ATTEMPT_CODE_BYTES + 1)
                },
            },
        )
        self.assertEqual(st, 413)
        self.assertIn("error", json.loads(raw))

        # 3. Serialized state_json > 128 KiB even when raw body is just under 128 KiB -> 413
        # Construct a compact JSON payload whose raw size is < 128 KiB, so adding server
        # metadata (id, ownerEmail, createdAt, updatedAt + default json spacing) pushes
        # state_json over MAX_SAVE_STATE_BYTES.
        drafts_near_limit = {
            "trial-01": "a" * (30 * 1024),
            "trial-02": "b" * (30 * 1024),
            "trial-03": "c" * (30 * 1024),
            "trial-04": "d" * (30 * 1024),
            "trial-05": "e" * (8 * 1024 - 160),
        }
        compact_raw = json.dumps(
            {"heroName": "Rowan", "trialDrafts": drafts_near_limit},
            separators=(",", ":"),
        )
        self.assertLessEqual(len(compact_raw.encode("utf-8")), pyria_app.MAX_SAVE_BODY_BYTES)
        st, _, raw = self._request("POST", "/api/saves", compact_raw)
        self.assertEqual(st, 413)
        self.assertIn("Save state exceeds maximum size", json.loads(raw)["error"])

        # Create a valid save for PUT and attempt tests
        st, _, raw = self._request("POST", "/api/saves", {"heroName": "Rowan"})
        self.assertEqual(st, 201)
        save_id = json.loads(raw)["save"]["id"]

        # Oversized PUT (> 128 KiB raw body) -> 413
        st, _, _ = self._request(
            "PUT",
            f"/api/saves/{save_id}",
            {"heroName": "Rowan", "trialDrafts": big_drafts},
        )
        self.assertEqual(st, 413)

        # Single oversized draft (> 32 KiB UTF-8, total body < 128 KiB) on PUT is truncated
        # rather than rejecting the whole progress save (prevents silent data loss)
        oversized_draft = "é" * (17 * 1024)  # 34 KiB UTF-8 (~102 KiB ASCII-escaped JSON)
        st, _, raw = self._request(
            "PUT",
            f"/api/saves/{save_id}",
            {
                "heroName": "Rowan",
                "byteShards": 77,
                "solvedTrials": ["trial-01-01"],
                "trialDrafts": {"trial-01-02": oversized_draft},
            },
        )
        self.assertEqual(st, 200)
        saved_after_trunc = json.loads(raw)["save"]
        self.assertEqual(saved_after_trunc["byteShards"], 77)
        self.assertEqual(saved_after_trunc["solvedTrials"], ["trial-01-01"])
        trunc_draft = saved_after_trunc["trialDrafts"]["trial-01-02"]
        self.assertLessEqual(
            len(trunc_draft.encode("utf-8")), pyria_app.MAX_ATTEMPT_CODE_BYTES
        )
        self.assertGreater(len(trunc_draft), 0)

        # Lone Unicode surrogate and NUL byte in trialDrafts or attempt code -> 400 (never 500/crash)
        for bad_raw_json in (
            '{"heroName":"Rowan","trialDrafts":{"t1":"\\uD800"}}',
            '{"heroName":"Rowan","trialDrafts":{"t1":"abc\\u0000def"}}',
        ):
            st, _, raw = self._request("POST", "/api/saves", bad_raw_json)
            self.assertEqual(st, 400)
            self.assertIn("error", json.loads(raw))
            st, _, raw = self._request("PUT", f"/api/saves/{save_id}", bad_raw_json)
            self.assertEqual(st, 400)
            self.assertIn("error", json.loads(raw))

        for bad_attempt_json in (
            '{"trialId":"trial-01-01","passed":true,"code":"\\uD800"}',
            '{"trialId":"trial-01-01","passed":true,"code":"print(1)\\u0000"}',
        ):
            st, _, raw = self._request(
                "POST", f"/api/saves/{save_id}/attempts", bad_attempt_json
            )
            self.assertEqual(st, 400)
            self.assertIn("error", json.loads(raw))

        # 4. Attempt code cap: exactly 32 KiB succeeds, 32 KiB + 1 byte -> 413
        exact_code = "p" * pyria_app.MAX_ATTEMPT_CODE_BYTES
        st, _, raw = self._request(
            "POST",
            f"/api/saves/{save_id}/attempts",
            {"trialId": "trial-01-01", "passed": True, "hintsUsed": 0, "code": exact_code},
        )
        self.assertEqual(st, 201)

        too_long_code = "p" * (pyria_app.MAX_ATTEMPT_CODE_BYTES + 1)
        st, _, raw = self._request(
            "POST",
            f"/api/saves/{save_id}/attempts",
            {"trialId": "trial-01-01", "passed": False, "hintsUsed": 0, "code": too_long_code},
        )
        self.assertEqual(st, 413)
        self.assertIn("Attempt code exceeds maximum length", json.loads(raw)["error"])

        # Attempt field validation (bad trialId, bool hintsUsed, non-string code) -> 400
        for bad_attempt in (
            {"trialId": "trial\x00bad", "passed": True},
            {"trialId": "t" * (pyria_app.MAX_TRIAL_ID_LEN + 1), "passed": True},
            {"trialId": 123, "passed": True},
            {"trialId": "trial-01-01", "passed": True, "hintsUsed": True},
            {"trialId": "trial-01-01", "passed": True, "code": ["not", "str"]},
        ):
            st, _, raw = self._request(
                "POST", f"/api/saves/{save_id}/attempts", bad_attempt
            )
            self.assertEqual(st, 400, f"Expected 400 for {bad_attempt!r}, got {st}")
            self.assertIn("error", json.loads(raw))

    def test_save_quotas_and_attempt_event_pruning(self) -> None:
        os.environ["PYRIA_ADMIN_EMAILS"] = "admin@example.com"
        user_a_hdr = {"Cf-Access-Authenticated-User-Email": "alice@example.com"}
        user_b_hdr = {"Cf-Access-Authenticated-User-Email": "bob@example.com"}
        admin_hdr = {"Cf-Access-Authenticated-User-Email": "admin@example.com"}

        with tempfile.TemporaryDirectory() as tmp:
            srv = create_server(
                host="127.0.0.1",
                port=0,
                root_dir=REPO_ROOT,
                db_path=Path(tmp) / "quota.sqlite3",
                quiet=True,
                dev_mode=False,
                max_saves_per_account=2,
                max_total_saves=3,
                max_attempt_code_rows=3,
                max_attempts_per_save=5,
                max_events_per_save=5,
            )
            host, port = srv.server_address[:2]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            try:
                def req(
                    method: str,
                    path: str,
                    body: dict | None = None,
                    extra_headers: dict[str, str] | None = None,
                ):
                    conn = http.client.HTTPConnection(host, port, timeout=5)
                    headers = dict(extra_headers or {})
                    payload = None
                    if body is not None:
                        headers["Content-Type"] = "application/json"
                        payload = json.dumps(body).encode("utf-8")
                    conn.request(method, path, body=payload, headers=headers)
                    r = conn.getresponse()
                    data = r.read()
                    conn.close()
                    return r.status, data

                # 1. Per-account save cap (max_saves_per_account=2)
                st, raw = req("POST", "/api/saves", {"heroName": "Alice1"}, user_a_hdr)
                self.assertEqual(st, 201)
                alice1_id = json.loads(raw)["save"]["id"]

                st, raw = req("POST", "/api/saves", {"heroName": "Alice2"}, user_a_hdr)
                self.assertEqual(st, 201)
                alice2_id = json.loads(raw)["save"]["id"]

                st, raw = req("POST", "/api/saves", {"heroName": "Alice3"}, user_a_hdr)
                self.assertEqual(st, 429)
                self.assertIn("per account", json.loads(raw)["error"])

                # 2. Global save cap (max_total_saves=3)
                st, raw = req("POST", "/api/saves", {"heroName": "Bob1"}, user_b_hdr)
                self.assertEqual(st, 201)
                bob1_id = json.loads(raw)["save"]["id"]

                st, raw = req("POST", "/api/saves", {"heroName": "Bob2"}, user_b_hdr)
                self.assertEqual(st, 429)
                self.assertIn("total saves", json.loads(raw)["error"])

                # Deleting a save frees quota
                st, _ = req("DELETE", f"/api/saves/{alice2_id}", None, user_a_hdr)
                self.assertEqual(st, 200)
                st, _ = req("POST", "/api/saves", {"heroName": "Alice3"}, user_a_hdr)
                self.assertEqual(st, 201)

                # 3. Attempt & activity_events pruning per save (cap = 5)
                attempt_ids = []
                for i in range(8):
                    st, raw = req(
                        "POST",
                        f"/api/saves/{alice1_id}/attempts",
                        {
                            "trialId": f"trial-{i:02d}",
                            "passed": (i % 2 == 0),
                            "hintsUsed": i,
                            "code": f"print({i})",
                        },
                        user_a_hdr,
                    )
                    self.assertEqual(st, 201)
                    attempt_ids.append(json.loads(raw)["attemptId"])

                st, raw = req("GET", f"/api/saves/{alice1_id}/attempts", None, user_a_hdr)
                self.assertEqual(st, 200)
                attempts = json.loads(raw)["attempts"]
                self.assertEqual(len(attempts), 5)
                # Oldest 3 pruned by hard cap (5); newest 5 kept
                by_id = {a["id"]: a for a in attempts}
                self.assertEqual(sorted(by_id.keys()), attempt_ids[-5:])
                # Code retention window (3): newest 3 keep code, older 2 have code blanked
                for aid in attempt_ids[-3:]:
                    self.assertTrue(by_id[aid]["code"].startswith("print("))
                for aid in attempt_ids[-5:-3]:
                    self.assertEqual(by_id[aid]["code"], "")

                # Dashboard totals reflect all 5 retained attempt rows (including code-blanked ones)
                st, raw = req("GET", "/api/builder/progress", None, admin_hdr)
                self.assertEqual(st, 200)
                prog = json.loads(raw)
                alice1_prog = next(
                    s for s in prog["saves"] if s["id"] == alice1_id
                )
                self.assertEqual(alice1_prog["stats"]["attemptCount"], 5)
                self.assertEqual(alice1_prog["stats"]["passCount"], 2)  # i=4,6
                self.assertEqual(alice1_prog["stats"]["totalHintsUsed"], 3 + 4 + 5 + 6 + 7)

                # Check activity_events pruned to 5 for alice1_id while bob1_id event remains intact
                st, raw = req(
                    "GET", "/api/builder/activity?since=0&limit=200", None, admin_hdr
                )
                self.assertEqual(st, 200)
                events = json.loads(raw)["events"]
                alice1_events = [e for e in events if e["saveId"] == alice1_id]
                bob1_events = [e for e in events if e["saveId"] == bob1_id]
                self.assertEqual(len(alice1_events), 5)
                self.assertEqual(
                    [e["trialId"] for e in alice1_events],
                    ["trial-03", "trial-04", "trial-05", "trial-06", "trial-07"],
                )
                self.assertEqual(len(bob1_events), 1)
                self.assertEqual(bob1_events[0]["eventType"], "hero_created")

                # Deleting alice1_id removes its activity_events (prevents orphaned storage abuse)
                st, _ = req("DELETE", f"/api/saves/{alice1_id}", None, user_a_hdr)
                self.assertEqual(st, 200)
                st, raw = req(
                    "GET", "/api/builder/activity?since=0&limit=200", None, admin_hdr
                )
                self.assertEqual(st, 200)
                events_after_del = json.loads(raw)["events"]
                self.assertEqual(
                    [e for e in events_after_del if e["saveId"] == alice1_id], []
                )
                self.assertEqual(
                    len([e for e in events_after_del if e["saveId"] == bob1_id]), 1
                )
            finally:
                srv.shutdown()
                srv.server_close()
                t.join(timeout=3)

    def test_api_me_local_mode_and_console_route_alias(self) -> None:
        # In dev_mode with no PYRIA_ADMIN_EMAILS, /api/me returns mode="local" and admin role
        status, headers, raw = self._request("GET", "/api/me")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        me = json.loads(raw)
        self.assertEqual(me["mode"], "local")
        self.assertTrue(me["isAdmin"])
        self.assertEqual(me["auth"]["role"], "admin")
        self.assertTrue(me["auth"]["isAdmin"])
        self.assertFalse(me["auth"]["googleOAuthEnabled"])
        self.assertIsNone(me["auth"]["heroSaveId"])

        # /console and /console/ serve the builder/console HTML page for admins
        for route in ("/console", "/console/"):
            st, hdrs, body = self._request("GET", route)
            self.assertEqual(st, 200, f"Expected 200 for {route}")
            self.assertIn("text/html", hdrs.get("content-type", ""))
            self.assertIn(b"builder-app", body)

        # Non-admin user is denied /console with 403 and gets role="parent" in /api/me
        os.environ["PYRIA_ADMIN_EMAILS"] = "admin@example.com"
        kid_hdr = {"Cf-Access-Authenticated-User-Email": "player@example.com"}
        st, _, raw = self._request("GET", "/api/me", extra_headers=kid_hdr)
        self.assertEqual(st, 200)
        me_player = json.loads(raw)
        self.assertEqual(me_player["mode"], "local")
        self.assertFalse(me_player["isAdmin"])
        self.assertEqual(me_player["auth"]["role"], "player")
        self.assertEqual(me_player["auth"]["parentEmail"], "player@example.com")

        st, _, _ = self._request("GET", "/console", extra_headers=kid_hdr)
        self.assertEqual(st, 403)

    def test_save_onboarding_preferences_validation_and_persistence(self) -> None:
        # 1. Creating a hero with calibrated onboarding preferences persists them
        prefs = {
            "difficulty": "explorer",
            "showRawTracebacks": False,
            "maxPipHints": 3,
        }
        st, _, raw = self._request(
            "POST",
            "/api/saves",
            {"heroName": "NewCoder", "preferences": prefs},
        )
        self.assertEqual(st, 201)
        created = json.loads(raw)["save"]
        self.assertEqual(created["preferences"], prefs)
        save_id = created["id"]

        # 2. Gameplay PUT without preferences preserves the existing onboarding preferences
        st, _, raw = self._request(
            "PUT",
            f"/api/saves/{save_id}",
            {"heroName": "NewCoder", "byteShards": 50},
        )
        self.assertEqual(st, 200)
        updated = json.loads(raw)["save"]
        self.assertEqual(updated["byteShards"], 50)
        self.assertEqual(updated["preferences"], prefs)

        # 3. Invalid preferences are rejected with 400
        for bad_prefs in (
            "explorer",
            {"difficulty": "expert"},
            {"showRawTracebacks": "yes"},
            {"maxPipHints": True},
            {"maxPipHints": 99},
        ):
            st, _, _ = self._request(
                "POST",
                "/api/saves",
                {"heroName": "BadPrefHero", "preferences": bad_prefs},
            )
            self.assertEqual(st, 400, f"Expected 400 for preferences={bad_prefs!r}")


if __name__ == "__main__":
    unittest.main()
