// -----------------------------------------------------------------------------
// Tuya Cloud OpenAPI client (Business API, "new signature" scheme).
//
// Role: the piece of the puzzle that a purely local protocol cannot provide.
// Local control (src/tuya/local.js) needs a `local_key` and the device's own
// DP schema (which numeric `dp_id` means "switch_status", "mode"...), and
// neither is ever broadcast on the LAN — both live only behind the vendor's
// cloud account. So this client talks to Tuya's Cloud (the one the Smart
// Life / Tuya Smart app itself uses) purely to fetch/refresh:
//   - the device's `local_key` (GET /v1.0/devices/{id}) — it ROTATES whenever
//     the device re-links to the cloud, hence "refresh", not "fetch once";
//   - its DP schema (GET /v1.1/devices/{id}/specifications) — the `code` <->
//     `dp_id` mapping, read from Tuya's own catalog instead of guessed by
//     sniffing traffic (see src/tuya/dpsSchema.js);
//   - a best-effort cloud command/status fallback (POST .../commands, GET
//     .../status) for when the LAN session is down — see "Cloud/local
//     transport badge" in the SDK README.
// Everything that actually drives the vacuum in the common case is local
// (src/tuya/local.js, a plain TCP socket to the device); this module is
// deliberately never on that hot path.
//
// Signing implements Tuya's documented "new signature" algorithm (2021+):
// https://developer.tuya.com/en/docs/iot/new-singnature — cross-checked
// against the community `tuya-connector-nodejs` SDK's request signing, not
// against a real Tuya Cloud project (no test account available while writing
// this — see the README's "Tested and confirmed" section).
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'tuya-cloud' });

export const REGION_HOSTS = {
  eu: 'https://openapi.tuyaeu.com',
  us: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

// A token is valid ~2h server-side; refresh a bit early so a slow request
// never straddles the expiry.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Build the `stringToSign` component of a Tuya-signed request.
 * @param {string} method HTTP method, e.g. "GET"
 * @param {string} pathWithQuery e.g. "/v1.0/devices/abc123"
 * @param {string} body request body, '' for a GET
 */
export function buildStringToSign(method, pathWithQuery, body = '') {
  // Headers component is deliberately empty: this client never signs custom
  // headers (Tuya only requires it when specific headers are part of the
  // signature, which none of the endpoints used here need).
  return [method.toUpperCase(), sha256Hex(body), '', pathWithQuery].join('\n');
}

/**
 * Compute the Tuya request signature (uppercase hex HMAC-SHA256).
 * @param {{ clientId: string, secret: string, t: string|number, accessToken?: string,
 *   method: string, pathWithQuery: string, body?: string }} options
 */
export function signRequest({
  clientId,
  secret,
  t,
  accessToken = '',
  method,
  pathWithQuery,
  body = '',
}) {
  const str = clientId + accessToken + t + buildStringToSign(method, pathWithQuery, body);
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * Minimal Tuya Cloud OpenAPI client: token lifecycle + the handful of
 * endpoints this integration needs. Not a general-purpose SDK on purpose —
 * every method here maps to one concrete need above.
 */
export class TuyaCloudClient {
  /**
   * @param {{ accessId: string, accessSecret: string, region: string, fetchFn?: typeof fetch }} options
   */
  constructor({ accessId, accessSecret, region, fetchFn = fetch }) {
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.host = REGION_HOSTS[region] ?? REGION_HOSTS.eu;
    this.fetchFn = fetchFn;
    this.token = null; // { accessToken, refreshToken, expiresAt }
  }

  async request(method, pathWithQuery, { body, useToken = true } = {}) {
    if (useToken) {
      await this.ensureToken();
    }
    const bodyString = body ? JSON.stringify(body) : '';
    const t = Date.now().toString();
    const sign = signRequest({
      clientId: this.accessId,
      secret: this.accessSecret,
      t,
      accessToken: useToken ? this.token.accessToken : '',
      method,
      pathWithQuery,
      body: bodyString,
    });

    const headers = {
      client_id: this.accessId,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    };
    if (useToken) {
      headers.access_token = this.token.accessToken;
    }

    const response = await this.fetchFn(`${this.host}${pathWithQuery}`, {
      method,
      headers,
      body: bodyString || undefined,
    });
    const json = await response.json();
    if (!json.success) {
      throw new Error(`Tuya API error ${json.code ?? '?'}: ${json.msg ?? 'unknown error'}`);
    }
    return json.result;
  }

  async ensureToken() {
    const now = Date.now();
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
      return;
    }
    if (this.token?.refreshToken) {
      try {
        await this.refreshToken();
        return;
      } catch (err) {
        logger.warn(`Token refresh failed, requesting a fresh one: ${err.message}`);
      }
    }
    await this.fetchToken();
  }

  async fetchToken() {
    const result = await this.request('GET', '/v1.0/token?grant_type=1', { useToken: false });
    this.setToken(result);
  }

  async refreshToken() {
    const result = await this.request('GET', `/v1.0/token/${this.token.refreshToken}`, {
      useToken: false,
    });
    this.setToken(result);
  }

  setToken(result) {
    this.token = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + Number(result.expire_time ?? 7200) * 1000,
    };
  }

  /** Device details, including the current `local_key` (rotates on re-link). */
  async getDevice(deviceId) {
    return this.request('GET', `/v1.0/devices/${deviceId}`);
  }

  /**
   * The device's DP schema: `{ category, functions: [{code, dp_id, type, values}],
   * status: [{code, dp_id, type, values}] }`. `functions` are the writable
   * (command) points, `status` the readable ones — most vacuum codes appear
   * in both. See src/tuya/dpsSchema.js for how this is turned into features.
   */
  async getSpecifications(deviceId) {
    return this.request('GET', `/v1.1/devices/${deviceId}/specifications`);
  }

  /** Current values of every DP, by `code` — used to seed/refresh state via the cloud. */
  async getStatus(deviceId) {
    return this.request('GET', `/v1.0/devices/${deviceId}/status`);
  }

  /** Best-effort cloud fallback for onSetValue() when the local session is down. */
  async sendCommand(deviceId, code, value) {
    return this.request('POST', `/v1.0/devices/${deviceId}/commands`, {
      body: { commands: [{ code, value }] },
    });
  }
}
