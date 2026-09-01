# gladys-lubluelu-vaccum

External integration for [Gladys Assistant](https://gladysassistant.com) to control the Lubluelu
SL68 — and other Tuya/Smart Life-based robot vacuums — locally over the LAN. Built on the
JavaScript SDK [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
from the official [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

Day-to-day control (start/pause, mode, water level, suction, battery, return to dock) goes
straight over the LAN to the vacuum, the same encrypted protocol the Smart Life/Tuya Smart app
uses — no cloud round-trip once set up. Bootstrapping (fetching the device's `local_key` and its
DP schema, both of which only ever live behind your Tuya account) can go through either of two
independent, mergeable methods; see "Two onboarding methods" below.

## What it does

- **Two onboarding methods, mergeable**: the "simple" one (`src/tuya/deviceSharing.js`) uses
  Tuya's own official Device Sharing QR login — no developer account, Access ID/Secret or Device
  ID to type, every device on the linked Smart Life/Tuya Smart account is discovered
  automatically. The "advanced" one (`src/tuya/cloud.js`) is the classic Tuya Cloud API (Access
  ID/Secret + explicit Device ID(s)). Both populate the same internal device registry
  (`src/devices/index.js#TuyaDeviceRegistry`) — everything downstream (local control, cloud
  fallback) works identically regardless of which one found a given device.
- **Discovery**: whichever method(s) are configured resolve `local_key` + DP schema; the LAN IP
  comes from a mediated UDP broadcast scan (`network_discovery: ["udp-broadcast"]` in the
  manifest — the exact "Tuya-style" example the SDK README itself uses to illustrate mediated
  discovery) and, for the simple method, from Tuya's own device-sharing response as a second
  source. A manual `device_id=ip` fallback is available for networks that block broadcast between
  segments.
- **Dynamic feature set**: unlike a fixed device blueprint, this integration builds each vacuum's
  Gladys features from its own cloud-reported schema (`src/tuya/dpsSchema.js`) — two SL68 units,
  or an SL68 and an unrelated Tuya sweep robot, can expose a different subset of codes, and this
  adapts instead of assuming. See `KNOWN_CODES` in that file for the codes recognized: power
  (`switch_status`), mode (`mode`, with a synthetic **Return to dock** button when the mode enum
  has a dock-like value), water level (`cistern`), suction (`suction`/`power_level`/`speed`),
  battery (`electricity_left`/`battery_percentage`), fault code, find-robot (`seek`), and
  consumable wear (`roll_brush`/`edge_brush`/`filter`).
- **Local session, push-driven**: a persistent TCP session per vacuum ([`tuyapi`](https://www.npmjs.com/package/tuyapi)),
  seeded once on connect then updated from every pushed DP change — no polling.
- **Cloud fallback**: when the local session is down, `onSetValue` falls back to a Tuya Cloud
  command and the vacuum's transport badge (`local`/`cloud`, see the SDK's "Cloud/local transport
  badge") shows **degraded cloud** until the LAN session recovers — see "Cloud/local transport
  badge" in the SDK README, whose worked example is this exact Tuya cloud+LAN scenario.
- **local_key rotation**: Tuya rotates a device's `local_key` whenever it re-links to the cloud.
  A background timer (`refresh_interval_minutes`, default 60) re-fetches it from the Tuya Cloud
  API and pushes it into the running local session without dropping the connection.
- **Test connection** action: reports the local session's last known state, or the state read via
  the Tuya Cloud API status endpoint when the local session is currently down.

## Two onboarding methods

Local control (AES-encrypted TCP to the vacuum, port 6668) needs the device's `local_key`, and
knowing which numeric DP each Gladys feature maps to. Neither is ever broadcast on the LAN — both
only ever live behind your Tuya account.

- **Simple (recommended)**: Tuya's own "Device Sharing" feature (`src/tuya/deviceSharing.js` +
  `bridge/tuya_bridge.py`) — the same mechanism used to share a device with a family member's app,
  repurposed as a QR login. The user scans a QR with the Smart Life/Tuya Smart app they already
  use for the vacuum; the official `tuya-device-sharing-sdk` (Tuya, MIT) then hands back
  `local_key` + full DP schema + LAN IP for **every** device on the account in one call — no
  developer account, no Access ID/Secret, no per-device Device ID to copy. Adding a new vacuum
  later is exactly as simple as in the official app: pair it there, click Scan in Gladys.
- **Advanced**: the classic Tuya Cloud API (`src/tuya/cloud.js`) — a free Tuya IoT Platform
  project (Access ID/Secret), read once per configured Device ID
  (`GET /v1.0/devices/{id}` for the key, `GET /v1.1/devices/{id}/specifications` for the DP
  schema).

Both can run at once (`src/devices/index.js#TuyaDeviceRegistry` merges them; a device id
configured under the advanced method wins on conflict) and both get their `local_key` re-checked
on the same periodic timer to catch Tuya's rotation before it locks a local session out. Nothing
about actual vacuum control goes through either account afterwards, except the best-effort cloud
command fallback below.

## New to this codebase? Start here

An "external integration" is a small Node.js program Gladys runs as its own Docker container,
talking to the Gladys hub over one WebSocket (handled by the SDK). This integration additionally
runs:

- a **Python subprocess** (`bridge/tuya_bridge.py`, spawned by `src/tuya/pythonBridge.js`) — the
  official Tuya device-sharing SDK is Python-only (confirmed: no JS port exists, and its request
  signing uses AES-GCM/HMAC machinery specific to that one API), so this integration runs it as a
  subprocess exactly like gladys-hydro-quebec's Python bridge does for the (also Python-only)
  `hydroqc` library — same line-delimited JSON protocol on stdin/stdout, same reasoning;
- a **Tuya Cloud API** connection (`src/tuya/cloud.js`) — HTTPS, only for the advanced method's
  `local_key`/schema lookups and the cloud command/status fallback, never on the hot path of a
  local command;
- a **local TCP session per vacuum** (`src/tuya/local.js`, wrapping `tuyapi`) — the actual
  day-to-day control path, regardless of which onboarding method found the device.

```
                                 ┌──────────────────────────┐
                                 │   Python subprocess       │
                            ┌───▶│   bridge/tuya_bridge.py   │──── HTTPS ───▶ Tuya device-sharing API
                            │    │   (QR login, discovery)   │                (apigw.iotbing.com)
┌────────────┐  WebSocket   │    └──────────────────────────┘
│ Gladys hub │◀────────────▶│ This integration
│ (the app)  │  events/cmds │ (this repo, Docker)
└────────────┘              │    ┌──────────────────────────┐
                            └───▶│   src/tuya/cloud.js       │──── HTTPS ───▶ Tuya Cloud API (advanced)
                                 └──────────────────────────┘
                                               │  TCP :6668, AES-encrypted (day-to-day control)
                                               ▼
                                        ┌─────────────┐
                                        │  Lubluelu    │
                                        │  SL68 (LAN)  │
                                        └─────────────┘
```

Recommended reading order:

1. [`src/tuya/dpsSchema.js`](./src/tuya/dpsSchema.js) — no I/O: turns a cloud-reported DP schema
   into Gladys features. Read this first to understand what a "feature" is built from here.
2. [`bridge/tuya_bridge.py`](./bridge/tuya_bridge.py) — the QR login/device-sharing logic (Python,
   official Tuya SDK) — read its docstring for why this runs out-of-process.
3. [`src/tuya/pythonBridge.js`](./src/tuya/pythonBridge.js) and
   [`src/tuya/deviceSharing.js`](./src/tuya/deviceSharing.js) — the Node side of the bridge:
   process management + request/response correlation, then the QR-image-URL/login-poll/
   registry-entry translation built on top of it.
4. [`src/tuya/cloud.js`](./src/tuya/cloud.js) — the advanced method's Tuya Cloud OpenAPI client:
   request signing, token lifecycle, the handful of endpoints used.
5. [`src/tuya/udpDiscovery.js`](./src/tuya/udpDiscovery.js) — decodes the mediated UDP broadcast
   scan into `{ gwId, ip }` pairs, reusing `tuyapi`'s own bundled AES/framing code.
6. [`src/tuya/local.js`](./src/tuya/local.js) — the resilient local session (connect, reconnect
   with backoff, apply a rotated key in place), wrapping `tuyapi`'s `TuyaDevice`.
7. [`src/devices/vacuum.js`](./src/devices/vacuum.js) — the glue: discovery payloads, the
   connection registry, `onSetValue`/`test_connection`, local-vs-cloud dispatch.
8. [`src/devices/index.js`](./src/devices/index.js) and [`src/config.js`](./src/config.js) —
   the `TuyaDeviceRegistry` (merges both onboarding methods + UDP) and config normalization used
   by the entry point.
9. [`index.js`](./index.js) — the entry point: SDK bootstrap, the QR login (`account_link`) flow,
   the periodic refresh timer, event wiring.

## Dependencies

| Package                                                                                              | Role                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@gladysassistant/integration-sdk`](https://www.npmjs.com/package/@gladysassistant/integration-sdk) | Talking to the Gladys hub: auth, the WebSocket connection/reconnection, the event/method API.                                                                    |
| [`tuyapi`](https://www.npmjs.com/package/tuyapi)                                                     | The local Tuya protocol itself (AES-128-ECB framing/CRC for protocol 3.1/3.3/3.4) — a maintained, widely-used implementation, deliberately not hand-rolled here. |

Python side (`bridge/requirements.txt`, installed into a venv the Node process spawns — see the
Dockerfile):

| Package                    | Role                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `tuya-device-sharing-sdk`  | The official Tuya QR/device-sharing login — no JS port exists, see "Two onboarding methods".     |
| `cryptography`, `requests` | Its own direct dependencies (AES-GCM/HMAC request signing, HTTP).                                |
| `paho-mqtt`                | Imported unconditionally by the SDK's `mq.py` even though this bridge never uses live MQTT push. |

Everything else (the Tuya Cloud HTTP client and its HMAC-SHA256 request signing, config
normalization) is hand-written on top of Node built-ins (`node:crypto`, the global `fetch`) —
small and specific enough to this integration's needs that pulling in a full Tuya Cloud SDK
wasn't worth it. Dev-only dependencies (never shipped in the Docker image): `eslint` +
`@eslint/js` + `eslint-config-prettier` + `globals` for linting, `prettier` for formatting.
Testing uses no library: `npm test` runs Node's own `node --test` — `bridge/tuya_bridge.py`'s
protocol is tested against a plain-Node fixture standing in for it
(`test-fixtures/echoBridge.js`), not a real Python process, so `npm test` needs no Python at all.
See "Keeping dependencies current" below for how all of the above stay up to date on their own.

## Keeping dependencies current (CI/CD)

Four independent [Dependabot](https://docs.github.com/en/code-security/dependabot) watchers
(`.github/dependabot.yml`), one per place this repo pins a version, each opening its own PR when a
newer version exists:

| Ecosystem        | Watches                   | Covers                                                                                                                                        |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pip`            | `bridge/requirements.txt` | `tuya-device-sharing-sdk` and its own deps (`cryptography`, `requests`, `paho-mqtt`) — the piece that changes when Tuya ships an SDK release. |
| `npm`            | `package.json`            | `@gladysassistant/integration-sdk`, `tuyapi`, and the dev tooling (eslint/prettier).                                                          |
| `docker`         | `Dockerfile`              | The `node:22-alpine` base image.                                                                                                              |
| `github-actions` | `.github/workflows/*.yml` | The actions the workflows themselves use (`actions/checkout`, `docker/build-push-action`...).                                                 |

Every PR Dependabot opens — on any of the four — runs the full `ci.yml` suite already described
above (lint, `node --test`, and, when it's the `pip` PR, the `python-bridge` job): a bumped
`tuya-device-sharing-sdk` gets installed for real and `bridge/tuya_bridge.py` imported against it,
so an SDK release that renames or removes `LoginControl`/`Manager`/`SharingTokenListener` — or a
`status_range`/`local_strategy` shape `_serialize_device` relies on — fails CI on the PR itself,
long before it would otherwise only surface against a real vacuum.

**Auto-merge, `pip`-only, patch-only**: `.github/workflows/dependabot-auto-merge.yml` enables
GitHub's native auto-merge on a Dependabot PR the moment it's opened, but _only_ when it's a `pip`
PR **and** a patch-level bump (e.g. `0.2.15` -> `0.2.16`). GitHub then still waits for every
required check — including `python-bridge` above — before actually merging; a failing check just
means the PR sits there, auto-merge armed but never firing. Minor and major bumps (and every
npm/docker/github-actions PR, regardless of level) are left for a human to merge by hand, same as
before this workflow existed — `tuya-device-sharing-sdk` is still pre-1.0 (`0.x`), so under semver
rules a MINOR release is allowed to break its API, which the `python-bridge` job's import check
can catch existing usages breaking but can't rule out for behavior it doesn't exercise.

This needs **"Allow auto-merge"** turned on once under the repository's Settings -> General — a
setting no workflow file can flip on its own; without it, `dependabot-auto-merge.yml`'s `gh pr
merge --auto` step fails harmlessly and the PR just waits for manual review like any other.

## Project structure

```
.
├─ index.js                          # SDK bootstrap, QR login flow, periodic refresh, event wiring
├─ bridge/
│  ├─ tuya_bridge.py                 # Python: official tuya-device-sharing-sdk (QR login, discovery)
│  └─ requirements.txt               # pinned Python deps, all prebuilt wheels (amd64+arm64, no compiler)
├─ src/
│  ├─ devices/
│  │  ├─ vacuum.js                   # discovery payloads, local-session registry, onSetValue, actions
│  │  └─ index.js                    # TuyaDeviceRegistry: merges both onboarding methods + UDP
│  ├─ tuya/
│  │  ├─ dpsSchema.js                # PURE: cloud DP schema -> Gladys features
│  │  ├─ cloud.js                    # advanced method: Tuya Cloud OpenAPI client (signing, token, endpoints)
│  │  ├─ pythonBridge.js             # spawns bridge/tuya_bridge.py, line-delimited JSON protocol
│  │  ├─ deviceSharing.js            # simple method: QR image URL, login poll loop, registry translation
│  │  ├─ udpDiscovery.js             # decodes the mediated UDP broadcast scan
│  │  └─ local.js                    # resilient local TCP session (wraps tuyapi)
│  └─ config.js                      # config defaults + normalization (both methods)
├─ test/                             # one *.test.js per src/ file above, node --test, no library
├─ test-fixtures/
│  ├─ fakeGladys.js                  # minimal in-memory stand-in for the SDK client, used by tests
│  └─ echoBridge.js                  # plain-Node stand-in for bridge/tuya_bridge.py's protocol
├─ docs/
│  └─ en.md / fr.md                  # END-USER documentation, re-hosted by Gladys itself in its UI
├─ gladys-assistant-integration.json # the manifest: name, version, Docker image, config form, actions
├─ Dockerfile                        # multi-stage: Python venv + Node deps -> one runtime image
└─ cover.png                         # catalog cover
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="lubluelu-vaccum" \
LOG_LEVEL=debug \
npm start
```

The advanced (Cloud API) method works as-is. For the simple (QR/device-sharing) method outside
Docker, install the bridge's Python deps once (`pip install -r bridge/requirements.txt`, ideally
in a venv) — `PYTHON_EXECUTABLE` defaults to `python3` on PATH, override it to point at that venv
if needed.

## Quality checks

```bash
npm run format:check   # Prettier
npm run format          # Prettier, write
npm run lint             # ESLint
npm test                 # node --test
```

`test/udpDiscovery.test.js` is a genuine round-trip test: it encodes a fake broadcast with
`tuyapi`'s own message encoder (the same library this integration decodes with) and checks the
decoder recovers it — exercising the real AES-ECB framing/CRC, not a mock of this repo's own code.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

Add the GitHub topic `gladys-assistant-integration`, then **Actions → Release → Run workflow**
(bumps `package.json` + the manifest, tags, builds the multi-arch image). See the
[integration-template-js README](https://github.com/GladysAssistant/integration-template-js) for
the full publishing flow.

## v0.1 scope

Start/pause, mode (+ return-to-dock convenience button), water level, suction power, battery,
fault code, find-robot, consumable wear — each built dynamically from the device's own Tuya cloud
schema (see "What it does" above). Two onboarding methods (simple QR/device-sharing, advanced
Cloud API), local session with automatic reconnection and `local_key` rotation handling, mediated
LAN discovery with a manual IP fallback, a best-effort cloud command fallback. Deliberately out of
scope for now: room/zone mapping and zone cleaning (Tuya exposes this through vendor-specific,
non-standardized DP formats — see the design discussion that scoped this project), scheduling,
and voice/do-not-disturb settings.

## Tested and confirmed

Honest status, so it's clear what "it works" actually rests on — **no Tuya account (Cloud or
Smart Life) and no physical SL68 unit were available while writing this integration.**

- **Genuinely exercised**: the UDP broadcast decoding (`src/tuya/udpDiscovery.js`) is tested by
  actually encoding a fake announcement with `tuyapi`'s own AES-ECB/CRC framing code and decoding
  it back — real cryptography and framing logic running, not a mock. The Tuya Cloud
  request-signing (`src/tuya/cloud.js`) is tested against a mocked `fetch` and matches the shape
  described in Tuya's public "new signature" documentation. `bridge/tuya_bridge.py` was installed
  into a real virtualenv with the actual `tuya-device-sharing-sdk` package (not mocked) and driven
  end-to-end from Node through `src/tuya/pythonBridge.js`: the QR-mint request reaches Tuya's real
  device-sharing endpoint (`apigw.iotbing.com`) with the exact URL/params the reference
  implementation uses, and every command's error path (unknown session, malformed input) is
  confirmed to come back as a clean `{ok: false, error}` instead of a crash. What's genuinely
  **not** verified: an actual QR scan and confirmation against a real Smart Life account (this
  environment can reach GitHub/npm/PyPI but not `apigw.iotbing.com` itself), so the full
  login-succeeds → device-list-comes-back path is implemented from the SDK's own source and a
  community reference tool ([vineetchoudhary/tuya-local-key](https://github.com/vineetchoudhary/tuya-local-key)),
  not run against Tuya's live response.
- **The QR content format**: confirmed by reading the reference tool's source that Tuya's QR
  payload is a `scheme--qrLogin?token=...` pseudo-URI (double dash, not `://`) — deliberately not
  a real link, so it MUST be rendered as an actual scannable barcode image
  (`src/tuya/deviceSharing.js#buildQrImageUrl`, via the public goQR.me API) rather than shown as a
  tappable link; a `data:` URI was considered and ruled out by reading Gladys core's own
  `front/src/utils/oauth.js#assertOpenableUrl`, which only accepts `http(s)` URLs.
- **The bridge's device→DP-schema mapping** (`_serialize_device` in `bridge/tuya_bridge.py`) is
  built directly from the installed SDK's own `CustomerDevice`/`local_strategy` fields (read from
  its source, not guessed) — structurally verified, not exercised against a real device's actual
  response.
- **Implemented from Tuya's public "Sweep Robot" (`scwxcy`) category documentation, not yet
  confirmed on a real SL68**: the exact `code` names in `KNOWN_CODES`
  (`src/tuya/dpsSchema.js`) — `switch_status`, `mode`, `cistern`, `suction`/`power_level`/`speed`,
  `electricity_left`/`battery_percentage`, `fault`, `seek`, `roll_brush`/`edge_brush`/`filter` —
  and the `DOCK_MODE_VALUES` used to detect a "return to dock" mode value. Because features are
  only ever built for codes the device's own schema actually reports (never invented), a wrong
  guess here just means one fewer feature shows up, not a crash — but the actual SL68 may use
  different code names for some of these than the ones currently recognized. If your vacuum is
  missing a feature you expect, check the integration logs (`LOG_LEVEL=debug`) for the raw schema
  reported and open an issue/PR with the missing `code`.
- **The Tuya Cloud endpoint paths** (`/v1.0/token`, `/v1.0/devices/{id}`,
  `/v1.1/devices/{id}/specifications`, `/v1.0/devices/{id}/status`, `/v1.0/devices/{id}/commands`)
  are the ones referenced across the Tuya OpenAPI documentation and community tooling
  (`tinytuya`'s cloud wizard in particular) for these exact operations, but have not been called
  against a live Tuya Cloud project.
- **Local session lifecycle** (`src/tuya/local.js`): reconnection backoff is unit-tested as a pure
  function; the actual `tuyapi`-driven connect/reconnect/`updateKey` behavior against a real
  device's TCP socket has not been exercised live.
- **Docker build**: verified the exact pip resolution the Dockerfile relies on
  (`pip install --only-binary=:all: -r bridge/requirements.txt`) against real PyPI, including
  every transitive dependency (`cffi`, `certifi`...) — all resolve to prebuilt wheels for
  linux/amd64 AND linux/arm64 (musllinux, no compiler needed), and the resulting stripped-down
  venv (no pip/setuptools/wheel, matching what actually ships) still runs `tuya_bridge.py`
  correctly. The multi-arch image build itself (`docker buildx build --platform ...`) was not run
  (no Docker daemon in this environment) — covered by this repo's own CI instead.

Run the integration against your own vacuum with `LOG_LEVEL=debug` (see "Run it locally" above)
and read the integration logs to confirm or correct any of the above — reports welcome.

## License

Apache-2.0
