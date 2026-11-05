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
