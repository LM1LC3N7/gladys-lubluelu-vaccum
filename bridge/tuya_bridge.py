#!/usr/bin/env python3
"""Tuya "device sharing" bridge process.

Thin adapter around the OFFICIAL Tuya package `tuya-device-sharing-sdk`
(PyPI: tuya-device-sharing-sdk, import name `tuya_sharing`, MIT, maintained
by Tuya) — the same SDK the official Home Assistant Tuya integration uses.
It implements Tuya's "Device Sharing" feature (normally used to share a
device with a family member's app account) as a QR-code login: the end
user scans a QR with the Smart Life/Tuya Smart app they ALREADY use for the
vacuum, taps "Confirm login", and this bridge gets full device access
(local_key + DP schema + LAN IP) for every device on that account — no
Tuya IoT Platform developer account, no Access ID/Secret, no per-device
Device ID to copy.

No Node.js/JavaScript port of this SDK exists (confirmed: it is Python-only,
and its request signing uses AES-GCM + HMAC machinery specific to this one
Tuya API surface) — see the project README for why this runs as a subprocess
instead of being reimplemented in JS, exactly like gladys-hydro-quebec's
bridge/hq_bridge.py does for the (also Python-only) `hydroqc` library.

CLIENT_ID/SCHEME below are Home Assistant's own PUBLIC device-sharing app
registration (not a secret — published in Home Assistant's own source and
reused openly by community tools such as vineetchoudhary/tuya-local-key):
the QR/login itself is what the user actually authorizes, these two values
only say which registered app the login belongs to.

Protocol: one JSON object per line on stdin, e.g. {"id": 1, "cmd": "qr_start",
"user_code": "..."}. One JSON object per line on stdout, either
{"id": 1, "ok": true, "result": ...} or {"id": 1, "ok": false, "error": "..."},
or - unsolicited, no "id" - a live device update pushed by Tuya's MQTT
broker once `discover` ran: {"event": "status", "device_id": "...",
"status": {"code": value, ...}} or {"event": "online", "device_id": "...",
"online": true}. That push is what keeps Gladys up to date when no LAN
session is open (no LAN IP known, or the local session is down).
All logging goes to stderr - stdout is reserved for the protocol only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import traceback
from typing import Any

from tuya_sharing import LoginControl, Manager, SharingDeviceListener, SharingTokenListener
from tuya_sharing.exceptions import ApiRequestException

logging.basicConfig(
    stream=sys.stderr,
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("tuya_bridge")

# See the module docstring: Home Assistant's own public device-sharing app
# registration, not a secret.
CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEME = "haauthorize"
# Prefix of the QR content itself (what the Smart Life app's camera scanner
# recognizes) — deliberately NOT a real `scheme://` URI (Tuya uses `--`, not
# `://`), so it is unusable as a tappable/openable link and MUST be rendered
# as an actual scannable barcode image. "smartlife" works for both the Smart
# Life and Tuya Smart apps in practice; exposed as an env var in case a given
# account only recognizes "tuyaSmart".
QR_URL_SCHEME = os.environ.get("TUYA_QR_SCHEME", "smartlife")

TOKEN_FIELDS = ("t", "uid", "expire_time", "access_token", "refresh_token")

# What Tuya answers once the refresh_token is no longer valid: 1010 "token is
# expired" on the refresh itself, then -9999999 "sign invalid" on every call
# (the SDK signs each request with the dead refresh_token). Only a new QR
# login gets out of it.
EXPIRED_MARKERS = ("token is expired", "token invalid", "sign invalid")


class SessionExpired(RuntimeError):
    """The Smart Life session is dead: Node asks the user to scan the QR again."""


def _is_expired(exc: Exception) -> bool:
    if not isinstance(exc, ApiRequestException):
        return False
    return str(exc.error_code) == "1010" or any(m in str(exc.error_message).lower() for m in EXPIRED_MARKERS)

# stdout is written from two threads: the request loop, and the SDK's MQTT
# thread (live updates) - one lock keeps every line whole.
_stdout_lock = threading.Lock()


def _write(message: dict[str, Any]) -> None:
    line = json.dumps(message, default=str) + "\n"
    with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


class BridgeState:
    """Holds the single active Manager (one Tuya account) and its session."""

    def __init__(self) -> None:
        self.manager: Manager | None = None
        self.session: dict[str, Any] | None = None
        self.push_started = False

    def replace_manager(self, manager: Manager | None, session: dict[str, Any] | None) -> None:
        """Swap the active account, stopping the previous one's MQTT push."""
        if self.manager is not None and getattr(self.manager, "mq", None) is not None:
            try:
                self.manager.mq.stop()
            except Exception:  # best effort on the way out
                logger.debug("Stopping the previous MQTT push failed", exc_info=True)
        self.manager = manager
        self.session = session
        self.push_started = False


