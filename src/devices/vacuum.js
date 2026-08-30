// -----------------------------------------------------------------------------
// Device type: Tuya-based robot vacuum (Lubluelu SL68 and compatible models).
//
// Unlike gladys-denon-avr's fixed AVR feature set, a vacuum's features are
// built dynamically per device from its own cloud-reported DP schema (see
// src/tuya/dpsSchema.js) — two SL68 units, or an SL68 and an unrelated Tuya
// sweep robot, can legitimately expose a different subset of codes.
//
// This module owns:
//   - buildDiscoveredDevice() — turns one cloud-known device + its schema
//     into the discovery payload;
//   - a small connection registry (external_id -> local Tuya session + the
//     feature<->DP translation tables for it), driven by the device
//     lifecycle exactly like gladys-denon-avr's src/devices/avr.js;
//   - onSetValue() / runTestConnectionAction(), dispatching to the local
//     session when connected and falling back to a Tuya Cloud command
//     otherwise (see "Cloud/local transport badge" in the SDK README —
//     this is its worked Tuya example, reused here for real).
//
// Local sessions are push-driven (issueGetOnConnect + the device's own
// pushed `dps` changes) — connectDevice() seeds the initial state, then
// every update is republished as it arrives, no polling.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import { createTuyaLocalClient } from '../tuya/local.js';
import { buildKnownFeatures, DOCK_MODE_VALUES } from '../tuya/dpsSchema.js';

export const DEVICE_TYPE = 'vacuum';

const CONNECTION_FAILURE_THRESHOLD = 3;

const logger = createLogger({ name: DEVICE_TYPE });

// external_id -> {
//   deviceId, local (client handle), cloud (TuyaCloudClient),
//   dpIdToFeatureKey: Map<string dpId, string featureKey>,
//   featureKeyToDp: Map<string featureKey, { dpId: number, code: string }>,
//   dockTargetDpId, dockValue,
//   lastKnownState: Map<featureKey, unknown>,
// }
const connections = new Map();

export function featureExternalId(deviceExternalId, key) {
  return `${deviceExternalId}:${key}`;
}

function ipAddressOf(device) {
  return (device.params ?? []).find((p) => p.name === 'IP_ADDRESS')?.value;
}

/** The Tuya device id this Gladys device was created for (see buildDiscoveredDevice()). */
export function deviceIdOf(device) {
  return (device.params ?? []).find((p) => p.name === 'TUYA_DEVICE_ID')?.value;
}

/**
 * Whether `modeFeature`'s enum contains a "return to dock" value (see
 * DOCK_MODE_VALUES) — determines whether the VACUUM_CLEANER.DOCK convenience
 * feature below is built for this device at all.
 */
function findDockValue(modeFeature) {
  return modeFeature?.rawValues?.find((value) => DOCK_MODE_VALUES.includes(value));
}

/**
 * Build the Gladys feature list AND the lookup tables onSetValue()/onData()
 * need, from one device's cloud DP schema.
 * @param {string} deviceExternalId
 * @param {Map<string, {dpId:number,type:string,values:object}>} dpsByCode
 * @param {'en'|'fr'} [language]
 */
export function buildFeatures(deviceExternalId, dpsByCode, language = 'en') {
  const known = buildKnownFeatures(dpsByCode, language);
  const modeFeature = known.find((f) => f.code === 'mode');
  const dockValue = findDockValue(modeFeature);

  const features = known.map((f) => ({
    name: f.name,
    external_id: featureExternalId(deviceExternalId, f.key),
    category: f.category,
    type: f.type,
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.supported_options ? { supported_options: f.supported_options } : {}),
    min: f.min,
    max: f.max,
    read_only: f.read_only,
    has_feedback: f.has_feedback,
    keep_history: Boolean(f.keep_history),
  }));

  const dpIdToFeatureKey = new Map();
  const featureKeyToDp = new Map();
  for (const f of known) {
    dpIdToFeatureKey.set(String(f.dpId), f.key);
    featureKeyToDp.set(f.key, { dpId: f.dpId, code: f.code });
  }

  if (dockValue !== undefined) {
    features.push({
      name: 'Return to dock',
      external_id: featureExternalId(deviceExternalId, 'dock'),
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.VACUUM_CLEANER.DOCK,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    });
  }

  return { features, dpIdToFeatureKey, featureKeyToDp, dockValue, modeDpId: modeFeature?.dpId };
}

