// -----------------------------------------------------------------------------
// Integration configuration: two independent onboarding methods, either one
// (or both) usable at once — see src/devices/index.js#TuyaDeviceRegistry for
// how they merge into the same device list.
//
//   - "Simple" (recommended): Tuya's official Device Sharing QR login, no
//     developer account at all — just `user_code`, see src/tuya/deviceSharing.js.
//   - "Advanced": a Tuya IoT Platform Cloud project (Access ID/Secret) +
//     explicit Device ID(s) — see src/tuya/cloud.js for why and how.
//
// Local control itself (the actual day-to-day path, src/tuya/local.js) needs
// no cloud access at all once running, regardless of which method bootstrapped
// a device's local_key/DP schema.
// -----------------------------------------------------------------------------

import { LANGUAGES, DEFAULT_LANGUAGE } from './i18n.js';
import { LEARNED_ZONES_CONFIG_KEY, parseLearnedZones, parseRoomsConfig } from './zones.js';

export const DEFAULT_CONFIG = {
  language: DEFAULT_LANGUAGE,
  user_code: '',
  qr_scheme: 'smartlife',
  access_id: '',
  access_secret: '',
  region: 'eu',
  device_ids: '',
  device_ips: '',
  refresh_interval_minutes: 60,
  protocol_version: '3.3',
  rooms: '',
};

const REFRESH_MIN = 5;
const REFRESH_MAX = 1440;
export const VALID_REGIONS = ['eu', 'us', 'cn', 'in'];
export const VALID_PROTOCOL_VERSIONS = ['3.1', '3.3', '3.4', '3.5'];
export const VALID_QR_SCHEMES = ['smartlife', 'tuyaSmart'];
export const VALID_LANGUAGES = LANGUAGES;

function toBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Comma-separated list -> deduplicated, trimmed, non-empty values. */
function parseList(raw) {
  return [
    ...new Set(
      String(raw ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Parse `device_ips` ("device_id=ip, device_id=ip") into `{ [deviceId]: ip }`
 * — the manual fallback for LAN IPs the UDP broadcast scan doesn't find
 * (broadcast disabled on the device, blocked VLAN...), same idea as
 * gladys-denon-avr's `source_overrides`.
 */
export function parseDeviceIps(raw) {
  const map = {};
  for (const entry of parseList(raw)) {
    const equalsIndex = entry.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }
    const deviceId = entry.slice(0, equalsIndex).trim();
    const ip = entry.slice(equalsIndex + 1).trim();
    if (deviceId && ip) {
      map[deviceId] = ip;
    }
  }
  return map;
}

export function normalizeConfig(raw = {}) {
  const region = VALID_REGIONS.includes(raw.region) ? raw.region : DEFAULT_CONFIG.region;
  const protocolVersion = VALID_PROTOCOL_VERSIONS.includes(raw.protocol_version)
    ? raw.protocol_version
    : DEFAULT_CONFIG.protocol_version;
  const qrScheme = VALID_QR_SCHEMES.includes(raw.qr_scheme)
    ? raw.qr_scheme
    : DEFAULT_CONFIG.qr_scheme;
  const language = VALID_LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language;
  const rooms = parseRoomsConfig(raw.rooms);

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    region,
    protocol_version: protocolVersion,
    qr_scheme: qrScheme,
    language,
    // Zones (see src/zones.js): typed in `rooms`, or learned from the app.
    roomZones: rooms.zones,
    roomErrors: rooms.errors,
    learnedZones: parseLearnedZones(raw[LEARNED_ZONES_CONFIG_KEY]),
    deviceIds: parseList(raw.device_ids),
    deviceIps: parseDeviceIps(raw.device_ips),
    refresh_interval_minutes: toBoundedNumber(
      raw.refresh_interval_minutes,
      DEFAULT_CONFIG.refresh_interval_minutes,
      REFRESH_MIN,
      REFRESH_MAX,
    ),
  };
}

/** The "advanced" Tuya Cloud API method has what it needs to run. */
export function isCloudConfigured(config) {
  return Boolean(config.access_id && config.access_secret && config.deviceIds.length > 0);
}

/** The "simple" QR/device-sharing method has what it needs to attempt a login. */
export function isSharingConfigured(config) {
  return Boolean(config.user_code);
}