class _StatusForwarder(SharingDeviceListener):
    """Relays the SDK's live device updates (Tuya MQTT push) to Node as
    unsolicited event lines - see the module docstring."""

    def update_device(
        self, device: Any, updated_status_properties: list[str] | None = None, dp_timestamps: dict | None = None
    ) -> None:
        if updated_status_properties:
            status = {code: device.status.get(code) for code in updated_status_properties}
            _write({"event": "status", "device_id": device.id, "status": status})
        else:
            _write({"event": "online", "device_id": device.id, "online": bool(device.online)})

    def add_device(self, device: Any) -> None:
        _write({"event": "added", "device_id": device.id})

    def remove_device(self, device_id: str) -> None:
        _write({"event": "removed", "device_id": device_id})


class _TokenSaver(SharingTokenListener):
    """Keeps `state.session["token_info"]` in sync with the SDK's own token
    refresh (CustomerApi.refresh_access_token_if_need() calls this whenever
    it silently refreshes the access/refresh token) — without it, a rotated
    refresh_token would only ever live in the SDK's in-memory CustomerApi,
    lost on the next container restart even though Node persists
    `get_session`'s result to survive restarts.
    """

    def __init__(self, state: BridgeState) -> None:
        self.state = state

    def update_token(self, token_info: dict[str, Any]) -> None:
        if self.state.session is None:
            return
        # A new dict, never an in-place edit: this runs on the MQTT thread too,
        # while the request loop may be serializing the current session.
        session = {**self.state.session, "token_info": {k: token_info.get(k) for k in TOKEN_FIELDS}}
        self.state.session = session
        # Tuya rotates the refresh_token on every refresh and the old one stops
        # working: Node must persist this one now, not at its next hourly
        # refresh, or a restart in between brings back a dead token.
        _write({"event": "session", "session": session})


state = BridgeState()


def _build_manager(session: dict[str, Any]) -> Manager:
    manager = Manager(
        session.get("client_id", CLIENT_ID),
        session["user_code"],
        session["terminal_id"],
        session["endpoint"],
        session["token_info"],
        _TokenSaver(state),
    )
    manager.add_device_listener(_StatusForwarder())
    return manager


def _start_push() -> None:
    """Subscribe to Tuya's MQTT push for every device of the account, once
    per account. refresh_mq() only covers devices flagged `set_up` (Home
    Assistant flags them after creating its entities): every device here."""
    if state.manager is None or state.push_started:
        return
    for device in state.manager.device_map.values():
        device.set_up = True
    try:
        state.manager.refresh_mq()
        state.push_started = True
        logger.info("Live updates (Tuya MQTT push) started")
    except Exception as exc:  # noqa: BLE001 - push is a bonus, polling still works
        logger.warning("Could not start the Tuya MQTT push: %s", exc)


def cmd_qr_start(params: dict[str, Any]) -> dict[str, Any]:
    user_code = params["user_code"]
    scheme = params.get("scheme") or QR_URL_SCHEME
    resp = LoginControl().qr_code(CLIENT_ID, SCHEME, user_code)
    if not resp.get("success"):
        raise RuntimeError(f"Could not start QR login [{resp.get('code')}]: {resp.get('msg')}")
    token = resp["result"]["qrcode"]
    return {"token": token, "content": f"{scheme}--qrLogin?token={token}"}


def cmd_qr_poll(params: dict[str, Any]) -> dict[str, Any]:
    """One non-blocking login check. Tuya returns `success: false` for both
    "not confirmed yet" and a genuine failure (expired token, wrong user
    code...) with no documented way to tell them apart from this endpoint
    alone — same limitation the reference community tools work under, so
    every non-success is reported as "pending"; index.js enforces the
    overall QR-expiry timeout on the Node side (see src/tuya/deviceSharing.js).
    """
    ok, result = LoginControl().login_result(params["token"], CLIENT_ID, params["user_code"])
    if not ok:
        return {"status": "pending"}

    session = {
        "client_id": CLIENT_ID,
        "user_code": params["user_code"],
        "terminal_id": result.get("terminal_id"),
        "endpoint": result.get("endpoint") or result.get("end_point"),
        "token_info": {k: result.get(k) for k in TOKEN_FIELDS},
    }
    state.replace_manager(_build_manager(session), session)
    logger.info("Device sharing login succeeded for user_code=%s", params["user_code"])
    return {"status": "success", "session": session}


def _token_time(session: dict[str, Any] | None) -> int:
    try:
        return int(((session or {}).get("token_info") or {}).get("t") or 0)
    except (TypeError, ValueError):
        return 0


