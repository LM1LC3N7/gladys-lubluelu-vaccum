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
{"id": 1, "ok": true, "result": ...} or {"id": 1, "ok": false, "error": "..."}.
All logging goes to stderr - stdout is reserved for protocol responses only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from typing import Any

from tuya_sharing import LoginControl, Manager, SharingTokenListener

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


class BridgeState:
    """Holds the single active Manager (one Tuya account) and its session."""

    def __init__(self) -> None:
        self.manager: Manager | None = None
        self.session: dict[str, Any] | None = None


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
        if self.state.session is not None:
            self.state.session["token_info"] = {k: token_info.get(k) for k in TOKEN_FIELDS}


state = BridgeState()


def _build_manager(session: dict[str, Any]) -> Manager:
    return Manager(
        session.get("client_id", CLIENT_ID),
        session["user_code"],
        session["terminal_id"],
        session["endpoint"],
        session["token_info"],
        _TokenSaver(state),
    )


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
    state.manager = _build_manager(session)
    state.session = session
    logger.info("Device sharing login succeeded for user_code=%s", params["user_code"])
    return {"status": "success", "session": session}


def cmd_restore_session(params: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the Manager from a session Node persisted (gladys.setConfig)
    across a container restart — no fresh QR scan needed."""
    session = params["session"]
    state.manager = _build_manager(session)
    state.session = session
    return {"success": True}


def cmd_get_session(_params: dict[str, Any]) -> dict[str, Any] | None:
    """Current session (possibly with a rotated token_info) for Node to
    re-persist — see _TokenSaver above."""
    return state.session


def cmd_logout(_params: dict[str, Any]) -> dict[str, Any]:
    state.manager = None
    state.session = None
    return {"success": True}


def _serialize_device(device: Any) -> dict[str, Any]:
    dps_by_code: dict[str, Any] = {}
    for dp_id, strategy in (device.local_strategy or {}).items():
        code = strategy["status_code"]
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


def cmd_discover(_params: dict[str, Any]) -> list[dict[str, Any]]:
    if state.manager is None:
        raise RuntimeError("No active device-sharing session: call qr_start/qr_poll or restore_session first")
    state.manager.update_device_cache()
    devices = [_serialize_device(d) for d in state.manager.device_map.values()]
    logger.info("Discovered %d device(s) via device sharing", len(devices))
    return devices


def cmd_send_command(params: dict[str, Any]) -> dict[str, Any]:
    if state.manager is None:
        raise RuntimeError("No active device-sharing session")
    state.manager.send_commands(params["device_id"], [{"code": params["code"], "value": params["value"]}])
    return {"success": True}


COMMANDS = {
    "qr_start": cmd_qr_start,
    "qr_poll": cmd_qr_poll,
    "restore_session": cmd_restore_session,
    "get_session": cmd_get_session,
    "logout": cmd_logout,
    "discover": cmd_discover,
    "send_command": cmd_send_command,
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
        except Exception as exc:  # noqa: BLE001 - relayed to Node as a plain error string
            logger.error("Command %s failed: %s\n%s", cmd, exc, traceback.format_exc())
            response = {"id": request_id, "ok": False, "error": str(exc)}

    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def main() -> None:
    logger.info("Tuya device-sharing bridge ready")
    for line in sys.stdin:
        stripped = line.strip()
        if stripped:
            handle_request(stripped)


if __name__ == "__main__":
    main()
