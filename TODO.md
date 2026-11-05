# TODO

## Next patch

From review r1 of the Smart Life session fix (2026-11-05), minor:

- `sharing.expired` is only set by the discovery, not by `send_command` /
  `get_status`; and the expired status wins over `ready`, even when the Cloud
  API method or LAN sessions still reach the vacuums.
- Node keeps no `t` guard: a `get_session` / `restoreSession` answer could hand
  an older token back to `sharing.session`; the QR `.then` saves the login
  session rather than `sharing.session`. Very narrow.
- Session saves are not awaited on shutdown nor retried before the hourly
  resync: an event lost when the bridge dies is missing at the next restore.
- Pre-existing: `update_device_cache` empties `device_map` while the MQTT
  thread reads it.

From review r2 (2026-11-05), minor:

- The `session` event handler of `index.js` (save on rotation) is not
  extracted nor tested on the Node side; the bridge side is covered by
  `bridge/test_tuya_bridge.py`.

From review r3 (2026-11-05, approved), minor:

- Pre-existing: a non-2xx HTTP answer to a command is a false success (the SDK
  returns `None`, `send_commands` ignores it) and the 10 s filter then
  swallows the next press. Wrap `api.post` to raise on `None`.
- Untested: `threading.excepthook`, the out-of-lock stop in `restore_session`,
  `_redact` on `SessionExpired`, the `getMessage` guard, `swap` returning
  `None` for the same manager.
- `stack_info` is not masked by the log filter (unused by the SDK).
- Very narrow: no retry when "sign invalid" arrives before the MQTT thread
  swapped the SDK's `token_info`.
- The root-handler test assumes a single handler (true under unittest, not
  pytest).