/** Build the discovery payload for one Tuya vacuum known through the cloud API. */
export function buildDiscoveredDevice(gladys, { deviceId, name, dpsByCode, ip }, language = 'en') {
  const ids = gladys.externalIds(DEVICE_TYPE, deviceId);
  const { features } = buildFeatures(ids.device, dpsByCode, language);
  const params = [{ name: 'TUYA_DEVICE_ID', value: deviceId }];
  if (ip) {
    params.push({ name: 'IP_ADDRESS', value: ip });
  }
  return {
    name: name || `Tuya vacuum (${deviceId})`,
    external_id: ids.device,
    params,
    features,
  };
}

async function publishTransport(gladys, externalId, transport, extra = {}) {
  try {
    await gladys.publishTransports([{ external_id: externalId, transport, ...extra }]);
  } catch (err) {
    logger.debug(`publishTransports failed for ${externalId}: ${err.message}`);
  }
}

/**
 * Open (or reuse) the local session for one Gladys-created vacuum device.
 * Idempotent — a second call with the same registry entry is a no-op, a
 * call with an UPDATED local_key/ip re-applies it in place (see
 * src/devices/index.js's periodic refresh loop, which re-fetches the cloud
 * device to catch a rotated key and calls this again).
 *
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} device the Gladys device
 * @param {object} config normalized integration config
 * @param {{ deviceId: string, localKey: string, ip?: string, version?: string,
 *   dpsByCode: Map, cloud: import('../tuya/cloud.js').TuyaCloudClient }} registryEntry
 */
export function connectDevice(gladys, device, config, registryEntry) {
  const existing = connections.get(device.external_id);
  const ip = ipAddressOf(device) || config.deviceIps[registryEntry.deviceId] || registryEntry.ip;

  if (existing) {
    // Structure didn't change (dpsByCode is only re-applied on a fresh
    // discovery/Update, like any other integration) — just keep the local
    // session in sync with a possibly-rotated key/IP.
    if (ip && ip !== existing.ip) {
      existing.local.stop();
      connections.delete(device.external_id);
    } else {
      if (registryEntry.localKey) {
        existing.local.updateKey(registryEntry.localKey);
      }
      return;
    }
  }

  if (!ip) {
    logger.warn(
      `No LAN IP known for ${device.external_id} yet (UDP broadcast + manual override both empty)`,
    );
    return;
  }

  const { dpIdToFeatureKey, featureKeyToDp, dockValue, modeDpId } = buildFeatures(
    device.external_id,
    registryEntry.dpsByCode,
  );

  const entry = {
    deviceId: registryEntry.deviceId,
    ip,
    local: null,
    cloud: registryEntry.cloud,
    dpIdToFeatureKey,
    featureKeyToDp,
    dockValue,
    modeDpId,
    lastKnownState: new Map(),
  };

  entry.local = createTuyaLocalClient({
    id: registryEntry.deviceId,
    key: registryEntry.localKey,
    ip,
    version: registryEntry.version || config.protocol_version,
    reconnectIntervalSeconds: 10,
    onConnect: () => {
      logger.info(`${device.external_id}: local session connected (${ip})`);
      publishTransport(gladys, device.external_id, DEVICE_TRANSPORTS.LOCAL);
      gladys.setConnectionStatus(true).catch(() => {});
    },
    onData: (dps) => {
      for (const [dpIdString, value] of Object.entries(dps)) {
        const key = dpIdToFeatureKey.get(dpIdString);
        if (!key) {
          continue; // A DP this integration doesn't map to a feature — ignored.
        }
        entry.lastKnownState.set(key, value);
        const id = featureExternalId(device.external_id, key);
        gladys
          .publishState(id, value)
          .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
      }
    },
    onDisconnect: (consecutiveFailures) => {
      if (consecutiveFailures < CONNECTION_FAILURE_THRESHOLD) {
        return;
      }
      // Degrade to the cloud command/status API rather than declaring the
      // device fully unreachable — see "Degraded state" in the SDK README.
      publishTransport(gladys, device.external_id, DEVICE_TRANSPORTS.CLOUD, {
        degraded: true,
        message: {
          en: 'Local session unreachable, falling back to the Tuya cloud API.',
          fr: 'Session locale injoignable, bascule sur l’API cloud Tuya.',
        },
      });
    },
  });

  connections.set(device.external_id, entry);
}

