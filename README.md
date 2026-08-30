# gladys-lubluelu-vaccum

External integration for [Gladys Assistant](https://gladysassistant.com) to control the Lubluelu
SL68 — and other Tuya/Smart Life-based robot vacuums — locally over the LAN. Built on the
JavaScript SDK [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
from the official [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

Day-to-day control (start/pause, mode, water level, suction, battery, return to dock) goes
straight over the LAN to the vacuum, the same encrypted protocol the Smart Life/Tuya Smart app
uses — no cloud round-trip once set up. A Tuya Cloud account is only ever used to fetch the
device's `local_key` and its own DP (data point) schema, both of which only ever live behind that
account; see "Why a Tuya Cloud account is still needed" below.

## What it does

- **Discovery**: the configured Tuya device id(s) are looked up through the Tuya Cloud API
  (`local_key` + DP schema), and their LAN IP through a mediated UDP broadcast scan
  (`network_discovery: ["udp-broadcast"]` in the manifest — the exact "Tuya-style" example the
  SDK README itself uses to illustrate mediated discovery). A manual `device_id=ip` fallback is
  available for networks that block broadcast between segments.
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

## Why a Tuya Cloud account is still needed

Local control (AES-encrypted TCP to the vacuum, port 6668) needs the device's `local_key`, and
knowing which numeric DP each Gladys feature maps to. Neither is ever broadcast on the LAN — both
only ever live behind the Tuya Cloud account the Smart Life/Tuya Smart app itself uses. So a free
Tuya IoT Platform project, linked once to that app account, is required to read them
(`GET /v1.0/devices/{id}` for the key, `GET /v1.1/devices/{id}/specifications` for the DP schema —
see `src/tuya/cloud.js`). Nothing about actual vacuum control goes through that account
afterwards, except the best-effort cloud fallback above and the periodic key-rotation check.

## New to this codebase? Start here

An "external integration" is a small Node.js program Gladys runs as its own Docker container,
talking to the Gladys hub over one WebSocket (handled by the SDK). This integration additionally
opens:

- a **Tuya Cloud API** connection (`src/tuya/cloud.js`) — HTTPS, only for `local_key`/schema
  lookups and the cloud command/status fallback, never on the hot path of a local command;
- a **local TCP session per vacuum** (`src/tuya/local.js`, wrapping `tuyapi`) — the actual
  day-to-day control path.

```
┌────────────┐  WebSocket (SDK)   ┌───────────────────────┐  HTTPS (key/schema, fallback)  ┌────────────┐
│ Gladys hub │ ─────────────────▶ │  This integration      │ ──────────────────────────────▶ │ Tuya Cloud │
│ (the app)  │ ◀───────────────── │  (this repo, Docker)   │ ◀────────────────────────────── │    API     │
└────────────┘  events / commands └───────────┬───────────┘                                  └────────────┘
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
2. [`src/tuya/cloud.js`](./src/tuya/cloud.js) — the Tuya Cloud OpenAPI client: request signing,
   token lifecycle, the handful of endpoints used.
3. [`src/tuya/udpDiscovery.js`](./src/tuya/udpDiscovery.js) — decodes the mediated UDP broadcast
   scan into `{ gwId, ip }` pairs, reusing `tuyapi`'s own bundled AES/framing code.
4. [`src/tuya/local.js`](./src/tuya/local.js) — the resilient local session (connect, reconnect
   with backoff, apply a rotated key in place), wrapping `tuyapi`'s `TuyaDevice`.
5. [`src/devices/vacuum.js`](./src/devices/vacuum.js) — the glue: discovery payloads, the
   connection registry, `onSetValue`/`test_connection`, local-vs-cloud dispatch.
6. [`src/devices/index.js`](./src/devices/index.js) and [`src/config.js`](./src/config.js) —
   the `TuyaDeviceRegistry` (cloud+UDP composition) and config normalization used by the entry
   point.
7. [`index.js`](./index.js) — the entry point: SDK bootstrap, the periodic refresh timer, event
   wiring.

## Dependencies

| Package                                                                                              | Role                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@gladysassistant/integration-sdk`](https://www.npmjs.com/package/@gladysassistant/integration-sdk) | Talking to the Gladys hub: auth, the WebSocket connection/reconnection, the event/method API.                                                                    |
| [`tuyapi`](https://www.npmjs.com/package/tuyapi)                                                     | The local Tuya protocol itself (AES-128-ECB framing/CRC for protocol 3.1/3.3/3.4) — a maintained, widely-used implementation, deliberately not hand-rolled here. |

Everything else (the Tuya Cloud HTTP client and its HMAC-SHA256 request signing, config
normalization) is hand-written on top of Node built-ins (`node:crypto`, the global `fetch`) —
small and specific enough to this integration's needs that pulling in a full Tuya Cloud SDK
wasn't worth it. Dev-only dependencies (never shipped in the Docker image): `eslint` +
`@eslint/js` + `eslint-config-prettier` + `globals` for linting, `prettier` for formatting.
Testing uses no library: `npm test` runs Node's own `node --test`.

## Project structure

```
.
├─ index.js                          # SDK bootstrap, periodic Tuya Cloud refresh, event wiring
├─ src/
│  ├─ devices/
│  │  ├─ vacuum.js                   # discovery payloads, local-session registry, onSetValue, actions
│  │  └─ index.js                    # TuyaDeviceRegistry: composes Cloud API + UDP discovery
│  ├─ tuya/
│  │  ├─ dpsSchema.js                # PURE: cloud DP schema -> Gladys features
│  │  ├─ cloud.js                    # Tuya Cloud OpenAPI client (signing, token, endpoints)
│  │  ├─ udpDiscovery.js             # decodes the mediated UDP broadcast scan
│  │  └─ local.js                    # resilient local TCP session (wraps tuyapi)
│  └─ config.js                      # config defaults + normalization
├─ test/                             # one *.test.js per src/ file above, node --test, no library
├─ test-fixtures/
│  └─ fakeGladys.js                  # minimal in-memory stand-in for the SDK client, used by tests
├─ docs/
│  └─ en.md / fr.md                  # END-USER documentation, re-hosted by Gladys itself in its UI
├─ gladys-assistant-integration.json # the manifest: name, version, Docker image, config form, actions
├─ Dockerfile                        # packages index.js + src/ into the image Gladys runs
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
schema (see "What it does" above). Local session with automatic reconnection and `local_key`
rotation handling, mediated LAN discovery with a manual IP fallback, a best-effort cloud command
fallback. Deliberately out of scope for now: room/zone mapping and zone cleaning (Tuya exposes
this through vendor-specific, non-standardized DP formats — see the design discussion that scoped
this project), scheduling, and voice/do-not-disturb settings.

## Tested and confirmed

Honest status, so it's clear what "it works" actually rests on — **no Tuya Cloud account and no
physical SL68 unit were available while writing this integration.**

- **Genuinely exercised**: the UDP broadcast decoding (`src/tuya/udpDiscovery.js`) is tested by
  actually encoding a fake announcement with `tuyapi`'s own AES-ECB/CRC framing code and decoding
  it back — this is real cryptography and framing logic running, not a mock. The Tuya Cloud
  request-signing (`src/tuya/cloud.js`) is tested against a mocked `fetch` and matches the shape
  described in Tuya's public "new signature" documentation, cross-checked against the community
  `tuya-connector-nodejs` SDK's own signing implementation — not verified against Tuya's actual
  servers.
- **Implemented from Tuya's public "Sweep Robot" (`scwxcy`) category documentation, not yet
  confirmed on a real SL68**: the exact `code` names in `KNOWN_CODES`
  (`src/tuya/dpsSchema.js`) — `switch_status`, `mode`, `cistern`, `suction`/`power_level`/`speed`,
  `electricity_left`/`battery_percentage`, `fault`, `seek`, `roll_brush`/`edge_brush`/`filter` —
  and the `DOCK_MODE_VALUES` used to detect a "return to dock" mode value. Because features are
  only ever built for codes the device's own cloud schema actually reports (never invented), a
  wrong guess here just means one fewer feature shows up, not a crash — but the actual SL68 may
  use different code names for some of these than the ones currently recognized. If your vacuum
  is missing a feature you expect, check the integration logs (`LOG_LEVEL=debug`) for the raw
  schema Tuya Cloud reports and open an issue/PR with the missing `code`.
- **The Tuya Cloud endpoint paths** (`/v1.0/token`, `/v1.0/devices/{id}`,
  `/v1.1/devices/{id}/specifications`, `/v1.0/devices/{id}/status`, `/v1.0/devices/{id}/commands`)
  are the ones referenced across the Tuya OpenAPI documentation and community tooling
  (`tinytuya`'s cloud wizard in particular) for these exact operations, but have not been called
  against a live Tuya Cloud project.
- **Local session lifecycle** (`src/tuya/local.js`): reconnection backoff is unit-tested as a pure
  function; the actual `tuyapi`-driven connect/reconnect/`updateKey` behavior against a real
  device's TCP socket has not been exercised live.

Run the integration against your own vacuum with `LOG_LEVEL=debug` (see "Run it locally" above)
and read the integration logs to confirm or correct any of the above — reports welcome.

## License

Apache-2.0
