# Lubluelu SL68 (Tuya)

Control the Lubluelu SL68 robot vacuum — and other Tuya/Smart Life-based sweep robots — from
Gladys, directly over your local network. No custom hub, no keeping the phone app open.

## Overview

Day-to-day control (start/pause, mode, water level, suction, return to dock) goes straight to the
vacuum over the LAN, encrypted the same way the Smart Life/Tuya Smart app talks to it — no cloud
round-trip once everything is set up. Bootstrapping still needs to reach your Tuya account once,
for two things only:

- fetching the device's `local_key`, the encryption key local control requires (it is never
  broadcast on the LAN, only ever available behind your Tuya account);
- reading which features your specific vacuum actually has (start/pause, mode, water level,
  suction, battery...) — read from Tuya's own catalog for your device, not guessed.

Two ways to do that — pick whichever suits you, or set up both:

- **Smart Life account (recommended)** — no developer account, no Access ID/Secret to copy: scan
  a QR code with the app you already use for the vacuum, and every device on the account is
  discovered automatically, exactly like adding a device in the official app.
- **Tuya Cloud account (advanced)** — a free Tuya IoT Platform project, for people who already
  have one or want the explicit per-device control it gives.

The `local_key` **rotates** whenever the vacuum re-links to the cloud, so this integration
re-checks it periodically in the background (either method) — you never have to redo the setup
for that.

These features show up per vacuum, automatically adapted to what your specific device reports
(not every vacuum has every one of these):

- **Power** — start/pause the current cleaning run.
- **Mode** — a dropdown (Smart, Along walls, Spot, Single room, Mopping, Return to dock...).
- **Return to dock** — a one-click button, shown only when your vacuum's Mode list has a
  "return to dock" value.
- **Water level** — mopping water flow, when your vacuum has a mop function.
- **Suction power** — when your vacuum reports a suction/power level.
- **Battery** — read-only, 0-100%.
- **Fault code** — read-only, 0 normally.
- **Find robot** — makes the vacuum chirp, when supported.
- **Roll brush / Side brush / Filter** — remaining life, when your vacuum reports consumable wear.

## Prerequisites

- The vacuum already set up and working in the **Smart Life** or **Tuya Smart** app.
- **"Local Network Discovery" (or similar) enabled** for the device in the Smart Life/Tuya Smart
  app (usually on by default) — some models only broadcast their LAN presence when this is on.

## Configuration — Smart Life account (recommended)

This integration's Configuration screen follows these steps top to bottom, numbered:

1. **1. Smart Life account**: open the app on your phone, go to **Me > Settings > Account and
   Security > User Code**, copy it, then paste it into the **Smart Life user code** field.
2. **2. Save**: click Save before continuing — the next step needs this code to already be
   saved, or it fails with an error.
3. **3. Connect and scan the QR code**: click this button, a QR code opens. In the Smart
   Life/Tuya Smart app, tap **+ > Scan**, point at the QR code, and tap **Confirm login**. The
   app may say the login is for "Home Assistant" — that's expected, this integration uses the
   same official Tuya mechanism Home Assistant's own integration does; only confirm if you just
   started this login yourself.
4. Open the **Discovery** tab and run a scan — every device on the account appears automatically,
   with the features each one actually supports. Add the ones you want.

That's it — pairing a new vacuum later is just: pair it in the Smart Life app, then Discovery >
Scan in Gladys. Nothing to configure per device.

## Configuration — Tuya Cloud account (advanced)

1. Go to [iot.tuya.com](https://iot.tuya.com/), create a **Cloud** project (the free "Smart Home"
   template is enough).
2. In the project's **Devices** tab, choose **Link Tuya App Account** and scan the QR code with
   the Smart Life/Tuya Smart app you use for the vacuum. Its devices then appear under **All
   Devices**.
3. Copy the project's **Access ID/Client ID** and **Access Secret/Client Secret** from the
   project's Overview tab into this integration's Configuration screen, along with the
   **Region** your project was created in (visible in the project URL: eu/us/cn/in).
4. Copy the vacuum's **Device ID** from the All Devices list into the **Device ID(s)** field
   (comma-separated if you have several).
5. Save, open the **Discovery** tab and run a scan, then add the device(s).

Both methods can run at once; a device id configured under the Tuya Cloud account takes priority
over the same device found via the Smart Life account.

A **Test connection** action is available from the Configuration screen for any added vacuum: it
reports whether the local session is up, and the vacuum's last known state (or its state read via
the cloud if the local session is currently down).

### If the vacuum's LAN IP isn't found automatically

Discovery relies on the vacuum announcing itself on the LAN (the same broadcast the phone app
uses to find it) — the Smart Life account method also reports the IP Tuya's servers have on file
for the device as a second source. If neither finds it (blocked broadcast between VLANs, some
mesh Wi-Fi setups...), fill in **Manual LAN IP(s) (advanced)**: `device_id=ip`, e.g.
`eb1234567890abcdef01=192.168.1.42`. A fixed IP or a DHCP reservation for the vacuum is
recommended in that case.

## Only one connection at a time

Like most Tuya local-control tools, only one client can hold the vacuum's local TCP session at
once. Keeping the Smart Life/Tuya Smart app open on the vacuum's device screen at the same time
this integration is connected can make both flaky — this is a limitation of the vacuum's own
firmware, not something this integration can work around.

## Troubleshooting

- **"Enter your Smart Life user code first" even though it's filled in**: the form wasn't
  **saved** before clicking the connect button — those are two separate actions. Click Save, wait
  for the confirmation, then click **3. Connect and scan the QR code**. If the error persists,
  check the integration logs (`docker logs`): starting with 0.2.2, a failed attempt shows the
  exact detail there.
- **The QR code isn't confirmed / times out**: it expires in 1-2 minutes — reopen it (click
  Connect again) and scan promptly. If the app doesn't recognize it as valid, try switching
  **QR app (advanced)** between Smart Life and Tuya Smart in the Configuration screen and
  reconnecting.
- **Discovered but stuck "not connected"**: check the manual LAN IP fallback above, and make sure
  nothing else (the phone app, another automation tool) is holding the local session.
- **"Local session unreachable, falling back to the Tuya cloud API"** badge: the integration keeps
  working through cloud commands/status while it retries the local connection in the background —
  commands still work, just with more latency and a cloud round-trip until the LAN session
  recovers.
- **A feature you expect (e.g. Water level) is missing**: your vacuum's Tuya catalog entry may not
  report that code, or reports it under a name this integration doesn't yet recognize. Check the
  integration logs (`LOG_LEVEL=debug`) for the raw schema fetched from Tuya.
- The integration logs everything it does: check the integration logs from the Gladys UI (or
  `docker logs` on the host) with `LOG_LEVEL=debug` for the full detail.