/** Close and forget the local session of one device, if any. */
export function disconnectDevice(externalId) {
  connections.get(externalId)?.local.stop();
  connections.delete(externalId);
}

/** Close every open session (graceful shutdown). */
export function disconnectAllDevices() {
  for (const externalId of connections.keys()) {
    disconnectDevice(externalId);
  }
}

/** Best-effort Tuya Cloud command, used when the local session is down. */
async function sendCloudCommand(entry, code, value) {
  if (!entry.cloud) {
    throw new Error('No Tuya Cloud client available for this device');
  }
  await entry.cloud.sendCommand(entry.deviceId, code, value);
}

/**
 * Dispatch a user command to the right device: local session when connected
 * and preferred (GLADYS_PREFER_LOCAL, default true), Tuya Cloud otherwise.
 */
export async function onSetValue(gladys, { device, feature, value, config }) {
  const entry = connections.get(device.external_id);
  if (!entry) {
    throw new Error(`${device.external_id} is not connected`);
  }

  const key = feature.external_id.slice(device.external_id.length + 1);

  // The synthetic "Return to dock" feature has no DP of its own: it sends
  // the dock-like value of the `mode` enum (see findDockValue() above).
  const isDockFeature = key === 'dock' && entry.dockValue !== undefined;
  const target = isDockFeature ? entry.featureKeyToDp.get('mode') : entry.featureKeyToDp.get(key);
  if (!target) {
    throw new Error(`Feature "${key}" is not controllable on this device`);
  }
  const dpValue = isDockFeature ? entry.dockValue : value;

  const preferLocal = config?.GLADYS_PREFER_LOCAL !== false;
  const localReady = entry.local.isConnected();

  if (preferLocal && localReady) {
    const ok = await entry.local.set(target.dpId, dpValue);
    if (ok) {
      return;
    }
    logger.warn(`Local set failed for ${device.external_id}:${key}, falling back to cloud`);
  }

  await sendCloudCommand(entry, target.code, dpValue);
  // Degraded unless the user deliberately turned off "prefer local"
  // (GLADYS_PREFER_LOCAL: false) — that's the one case where routing
  // through the cloud is the nominal, expected behavior rather than a
  // fallback from a local failure.
  await publishTransport(gladys, device.external_id, DEVICE_TRANSPORTS.CLOUD, {
    degraded: preferLocal,
  });
}

/** `test_connection` manifest action: report the local session + last known state. */
export async function runTestConnectionAction(gladys, { fields }) {
  const entry = connections.get(fields.device);
  if (!entry) {
    return {
      en: 'This vacuum has not been connected yet. Check the integration logs.',
      fr: "Cet aspirateur n'a pas encore été connecté. Vérifiez les logs de l'intégration.",
    };
  }

  const localConnected = entry.local.isConnected();
  const state = [...entry.lastKnownState.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');

  if (!localConnected) {
    try {
      const status = await entry.cloud.getStatus(entry.deviceId);
      const cloudState = status.map((s) => `${s.code}=${s.value}`).join(', ');
      return {
        en: `Local session down, reached via Tuya Cloud instead. State: ${cloudState || '(empty)'}.`,
        fr: `Session locale indisponible, jointe via le cloud Tuya. État : ${cloudState || '(vide)'}.`,
      };
    } catch (err) {
      return {
        en: `Not reachable locally nor via the Tuya Cloud API: ${err.message}`,
        fr: `Injoignable en local comme via l'API cloud Tuya : ${err.message}`,
      };
    }
  }

  return {
    en: `Connected locally (${entry.ip}). State: ${state || '(empty)'}.`,
    fr: `Connecté en local (${entry.ip}). État : ${state || '(vide)'}.`,
  };
}

/** Test-only hook: drop every registered connection between tests. */
export function __clearConnectionsForTesting() {
  connections.clear();
}

/** Test-only hook: inject a fake connection registry entry. Not used by production code. */
export function __setConnectionForTesting(externalId, entry) {
  connections.set(externalId, entry);
}
