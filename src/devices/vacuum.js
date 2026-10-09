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
//     into the discovery payload (features + one push button per zone);
//   - a small connection registry (external_id -> local Tuya session + the
//     feature<->DP translation tables for it + the last raw value of every
//     DP), driven by the device lifecycle like gladys-denon-avr's
//     src/devices/avr.js;
//   - applyDps(): the ONE path every DP update goes through, local push or
//     cloud (MQTT push of the Smart Life method, status poll of the Cloud API
//     method): it publishes only the features that changed, in one batch,
//     then tells the listener (src/events.js: scene triggers, widget nudges);
//   - sendDpCommand() / onSetValue() / runTestConnectionAction(), sending to
//     the local session when connected and falling back to a Tuya Cloud
//     command otherwise (see "Cloud/local transport badge" in the SDK README).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import { createTuyaLocalClient } from '../tuya/local.js';
import { buildKnownFeatures, commandDps, DOCK_MODE_VALUES } from '../tuya/dpsSchema.js';
import { selectionFromReport } from '../tuya/sweeper.js';
import { FEATURE_NAMES, TEXTS, pick } from '../i18n.js';

export const DEVICE_TYPE = 'vacuum';

const CONNECTION_FAILURE_THRESHOLD = 3;
const ZONE_KEY_PREFIX = 'zone_';

const logger = createLogger({ name: DEVICE_TYPE });

// external_id -> {
//   deviceId, ip, local (client handle), cloud (TuyaCloudClient or the
//   device-sharing client), transport ('local'|'cloud'),
//   dpIdToFeatureKey: Map<string dpId, string featureKey>,
//   featureKeyToDp: Map<featureKey, { dpId, code, dpType, decode?, encode? }>,
//   commands: commandDps() — dock/direction/command_trans/start/pause/seek/mode,
//   dpsByCode, dockValue, zones: [{ name, slug, command }],
//   values: Map<code, raw value>, lastKnownState: Map<featureKey, published>,
//   lastSelection: the last room/zone selection the robot reported,
// }
const connections = new Map();

// Told about every applied change (see applyDps()): src/events.js plugs the
// scene triggers and widget nudges in here.
let changeListener = null;

/** Register the one listener applyDps() calls with each batch of changes. */
export function onVacuumChange(listener) {
  changeListener = listener;
}

// Stands in for `entry.local` while no LAN IP is known yet (UDP broadcast
// found nothing, no manual override): always "disconnected", so commands fall
// straight through to the Tuya Cloud instead of throwing "not connected".
// Stateless (no `ip` to react to), so one shared instance is enough.
const NO_IP_LOCAL_CLIENT = {
  isConnected: () => false,
  async set() {
    return false;
  },
  updateKey() {},
  stop() {},
};

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

/** The feature key of a zone push button. */
export function zoneFeatureKey(zone) {
  return `${ZONE_KEY_PREFIX}${zone.slug}`;
}

/**
 * Build the Gladys feature list AND the lookup tables onSetValue()/onData()
 * need, from one device's cloud DP schema.
 * @param {string} deviceExternalId
 * @param {Map<string, {dpId:number,type:string,values:object}>} dpsByCode
 * @param {'en'|'fr'} [language]
 * @param {{ zones?: Array<{ name: string, slug: string }> }} [options]
 */
