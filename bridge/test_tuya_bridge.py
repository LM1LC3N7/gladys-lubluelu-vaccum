"""Tests of the bridge's session handling, against the real
tuya-device-sharing-sdk (installed from requirements.txt). Run with
`python3 -m unittest discover -s bridge`."""

from __future__ import annotations

import io
import json
import logging
import sys
import unittest
from typing import Any
from unittest import mock

import tuya_bridge as b
from tuya_sharing.exceptions import ApiRequestException

SIGN_INVALID = ApiRequestException(error_code=-9999999, error_message="sign invalid")


def session(user_code: str = "C", uid: str = "u", t: int = 1, refresh: str = "r1", terminal: str = "term") -> dict[str, Any]:
    return {
        "user_code": user_code,
        "terminal_id": terminal,
        "endpoint": "https://example.invalid",
        "token_info": {"uid": uid, "t": t, "refresh_token": refresh, "access_token": "a", "expire_time": 7200},
    }


class BridgeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.out = io.StringIO()
        patcher = mock.patch.object(b.sys, "stdout", self.out)
        patcher.start()
        self.addCleanup(patcher.stop)
        b.state.manager = None
        b.state.session = None
        b.state.push_started = False

    def lines(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.out.getvalue().splitlines() if line]


class ExpiryDetection(BridgeTestCase):
    def test_markers(self) -> None:
        self.assertTrue(b._is_expired(SIGN_INVALID))
        self.assertTrue(b._is_expired(ApiRequestException(error_code=1010, error_message="token is expired")))
        self.assertFalse(b._is_expired(ApiRequestException(error_code=1106, error_message="permission deny")))
        self.assertFalse(b._is_expired(RuntimeError("sign invalid")))

    def test_expired_discover_answers_session_expired_and_stops_push(self) -> None:
        mq = mock.Mock()
        b.state.manager = mock.Mock(mq=mq, device_map={})
        b.state.manager.update_device_cache.side_effect = SIGN_INVALID
        b.state.session = session()
        b.state.push_started = True
        b.handle_request(json.dumps({"id": 7, "cmd": "discover"}))
        response = self.lines()[-1]
        self.assertEqual(response["code"], "SESSION_EXPIRED")
        self.assertFalse(response["ok"])
        mq.stop.assert_called_once()
        self.assertFalse(b.state.push_started)

    def test_other_api_errors_are_not_an_expiry(self) -> None:
        b.state.manager = mock.Mock(device_map={})
        b.state.manager.update_device_cache.side_effect = ApiRequestException(error_code=500, error_message="boom")
        b.handle_request(json.dumps({"id": 8, "cmd": "discover"}))
        response = self.lines()[-1]
        self.assertNotIn("code", response)
        self.assertIn("boom", response["error"])

    def test_retried_once_when_the_tokens_rotated_during_the_call(self) -> None:
        b.state.session = session(refresh="r1")
        calls = []

        def update_device_cache() -> None:
            calls.append(1)
            if len(calls) == 1:
                b.state.session = session(refresh="r2", t=2)  # MQTT thread renewal
                raise SIGN_INVALID

        b.state.manager = mock.Mock(device_map={}, update_device_cache=update_device_cache)
        self.assertEqual(b.cmd_discover({}), [])
        self.assertEqual(len(calls), 2)

    def test_not_retried_when_the_tokens_did_not_change(self) -> None:
        b.state.session = session()
        b.state.manager = mock.Mock(device_map={})
        b.state.manager.update_device_cache.side_effect = SIGN_INVALID
        with self.assertRaises(b.SessionExpired):
            b.cmd_discover({})
        self.assertEqual(b.state.manager.update_device_cache.call_count, 1)