def _same_account(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    if not a or not b:
        return False
    uid_a = (a.get("token_info") or {}).get("uid")
    uid_b = (b.get("token_info") or {}).get("uid")
    return a.get("user_code") == b.get("user_code") and bool(uid_a) and uid_a == uid_b


def cmd_restore_session(params: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the Manager from a session Node persisted (gladys.setConfig)
    across a container restart — no fresh QR scan needed.

    Node also replays it on every reconnection to Gladys, while this process
    may still hold a newer token of the same account (rotated since Node last
    saved it). Replacing it would bring back a refresh_token Tuya already
    revoked, so the newer one is kept and handed back for Node to persist.
    """
    session = params["session"]
    if _same_account(state.session, session) and _token_time(state.session) >= _token_time(session):
        return {"success": True, "kept": True, "session": state.session}
    state.replace_manager(_build_manager(session), session)
    return {"success": True, "kept": False, "session": session}


def cmd_get_session(_params: dict[str, Any]) -> dict[str, Any] | None:
    """Current session (possibly with a rotated token_info) for Node to
    re-persist — see _TokenSaver above."""
    return state.session


def cmd_logout(_params: dict[str, Any]) -> dict[str, Any]:
    state.replace_manager(None, None)
    return {"success": True}


def _serialize_device(device: Any) -> dict[str, Any]:
    dps_by_code: dict[str, Any] = {}
    for dp_id, strategy in (device.local_strategy or {}).items():
        code = strategy.get("status_code") if isinstance(strategy, dict) else None
        if not code:
            # One odd DP must not fail the discovery of every device.
            logger.debug("Skipping DP %s of %s: no status_code", dp_id, device.id)
            continue
        spec = device.status_range.get(code) or device.function.get(code)
        dps_by_code[code] = {
            "dpId": dp_id,
            "type": spec.type if spec else "Unknown",
            "values": spec.values if spec else "{}",
        }
    return {
        "id": device.id,
        "name": device.name,
        "local_key": device.local_key,
        "category": device.category,
        "ip": device.ip,
        "online": device.online,
        "support_local": device.support_local,
        "dps": dps_by_code,
    }


def _call_tuya(fn: Any, *args: Any) -> Any:
    """Run one SDK call, turning a dead session into SessionExpired. The MQTT
    push is stopped then: with the same dead token it would only retry."""
    try:
        return fn(*args)
    except ApiRequestException as exc:
        if not _is_expired(exc):
            raise
        if state.manager is not None and getattr(state.manager, "mq", None) is not None:
            try:
                state.manager.mq.stop()
            except Exception:  # best effort
                logger.debug("Stopping the MQTT push failed", exc_info=True)
        state.push_started = False
        raise SessionExpired(f"Smart Life session expired, scan the QR code again ({exc})") from exc


def cmd_discover(_params: dict[str, Any]) -> list[dict[str, Any]]:
    if state.manager is None:
        raise RuntimeError("No active device-sharing session: call qr_start/qr_poll or restore_session first")
    _call_tuya(state.manager.update_device_cache)
    devices = []
    for device in state.manager.device_map.values():
        try:
            devices.append(_serialize_device(device))
        except Exception as exc:  # noqa: BLE001 - skip one device, keep the others
            logger.error("Could not read device %s: %s", getattr(device, "id", "?"), exc)
    logger.info("Discovered %d device(s) via device sharing", len(devices))
    _start_push()
    return devices


def cmd_send_command(params: dict[str, Any]) -> dict[str, Any]:
    if state.manager is None:
        raise RuntimeError("No active device-sharing session")
    _call_tuya(state.manager.send_commands, params["device_id"], [{"code": params["code"], "value": params["value"]}])
    return {"success": True}


def cmd_get_status(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Current DP values for one device, `[{code, value}]` — mirrors the
    classic Cloud API's GET .../status shape (src/tuya/cloud.js#getStatus) so
    runTestConnectionAction() works the same regardless of onboarding method.
    Refreshes the device cache on a miss (e.g. a device seen once but not
    since a container restart) rather than failing outright.
    """
    if state.manager is None:
        raise RuntimeError("No active device-sharing session")
    device_id = params["device_id"]
    device = state.manager.device_map.get(device_id)
    if device is None:
        _call_tuya(state.manager.update_device_cache)
        device = state.manager.device_map.get(device_id)
    if device is None:
        raise RuntimeError(f"Unknown device {device_id}")
    return [{"code": code, "value": value} for code, value in device.status.items()]


COMMANDS = {
    "qr_start": cmd_qr_start,
    "qr_poll": cmd_qr_poll,
    "restore_session": cmd_restore_session,
    "get_session": cmd_get_session,
    "logout": cmd_logout,
    "discover": cmd_discover,
    "send_command": cmd_send_command,
    "get_status": cmd_get_status,
}


def handle_request(line: str) -> None:
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        logger.error("Bad JSON on stdin: %s", exc)
        return

    request_id = request.get("id")
    cmd = request.get("cmd")
    handler = COMMANDS.get(cmd)
    response: dict[str, Any]
    if handler is None:
        response = {"id": request_id, "ok": False, "error": f"Unknown command {cmd!r}"}
    else:
        try:
            result = handler(request)
            response = {"id": request_id, "ok": True, "result": result}
        except SessionExpired as exc:
            # Expected until the user logs in again: one line, no traceback.
            logger.warning("Command %s failed: %s", cmd, exc)
            response = {"id": request_id, "ok": False, "error": str(exc), "code": "SESSION_EXPIRED"}
        except Exception as exc:  # noqa: BLE001 - relayed to Node as a plain error string
            logger.error("Command %s failed: %s\n%s", cmd, exc, traceback.format_exc())
            response = {"id": request_id, "ok": False, "error": str(exc)}

    _write(response)


def main() -> None:
    logger.info("Tuya device-sharing bridge ready")
    for line in sys.stdin:
        stripped = line.strip()
        if stripped:
            handle_request(stripped)


if __name__ == "__main__":
    main()
