// -----------------------------------------------------------------------------
// Integration configuration: Tuya Cloud API credentials + device selection.
//
// Local control (the actual day-to-day path, src/tuya/local.js) needs no
// cloud access at all once running — but bootstrapping it does: the
// `local_key` and the DP schema (src/tuya/dpsSchema.js) only ever live behind
// the Tuya Cloud account the vacuum is registered to (the same one the Smart
// Life/Tuya Smart app uses), see src/tuya/cloud.js for why and how.
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  access_id: '',
  access_secret: '',
  region: 'eu',
  device_ids: '',
  device_ips: '',
  refresh_interval_minutes: 60,
  protocol_version: '3.3',
};

const REFRESH_MIN = 5;
const REFRESH_MAX = 1440;
export const VALID_REGIONS = ['eu', 'us', 'cn', 'in'];
export const VALID_PROTOCOL_VERSIONS = ['3.1', '3.3', '3.4'];

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

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    region,
    protocol_version: protocolVersion,
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

export function isConfigured(config) {
  return Boolean(config.access_id && config.access_secret && config.deviceIds.length > 0);
}