class RestoreSession(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.built: list[dict[str, Any]] = []
        patcher = mock.patch.object(b, "_build_manager", lambda s: self.built.append(s) or mock.Mock(mq=None))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_newer_token_of_the_same_account_is_kept(self) -> None:
        b.cmd_restore_session({"session": session(t=2, refresh="r2")})
        result = b.cmd_restore_session({"session": session(t=1, refresh="r1")})
        self.assertTrue(result["kept"])
        self.assertEqual(result["session"]["token_info"]["refresh_token"], "r2")
        self.assertEqual(len(self.built), 1)

    def test_newer_saved_token_replaces(self) -> None:
        b.cmd_restore_session({"session": session(t=1)})
        result = b.cmd_restore_session({"session": session(t=3, refresh="r3")})
        self.assertFalse(result["kept"])
        self.assertEqual(b.state.session["token_info"]["refresh_token"], "r3")

    def test_other_account_replaces(self) -> None:
        b.cmd_restore_session({"session": session(t=5)})
        other = session(user_code="D", uid="v", t=0)
        self.assertFalse(b.cmd_restore_session({"session": other})["kept"])
        self.assertIs(b.state.session, other)

    def test_without_uid_the_terminal_id_identifies_the_account(self) -> None:
        b.cmd_restore_session({"session": session(uid="", t=2)})
        self.assertTrue(b.cmd_restore_session({"session": session(uid="", t=1)})["kept"])
        self.assertFalse(b.cmd_restore_session({"session": session(uid="", t=1, terminal="other")})["kept"])


class TokenSaver(BridgeTestCase):
    def test_renewal_is_pushed_to_node_without_touching_the_old_dict(self) -> None:
        owner = object()
        old = session(refresh="r2")
        b.state.manager, b.state.session = owner, old
        saver = b._TokenSaver(b.state)
        saver.owner = owner
        saver.update_token({"t": 3, "uid": "u", "expire_time": 7200, "access_token": "a3", "refresh_token": "r3", "x": 1})
        (event,) = self.lines()
        self.assertEqual(event["event"], "session")
        self.assertEqual(event["session"]["token_info"]["refresh_token"], "r3")
        self.assertNotIn("x", event["session"]["token_info"])
        self.assertEqual(old["token_info"]["refresh_token"], "r2")

    def test_renewal_of_a_replaced_manager_is_dropped(self) -> None:
        stale_owner = object()
        saver = b._TokenSaver(b.state)
        saver.owner = stale_owner
        b.state.manager, b.state.session = object(), session(user_code="OTHER", uid="v")
        saver.update_token({"t": 9, "uid": "u", "refresh_token": "stale"})
        self.assertEqual(self.lines(), [])
        self.assertEqual(b.state.session["user_code"], "OTHER")
        self.assertEqual(b.state.session["token_info"]["uid"], "v")

    def test_build_manager_binds_the_saver_to_its_manager(self) -> None:
        manager = b._build_manager(session())
        self.assertIs(manager.customer_api.token_listener.owner, manager)


class Redaction(unittest.TestCase):
    def test_refresh_token_in_a_url_is_masked(self) -> None:
        text = "Max retries exceeded with url: /v1.0/m/token/abcDEF123 (Caused by ...)"
        self.assertEqual(b._redact(text), "Max retries exceeded with url: /v1.0/m/token/*** (Caused by ...)")

    def test_token_fields_are_masked(self) -> None:
        text = "ret = {'accessToken': 'AAA', 'refreshToken': 'RRR', 'local_key': 'KKK', 'uid': 'u'}"
        redacted = b._redact(text)
        for secret in ("AAA", "RRR", "KKK"):
            self.assertNotIn(secret, redacted)
        self.assertIn("'uid': 'u'", redacted)

    def test_sdk_log_lines_reach_stderr_masked_and_once(self) -> None:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(b._RedactSecrets())
        root = logging.getLogger()
        root.addHandler(handler)
        try:
            logging.getLogger("tuya_sharing").error("net work error = url: /v1.0/m/token/SECRET1")
            logging.getLogger("tuya_sharing").debug("response ret = {'refreshToken': 'SECRET2'}")
        finally:
            root.removeHandler(handler)
        self.assertNotIn("SECRET1", stream.getvalue())
        self.assertNotIn("SECRET2", stream.getvalue())
        self.assertEqual(stream.getvalue().count("net work error"), 1)
        self.assertEqual(logging.getLogger("tuya_sharing").handlers, [])
        self.assertGreaterEqual(logging.getLogger("urllib3").level, logging.INFO)

    def test_error_sent_to_node_is_masked(self) -> None:
        out = io.StringIO()
        b.state.manager = mock.Mock(device_map={})
        b.state.manager.update_device_cache.side_effect = OSError("url: /v1.0/m/token/SECRET3")
        with mock.patch.object(b.sys, "stdout", out), mock.patch.object(b.sys, "stderr", io.StringIO()):
            b.handle_request(json.dumps({"id": 1, "cmd": "discover"}))
        self.assertNotIn("SECRET3", out.getvalue())


if __name__ == "__main__":
    unittest.main()
