// -----------------------------------------------------------------------------
// "Simple" onboarding: Tuya's official Device Sharing feature (QR login),
// no Tuya IoT Platform developer account needed at all.
//
// This is a thin Node-side wrapper around bridge/tuya_bridge.py (spawned
// through src/tuya/pythonBridge.js) — see that script's docstring for why
// the actual login/device-listing logic has to run in Python. This module
// owns only what's Node-appropriate: building the scannable QR image URL,
// running the login poll loop with an overall timeout, and translating the
// bridge's flat device list into the same shape src/devices/index.js's
// TuyaDeviceRegistry already uses for the classic Cloud API method — so
// everything downstream (src/devices/vacuum.js, local sessions, cloud
// fallback) works identically no matter which method populated an entry.
// -----------------------------------------------------------------------------

const QR_POLL_INTERVAL_MS = 3_000;
// The QR itself expires in ~1-2 minutes (see bridge/tuya_bridge.py); polling
// a good while past that just means "the user hasn't scanned yet" stops
// being reported sooner than it has to.
const QR_LOGIN_TIMEOUT_MS = 150_000;

/** Public, well-known QR-code rendering API (goQR.me) — no account/key needed.
 * The QR *content* is a short-lived (~1-2 min), single-use Tuya login token,
 * not a credential of any lasting value, so handing it to a third-party
 * renderer is a reasonable trade for needing zero infrastructure of our own
 * (see the README for the alternative considered: a self-hosted sub-container,
 * ruled out because building its browser-facing URL would need the LAN
 * address/hostname the user's browser reaches Gladys by, which only the
 * frontend knows — see gladys/front/src/utils/oauth.js#assertOpenableUrl for
 * why a data: URI can't be used instead: only http(s) URLs are accepted). */
export function buildQrImageUrl(content, { size = 300 } = {}) {
  const params = new URLSearchParams({ size: `${size}x${size}`, data: content });
  return `https://api.qrserver.com/v1/create-qr-code/?${params.toString()}`;
}

export class TuyaDeviceSharingClient {
  constructor({ bridge }) {
    this.bridge = bridge;
  }

  /** Mint a fresh QR login token. Resolves `{ token, content }` — `content` must be
   * rendered as an actual QR barcode (see buildQrImageUrl), never shown/opened as a link:
   * it uses Tuya's `scheme--qrLogin?token=...` pseudo-URI, not a real `scheme://` one. */
  async startQrLogin(userCode, scheme) {
    return this.bridge.call('qr_start', { user_code: userCode, scheme });
  }

  /** One non-blocking login check. Resolves `{ status: 'pending' }` or `{ status: 'success', session }`. */
  async pollQrLogin(token, userCode) {
    return this.bridge.call('qr_poll', { token, user_code: userCode });
  }

  /** Rebuild the bridge's in-memory session after a restart, from a previously-persisted one. */
  async restoreSession(session) {
    return this.bridge.call('restore_session', { session });
  }

  /** Current session (tokens possibly refreshed since login/restore) — re-persist after calling. */
  async getSession() {
    return this.bridge.call('get_session', {});
  }

  /** Every device on the linked account, each with its local_key + full DP schema + LAN IP. */
  async discoverDevices() {
    return this.bridge.call('discover', {});
  }

  /** Cloud command fallback for onSetValue() when the local session is down (see src/devices/vacuum.js). */
  async sendCommand(deviceId, code, value) {
    await this.bridge.call('send_command', { device_id: deviceId, code, value });
  }

  /**
   * Current values of every DP, by code — cloud status fallback for
   * runTestConnectionAction() when the local session is down, mirroring
   * TuyaCloudClient#getStatus's `[{ code, value }]` shape so both onboarding
   * methods work identically there.
   */
  async getStatus(deviceId) {
    return this.bridge.call('get_status', { device_id: deviceId });
  }

  async logout() {
    return this.bridge.call('logout', {});
  }
}

/**
 * Poll until the QR login succeeds or `timeoutMs` elapses.
 * @param {(token: string, userCode: string) => Promise<object>} pollFn typically `client.pollQrLogin`
 */
export async function waitForQrLogin(
  pollFn,
  token,
  userCode,
  { timeoutMs = QR_LOGIN_TIMEOUT_MS, intervalMs = QR_POLL_INTERVAL_MS, sleep = defaultSleep } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pollFn(token, userCode);
    if (result.status === 'success') {
      return result.session;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        'QR login timed out — the code expires quickly, please try again and scan promptly',
      );
    }
    await sleep(intervalMs);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert one bridge-reported device (see bridge/tuya_bridge.py#_serialize_device)
 * into the same `{ dpsByCode: Map }` shape src/tuya/dpsSchema.js#indexDpsByCode
 * produces for the classic Cloud API method — the two onboarding paths converge
 * to one registry entry shape from here on.
 */
export function toRegistryEntry(device) {
  const dpsByCode = new Map(
    Object.entries(device.dps ?? {}).map(([code, entry]) => [
      code,
      { dpId: entry.dpId, type: entry.type, values: parseValuesJson(entry.values) },
    ]),
  );
  return {
    deviceId: device.id,
    name: device.name,
    localKey: device.local_key,
    dpsByCode,
    ip: device.ip || undefined,
  };
}

function parseValuesJson(raw) {
  if (typeof raw !== 'string') {
    return raw ?? {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