export function buildFeatures(deviceExternalId, dpsByCode, language = 'en', { zones = [] } = {}) {
  const known = buildKnownFeatures(dpsByCode, language);
  const commands = commandDps(dpsByCode);
  const modeFeature = known.find((f) => f.code === 'mode');
  // `switch_charge` is the dedicated "go home" DP; older firmwares only have
  // a dock-like value in the `mode` enum.
  const dockValue = commands.dock
    ? undefined
    : modeFeature?.rawValues?.find((value) => DOCK_MODE_VALUES.includes(value));

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
    featureKeyToDp.set(f.key, {
      dpId: f.dpId,
      code: f.code,
      dpType: dpsByCode.get(f.code)?.type,
      decode: f.decode,
      encode: f.encode,
    });
  }

  if (commands.dock || dockValue !== undefined) {
    features.push({
      name: pick(FEATURE_NAMES.dock, language),
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

  // One push button per zone, only on a robot that takes zone commands.
  const zoneList = commands.commandTrans ? zones : [];
  for (const zone of zoneList) {
    features.push({
      name: `${pick(FEATURE_NAMES.zone, language)} - ${zone.name}`,
      external_id: featureExternalId(deviceExternalId, zoneFeatureKey(zone)),
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    });
  }

  return {
    features,
    dpIdToFeatureKey,
    featureKeyToDp,
    dockValue,
    modeDpId: modeFeature?.dpId,
    commands,
    zones: zoneList,
  };
}

/** Build the discovery payload for one Tuya vacuum. */
export function buildDiscoveredDevice(
  gladys,
  { deviceId, name, dpsByCode, ip },
  language = 'en',
  { zones = [] } = {},
) {
  const ids = gladys.externalIds(DEVICE_TYPE, deviceId);
  const { features } = buildFeatures(ids.device, dpsByCode, language, { zones });
  const params = [{ name: 'TUYA_DEVICE_ID', value: deviceId }];
  if (ip) {
    params.push({ name: 'IP_ADDRESS', value: ip });
  }
  return {
    name: name || `${pick(TEXTS.unknownDevice, language)} (${deviceId})`,
    external_id: ids.device,
    params,
    features,
  };
}

/**
 * Convert a raw Tuya DP value (as read from the device) into the shape
 * gladys.publishState() requires (see the SDK README: "value is a number,
 * or `{ text }`"). Tuya's own JS types don't line up with that contract on
 * two DP types — passing the raw value straight through made every affected
 * feature fail with "states[0]: must have a numeric 'state' or a string
 * 'text'" on every single update:
 *   - Boolean DPs decode to a JS boolean (`true`/`false`), not a number.
 *   - Enum/String DPs decode to a plain string, which publishState only
 *     accepts wrapped as `{ text }` — an unwrapped string is sent as
 *     `state`, which must be numeric.
 * Value/Integer/Bitmap DPs already decode to a plain number and need no
 * conversion.
 */
export function formatIncomingValue(dpType, value) {
  if (dpType === 'Boolean') {
    return Number(value);
  }
  if (dpType === 'Enum' || dpType === 'String') {
    return { text: String(value) };
  }
  return value;
}

/**
 * Convert the value a Gladys command carries (per the SDK README: a number,
 * except on `text` category features, whose commands are strings) into what
 * the Tuya DP actually expects to be sent as. Only Boolean DPs need this: a
 * switch feature's command value is a number (0/1), but Tuya's local and
 * cloud APIs expect a real JSON boolean for a Boolean-typed DP — sending the
 * number as-is has been observed to make the device silently ignore the
 * command (a local `set()` timeout, or a cloud "network error:(2008)").
 */
export function formatOutgoingValue(dpType, value) {
  if (dpType === 'Boolean') {
    return value === true || value === 1 || value === '1' || value === 'true';
  }
  if (dpType === 'Value' || dpType === 'Integer') {
    return Number(value);
  }
  return value;
}

/** The value one feature publishes for a raw DP value, `undefined` to publish nothing. */
function publishedValue(target, raw) {
  if (target.decode) {
    const decoded = target.decode(raw);
    return decoded === undefined || Number.isNaN(decoded) ? undefined : decoded;
  }
  return formatIncomingValue(target.dpType, raw);
}

function sameValue(a, b) {
  return a === b || (a?.text !== undefined && a?.text === b?.text);
}

async function publishTransport(gladys, entry, externalId, transport, extra = {}) {
  if (entry) {
    entry.transport = transport;
  }
  try {
    await gladys.publishTransports([{ external_id: externalId, transport, ...extra }]);
  } catch (err) {
    logger.debug(`publishTransports failed for ${externalId}: ${err.message}`);
  }
}

/**
 * Apply DP values reported by the robot — local push or cloud — to one
 * connection: remember every raw value, publish the features whose Gladys
 * value changed (one publishStates() batch: the core caps states at 300 per
 * minute and re-evaluates scenes on each), then hand the changed codes to
 * the change listener.
 * @param {Record<string, unknown>} dpsById raw values keyed by DP id
 */
export async function applyDps(gladys, externalId, dpsById) {
  const entry = connections.get(externalId);
  if (!entry) {
    return;
  }
  const previous = new Map(entry.values);
  const changedCodes = [];
  const states = [];
  for (const [dpIdString, raw] of Object.entries(dpsById ?? {})) {
    const code = entry.codeByDpId?.get(dpIdString);
    if (code !== undefined && entry.values.get(code) !== raw) {
      entry.values.set(code, raw);
      changedCodes.push(code);
    }
    const key = entry.dpIdToFeatureKey.get(dpIdString);
    if (!key) {
      continue; // A DP this integration doesn't map to a feature.
    }
    const value = publishedValue(entry.featureKeyToDp.get(key), raw);
    if (value === undefined || sameValue(entry.lastKnownState.get(key), value)) {
      continue;
    }
    entry.lastKnownState.set(key, value);
    states.push({ device_feature_external_id: featureExternalId(externalId, key), state: value });
  }

  if (changedCodes.includes('command_trans')) {
    const selection = selectionFromReport(entry.values.get('command_trans'));
    if (selection) {
      entry.lastSelection = selection;
      const what =
        selection.kind === 'rooms'
          ? `rooms ${selection.roomIds.join('+')}`
          : `${selection.zoneCount} drawn zone(s)`;
      logger.info(
        `${externalId}: the robot reports a selective clean (${what}). Name it with the "Memorize the last zone" action, or type it in the rooms field as Name=${selection.roomIds?.join('+') ?? '…'}`,
      );
    }
  }

  if (states.length > 0) {
    try {
      await gladys.publishStates(states);
    } catch (err) {
      logger.error(`publishStates failed for ${externalId}: ${err.message}`);
    }
  }
  if (changedCodes.length > 0 && changeListener) {
    try {
      await changeListener(externalId, { changedCodes, previous, entry });
    } catch (err) {
      logger.error(`Change listener failed for ${externalId}: ${err.message}`);
    }
  }
}

/**
 * Apply a cloud status (`{ code: value }` or `[{ code, value }]`) to the
 * connection of one Tuya device, by translating codes to DP ids.
 */
export async function applyCloudStatus(gladys, deviceId, status) {
  const pairs = Array.isArray(status)
    ? status.map(({ code, value }) => [code, value])
    : Object.entries(status ?? {});
  for (const [externalId, entry] of connections) {
    if (entry.deviceId !== deviceId) {
      continue;
    }
    const dpsById = {};
    for (const [code, value] of pairs) {
      const dpId = entry.dpsByCode?.get(code)?.dpId;
      if (dpId !== undefined) {
        dpsById[String(dpId)] = value;
      }
    }
    await applyDps(gladys, externalId, dpsById);
  }
}

/**
 * Read the cloud status of every vacuum whose local session is down (or
 * absent) and apply it — the safety net under the Smart Life method's MQTT
 * push, and the only state source of the Cloud API method without a LAN
 * session. A vacuum whose local session is up is skipped: it pushes itself.
 */
export async function pollCloudStates(gladys) {
  for (const [externalId, entry] of connections) {
    if (entry.local.isConnected() || typeof entry.cloud?.getStatus !== 'function') {
      continue;
    }
    try {
      await applyCloudStatus(gladys, entry.deviceId, await entry.cloud.getStatus(entry.deviceId));
    } catch (err) {
      logger.debug(`Cloud status of ${externalId} failed: ${err.message}`);
    }
  }
}

/**
 * Which LAN IP to use for one device's local session — manual override
 * first, then the registry's current data (refreshed every cycle), and only
 * then the Gladys device's own `IP_ADDRESS` param as a last resort. NOT that
 * param first: it's a snapshot frozen at discovery time
 * (buildDiscoveredDevice() sets it once, never updated afterwards), so
 * putting it first would let a bad IP baked in at discovery (e.g. a non-LAN
 * address device sharing briefly reported) permanently shadow both a
 * corrected registry value AND the manual escape hatch this field exists for.
 */
export function resolveDeviceIp(device, config, registryEntry) {
  return config.deviceIps[registryEntry.deviceId] || registryEntry.ip || ipAddressOf(device);
}

/**
 * Open (or reuse) the local session for one Gladys-created vacuum device.
 * Idempotent — a second call with the same registry entry is a no-op, a
 * call with an UPDATED local_key/ip re-applies it in place (see
 * src/devices/index.js's periodic refresh loop, which re-fetches the cloud
 * device to catch a rotated key and calls this again). The zones are
 * refreshed in place too: a zone learned or typed since works at once.
 *
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} device the Gladys device
 * @param {object} config normalized integration config
 * @param {{ deviceId: string, localKey: string, ip?: string, version?: string,
 *   dpsByCode: Map, cloud: object, name?: string }} registryEntry
 * @param {Array<object>} [zones] this vacuum's zones (src/zones.js#zonesFor)
 */
export function connectDevice(gladys, device, config, registryEntry, zones = []) {
  const existing = connections.get(device.external_id);
  const ip = resolveDeviceIp(device, config, registryEntry);

  if (existing) {
    existing.name = device.name || registryEntry.name || existing.name;
    existing.zones = existing.commands?.commandTrans ? zones : [];
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

  const tables = buildFeatures(device.external_id, registryEntry.dpsByCode, config.language, {
    zones,
  });
  const codeByDpId = new Map(
    [...registryEntry.dpsByCode].map(([code, dp]) => [String(dp.dpId), code]),
  );

  const entry = {
    deviceId: registryEntry.deviceId,
    name: device.name || registryEntry.name,
    ip,
    local: null,
    cloud: registryEntry.cloud,
    transport: 'cloud',
    dpsByCode: registryEntry.dpsByCode,
    codeByDpId,
    ...tables,
    values: new Map(),
    lastKnownState: new Map(),
    lastSelection: undefined,
  };
  delete entry.features;

  if (!ip) {
    // No LAN IP known yet (UDP broadcast + manual override both empty): still
    // register the connection entry — with a no-op `local` — so commands use
    // the Tuya Cloud fallback, and cloud states (src/cloudStates.js) reach
    // it. connectDevice() runs again (periodic refresh) once an IP becomes
    // known, upgrading this to a real local session then.
    logger.warn(
      `No LAN IP known for ${device.external_id} yet (UDP broadcast + manual override both empty) — cloud-only for now`,
    );
    entry.local = NO_IP_LOCAL_CLIENT;
    connections.set(device.external_id, entry);
    return;
  }

  entry.local = createTuyaLocalClient({
    id: registryEntry.deviceId,
    key: registryEntry.localKey,
    ip,
    version: registryEntry.version || config.protocol_version,
    reconnectIntervalSeconds: 10,
    onConnect: () => {
      logger.info(`${device.external_id}: local session connected (${ip})`);
      publishTransport(gladys, entry, device.external_id, DEVICE_TRANSPORTS.LOCAL);
      gladys.setConnectionStatus(true).catch(() => {});
    },
    onData: (dps) => {
      applyDps(gladys, device.external_id, dps).catch((err) =>
        logger.error(`Applying the DPs of ${device.external_id} failed: ${err.message}`),
      );
    },
    onDisconnect: (consecutiveFailures) => {
      if (consecutiveFailures < CONNECTION_FAILURE_THRESHOLD) {
        return;
      }
      // Degrade to the cloud command/status API rather than declaring the
      // device fully unreachable — see "Degraded state" in the SDK README.
      publishTransport(gladys, entry, device.external_id, DEVICE_TRANSPORTS.CLOUD, {
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

/** The connection of one vacuum (read-only use: widgets, scene actions, zones). */
export function getConnection(externalId) {
  return connections.get(externalId);
}

/** Every connection, as `[externalId, entry]` pairs. */
export function listConnections() {
  return [...connections.entries()];
}

/** Best-effort Tuya Cloud command, used when the local session is down. */
async function sendCloudCommand(entry, code, value) {
  if (!entry.cloud) {
    throw new Error('No Tuya Cloud client available for this device');
  }
  await entry.cloud.sendCommand(entry.deviceId, code, value);
}

/**
 * Send one DP value to a vacuum: local session when connected and preferred
 * (GLADYS_PREFER_LOCAL, default true), Tuya Cloud otherwise.
 * @param {{ dpId: number, code: string }} target
 */
export async function sendDpCommand(gladys, externalId, target, value, config) {
  const entry = connections.get(externalId);
  if (!entry) {
    throw new Error(`${externalId} is not connected`);
  }
  const preferLocal = config?.GLADYS_PREFER_LOCAL !== false;
  if (preferLocal && entry.local.isConnected()) {
    const ok = await entry.local.set(target.dpId, value);
    if (ok) {
      return 'local';
    }
    logger.warn(`Local set failed for ${externalId}:${target.code}, falling back to cloud`);
  }

  await sendCloudCommand(entry, target.code, value);
  // Degraded unless the user deliberately turned off "prefer local"
  // (GLADYS_PREFER_LOCAL: false) — that's the one case where routing
  // through the cloud is the nominal, expected behavior rather than a
  // fallback from a local failure.
  await publishTransport(gladys, entry, externalId, DEVICE_TRANSPORTS.CLOUD, {
    degraded: preferLocal,
  });
  return 'cloud';
}

/** Send the robot home: `switch_charge` when it has one, the dock value of `mode` otherwise. */
export async function returnToDock(gladys, externalId, config) {
  const entry = connections.get(externalId);
  if (entry?.commands?.dock) {
    return sendDpCommand(gladys, externalId, entry.commands.dock, true, config);
  }
  const mode = entry?.featureKeyToDp.get('mode');
  if (entry?.dockValue === undefined || !mode) {
    throw new Error('This vacuum has no "return to dock" command');
  }
  return sendDpCommand(gladys, externalId, mode, entry.dockValue, config);
}

/** Send one zone's room/zone command on the robot's `command_trans` DP. */
export async function cleanZone(gladys, externalId, zone, config) {
  const entry = connections.get(externalId);
  if (!entry?.commands?.commandTrans) {
    throw new Error('This vacuum takes no room or zone command (no command_trans DP)');
  }
  return sendDpCommand(gladys, externalId, entry.commands.commandTrans, zone.command, config);
}

/**
 * Dispatch a Gladys command (a feature value set from the dashboard, a scene
 * or a widget's device_feature button) to the right DP.
 */
export async function onSetValue(gladys, { device, feature, value, config }) {
  const entry = connections.get(device.external_id);
  if (!entry) {
    throw new Error(`${device.external_id} is not connected`);
  }

  const key = feature.external_id.slice(device.external_id.length + 1);

  if (key === 'dock') {
    await returnToDock(gladys, device.external_id, config);
    return;
  }
  if (key.startsWith(ZONE_KEY_PREFIX)) {
    const zone = (entry.zones ?? []).find((z) => zoneFeatureKey(z) === key);
    if (!zone) {
      throw new Error(`Zone "${key.slice(ZONE_KEY_PREFIX.length)}" is no longer configured`);
    }
    await cleanZone(gladys, device.external_id, zone, config);
    return;
  }

  const target = entry.featureKeyToDp.get(key);
  if (!target) {
    throw new Error(`Feature "${key}" is not controllable on this device`);
  }
  const dpValue = target.encode ? target.encode(value) : formatOutgoingValue(target.dpType, value);
  await sendDpCommand(gladys, device.external_id, target, dpValue, config);
}

/** `test_connection` manifest action: report the local session + last known state. */
export async function runTestConnectionAction(gladys, { fields }) {
  const entry = connections.get(fields.device);
  if (!entry) {
    // Throwing (see below) rather than resolving is what turns this red in
    // the Configuration screen — connectivity could not be verified at all.
    throw new Error('This vacuum has not been connected yet. Check the integration logs.');
  }

  const localConnected = entry.local.isConnected();
  const state = [...entry.lastKnownState.entries()]
    .map(([key, value]) => `${key}=${value?.text ?? value}`)
    .join(', ');

  if (!localConnected) {
    if (!entry.cloud) {
      throw new Error(
        'Not reachable locally, and no Tuya Cloud client is configured as a fallback',
      );
    }
    try {
      const status = await entry.cloud.getStatus(entry.deviceId);
      const cloudState = status.map((s) => `${s.code}=${s.value}`).join(', ');
      return {
        en: `Local session down, reached via Tuya Cloud instead. State: ${cloudState || '(empty)'}.`,
        fr: `Session locale indisponible, jointe via le cloud Tuya. État : ${cloudState || '(vide)'}.`,
      };
    } catch (err) {
      // Throwing (rather than resolving with a "failure" message) is what
      // actually turns the action's result red in the Configuration screen
      // — resolving always acks success regardless of what the message
      // says, which used to show a green "not reachable" result.
      throw new Error(`Not reachable locally nor via the Tuya Cloud API: ${err.message}`, {
        cause: err,
      });
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
  changeListener = null;
}

/** Test-only hook: inject a fake connection registry entry. Not used by production code. */
export function __setConnectionForTesting(externalId, entry) {
  connections.set(externalId, {
    values: new Map(),
    lastKnownState: new Map(),
    dpIdToFeatureKey: new Map(),
    featureKeyToDp: new Map(),
    commands: {},
    zones: [],
    ...entry,
  });
}
