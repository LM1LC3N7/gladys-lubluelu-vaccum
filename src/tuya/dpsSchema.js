// -----------------------------------------------------------------------------
// Translate a Tuya device's cloud-reported DP schema into Gladys features.
//
// The whole point of fetching `/v1.1/devices/{id}/specifications` (see
// src/tuya/cloud.js) instead of hardcoding DP numbers: Tuya's "Robot vacuum"
// (`sd`) product category has a standard set of `code` names (switch_status,
// mode, electricity_left...), but which numeric `dp_id` each one sits behind
// is assigned per-device at pairing time and varies across firmwares/SKUs —
// exactly the "specific to firmware" trap flagged when this integration was
// scoped. Reading the schema from Tuya's own catalog turns that into a
// lookup by stable name instead of a manual "watch the traffic and guess"
// exercise, and keeps working across SL68 firmware revisions and other
// Tuya-based sweep robots alike.
//
// KNOWN_CODES below is this integration's own knowledge of what a handful of
// standard codes usually mean and how to present them in Gladys — it is
// consulted only for codes the device's schema actually reports (never
// invents a feature for a code that isn't there), so an unrecognized or
// missing code just means one fewer feature, never a crash. See the
// project's README "Tested and confirmed" section for which of these have
// been seen on a real SL68 versus cross-referenced from Tuya's public
// category documentation only.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  CISTERN_LABELS,
  FAULT_LABELS,
  FEATURE_NAMES,
  MODE_LABELS,
  SUCTION_LABELS,
  TEXTS,
  pick,
} from '../i18n.js';

/** Parse the schema entry's `values` JSON string (range/min-max/unit...). Never throws. */
export function parseValues(rawValues) {
  if (!rawValues) {
    return {};
  }
  try {
    return JSON.parse(rawValues);
  } catch {
    return {};
  }
}

/**
 * Index the `functions`/`status` arrays of a `/specifications` response by
 * `code`, merging both (a `status`-only code is still readable; a
 * `functions`-only one would be write-only, not expected for a vacuum).
 * @returns {Map<string, { dpId: number, type: string, values: object }>}
 */
export function indexDpsByCode(specifications) {
  const byCode = new Map();
  const entries = [...(specifications?.status ?? []), ...(specifications?.functions ?? [])];
  for (const entry of entries) {
    if (byCode.has(entry.code)) {
      continue; // functions/status commonly repeat the same code; first one wins.
    }
    byCode.set(entry.code, {
      dpId: entry.dp_id,
      type: entry.type,
      values: parseValues(entry.values),
    });
  }
  return byCode;
}

// Gladys VACUUM_CLEANER.STATE values (server/utils/constants.js, unchanged
// up to Gladys 5.1): the core shows them as a translated badge and offers them
// as "device state" scene triggers.
export const VACUUM_STATE = {
  STOPPED: 0,
  RUNNING: 1,
  PAUSED: 2,
  ERROR: 3,
  RETURNING_TO_DOCK: 4,
  CHARGING: 5,
  DOCKED: 6,
};

// Tuya `status` enum value -> Gladys state. Same reading as Home Assistant's
// Tuya vacuum (tuya-device-handlers' VacuumActivityWrapper), plus the values
// seen on Tuya LiDAR robots (select_room, repositing, fault...).
const STATUS_TO_STATE = {
  standby: VACUUM_STATE.STOPPED,
  sleep: VACUUM_STATE.STOPPED,
  cleaning: VACUUM_STATE.RUNNING,
  smart: VACUUM_STATE.RUNNING,
  smart_clean: VACUUM_STATE.RUNNING,
  wall_clean: VACUUM_STATE.RUNNING,
  wall_follow: VACUUM_STATE.RUNNING,
  spot_clean: VACUUM_STATE.RUNNING,
  zone_clean: VACUUM_STATE.RUNNING,
  part_clean: VACUUM_STATE.RUNNING,
  pick_zone_clean: VACUUM_STATE.RUNNING,
  select_room: VACUUM_STATE.RUNNING,
  mop_clean: VACUUM_STATE.RUNNING,
  random: VACUUM_STATE.RUNNING,
  goto_pos: VACUUM_STATE.RUNNING,
  pos_arrived: VACUUM_STATE.RUNNING,
  pos_unarrive: VACUUM_STATE.RUNNING,
  repositing: VACUUM_STATE.RUNNING,
  paused: VACUUM_STATE.PAUSED,
  fault: VACUUM_STATE.ERROR,
  error: VACUUM_STATE.ERROR,
  goto_charge: VACUUM_STATE.RETURNING_TO_DOCK,
  docking: VACUUM_STATE.RETURNING_TO_DOCK,
  charging: VACUUM_STATE.CHARGING,
  charge_done: VACUUM_STATE.DOCKED,
  chargecompleted: VACUUM_STATE.DOCKED,
  chargego: VACUUM_STATE.DOCKED,
};

/** Gladys state of a raw Tuya `status` value, `undefined` when unknown. */
export function vacuumStateOf(rawStatus) {
  return STATUS_TO_STATE[String(rawStatus ?? '').toLowerCase()];
}

// Values in `mode`'s enum that mean "go back to the dock" — used to decide
// whether the VACUUM_CLEANER.DOCK feature can be built without a
// `switch_charge` DP (see src/devices/vacuum.js#buildFeatures()).
export const DOCK_MODE_VALUES = ['chargego', 'charge_go', 'go_charge', 'docking', 'dock'];

function labelFor(table, value) {
  return table[value] ?? { en: value, fr: value };
}

function optionsFromRange(range, table, language) {
  return (range ?? []).map((value) => ({ value, label: pick(labelFor(table, value), language) }));
}

/** Divide a Tuya Value DP by 10^scale (`values.scale`, 0 when absent). */
export function scaled(value, values) {
  const scale = Number(values?.scale) || 0;
  const number = Number(value);
  return scale > 0 && Number.isFinite(number) ? number / 10 ** scale : number;
}

function isNumberType(entry) {
  return entry.type === 'Value' || entry.type === 'Integer';
}

/**
 * Human-readable faults from the `fault` bitmap: the schema's own bit labels
 * (`values.label`) when it reports some, translated when known.
 * @returns {string[]} empty when no bit is set
 */
export function faultLabels(value, values, language) {
  const code = Number(value) || 0;
  if (code === 0) {
    return [];
  }
  const names = Array.isArray(values?.label) ? values.label : [];
  const labels = [];
  for (let bit = 0; bit < 32; bit += 1) {
    if (code & (2 ** bit)) {
      const name = names[bit];
      labels.push(name ? pick(labelFor(FAULT_LABELS, name), language) : `#${bit}`);
    }
  }
  return labels.length > 0 ? labels : [pick(TEXTS.unknownFault, language)(code)];
}

/**
 * KNOWN_CODES: `code -> (dpsEntry, language) => featureBlueprint | undefined`.
 * A builder returns `undefined` when the entry's `type` doesn't match what it
 * expects (e.g. a `mode` schema that came back as something other than
 * "Enum"), so a surprising schema degrades to "feature not built" rather than
 * a bad one. A blueprint may carry `decode(raw)` (device -> Gladys value) and
 * `encode(value)` (Gladys -> device value) when the raw DP value isn't the
 * Gladys one as is. Feature `name`s are frozen by Gladys at creation: they
 * follow the `language` config field (see src/i18n.js).
 *
 * The order matters: the first alias of a key wins (see buildKnownFeatures()).
 */
export const KNOWN_CODES = {
  status: (entry, language) => {
    if (entry.type !== 'Enum') {
      return undefined;
    }
    return {
      key: 'state',
      name: pick(FEATURE_NAMES.state, language),
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.VACUUM_CLEANER.STATE,
      min: VACUUM_STATE.STOPPED,
      max: VACUUM_STATE.DOCKED,
      read_only: true,
      has_feedback: true,
      // A handful of transitions per cleaning: cheap, and what "how often
      // does it run" charts are made of.
      keep_history: true,
      dpId: entry.dpId,
      decode: vacuumStateOf,
    };
  },

  switch_status: buildBinarySwitch('power', FEATURE_NAMES.power),
  power_go: buildBinarySwitch('power', FEATURE_NAMES.power),
  pause: buildBinarySwitch('pause', FEATURE_NAMES.pause),

  mode: (entry, language) => {
    if (entry.type !== 'Enum' || !Array.isArray(entry.values.range)) {
      return undefined;
    }
    return {
      key: 'mode',
      name: pick(FEATURE_NAMES.mode, language),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      supported_options: optionsFromRange(entry.values.range, MODE_LABELS, language),
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
      dpId: entry.dpId,
      rawValues: entry.values.range,
    };
  },

  cistern: (entry, language) => {
    if (entry.type !== 'Enum' || !Array.isArray(entry.values.range)) {
      return undefined;
    }
    return {
      key: 'cistern',
      name: pick(FEATURE_NAMES.cistern, language),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      supported_options: optionsFromRange(entry.values.range, CISTERN_LABELS, language),
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: false,
      dpId: entry.dpId,
      rawValues: entry.values.range,
    };
  },

  suction: buildSuctionSelect('suction'),
  power_level: buildSuctionSelect('power_level'),
  speed: buildSuctionSelect('speed'),

  electricity_left: buildBattery(),
  battery_percentage: buildBattery(),

  fault: (entry, language) => {
    if (entry.type !== 'Value' && entry.type !== 'Bitmap' && entry.type !== 'Integer') {
      return undefined;
    }
    return {
      key: 'fault',
      name: pick(FEATURE_NAMES.fault, language),
      // No neutral "just a number" category in the SDK (same situation as
      // gladys-denon-avr's "Source index" feature) — reusing this device's
      // own category (VACUUM_CLEANER) paired with the generic SENSOR type.
      category: DEVICE_FEATURE_CATEGORIES.VACUUM_CLEANER,
      type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
      min: 0,
      max: entry.values.max ?? 65535,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      dpId: entry.dpId,
    };
  },

  seek: buildPushButton('seek', FEATURE_NAMES.seek),

  // Session and lifetime counters. The session ones move every few seconds
  // while cleaning: no history by default (Gladys 5.1.2 flags "verbose"
  // devices; the user can still turn it on per feature since Gladys 5.0).
  clean_area: buildMeasure('clean_area', FEATURE_NAMES.clean_area, 'surface', false),
  clean_time: buildMeasure('clean_time', FEATURE_NAMES.clean_time, 'duration', false),
  total_clean_area: buildMeasure('total_clean_area', FEATURE_NAMES.total_clean_area, 'surface'),
  total_clean_time: buildMeasure('total_clean_time', FEATURE_NAMES.total_clean_time, 'duration'),

  roll_brush: buildMaintenance('roll_brush', FEATURE_NAMES.roll_brush),
  edge_brush: buildMaintenance('edge_brush', FEATURE_NAMES.edge_brush),
  filter: buildMaintenance('filter', FEATURE_NAMES.filter),
  duster_cloth: buildMaintenance('duster_cloth', FEATURE_NAMES.duster_cloth),

  reset_roll_brush: buildPushButton('reset_roll_brush', FEATURE_NAMES.reset_roll_brush),
  reset_edge_brush: buildPushButton('reset_edge_brush', FEATURE_NAMES.reset_edge_brush),
  reset_filter: buildPushButton('reset_filter', FEATURE_NAMES.reset_filter),
  reset_duster_cloth: buildPushButton('reset_duster_cloth', FEATURE_NAMES.reset_duster_cloth),

  switch_disturb: buildBinarySwitch('switch_disturb', FEATURE_NAMES.switch_disturb, false),
};

/** The consumables, in display order: wear feature key -> its reset DP code. */
export const CONSUMABLES = [
  { key: 'filter', reset: 'reset_filter' },
  { key: 'edge_brush', reset: 'reset_edge_brush' },
  { key: 'roll_brush', reset: 'reset_roll_brush' },
  { key: 'duster_cloth', reset: 'reset_duster_cloth' },
];

function buildBinarySwitch(key, names, keepHistory = true) {
  return (entry, language) => {
    if (entry.type !== 'Boolean') {
      return undefined;
    }
    return {
      key,
      name: pick(names, language),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: keepHistory,
      dpId: entry.dpId,
    };
  };
}

function buildPushButton(key, names) {
  return (entry, language) => {
    if (entry.type !== 'Boolean') {
      return undefined;
    }
    return {
      key,
      name: pick(names, language),
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      dpId: entry.dpId,
      // A push is a one-shot: whatever value Gladys sends, the DP gets `true`.
      encode: () => true,
    };
  };
}

function buildSuctionSelect(key) {
  return (entry, language) => {
    if (entry.type !== 'Enum' || !Array.isArray(entry.values.range)) {
      return undefined;
    }
    return {
      key,
      name: pick(FEATURE_NAMES.suction, language),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
      supported_options: optionsFromRange(entry.values.range, SUCTION_LABELS, language),
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: false,
      dpId: entry.dpId,
      rawValues: entry.values.range,
    };
  };
}

function buildBattery() {
  return (entry, language) => {
    if (!isNumberType(entry)) {
      return undefined;
    }
    return {
      key: 'battery',
      name: pick(FEATURE_NAMES.battery, language),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: 'percent',
      min: entry.values.min ?? 0,
      max: entry.values.max ?? 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      dpId: entry.dpId,
    };
  };
}

// Tuya reports these two in m² and minutes on the robot-vacuum category (Home
// Assistant's Tuya sensors read them the same way), after `values.scale`.
const MEASURES = {
  surface: {
    category: DEVICE_FEATURE_CATEGORIES.SURFACE,
    type: DEVICE_FEATURE_TYPES.SURFACE.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.SQUARE_METER,
  },
  duration: {
    category: DEVICE_FEATURE_CATEGORIES.DURATION,
    type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
    unit: DEVICE_FEATURE_UNITS.MINUTES,
  },
};

function buildMeasure(key, names, kind, keepHistory = true) {
  return (entry, language) => {
    if (!isNumberType(entry)) {
      return undefined;
    }
    return {
      key,
      name: pick(names, language),
      ...MEASURES[kind],
      min: 0,
      max: scaled(entry.values.max ?? 1_000_000, entry.values),
      read_only: true,
      has_feedback: false,
      keep_history: keepHistory,
      dpId: entry.dpId,
      decode: (raw) => scaled(raw, entry.values),
    };
  };
}

function buildMaintenance(key, names) {
  return (entry, language) => {
    if (!isNumberType(entry)) {
      return undefined;
    }
    return {
      key,
      name: pick(names, language),
      category: DEVICE_FEATURE_CATEGORIES.MAINTENANCE,
      type: DEVICE_FEATURE_TYPES.MAINTENANCE.LIFE_REMAINING,
      unit: 'percent',
      min: 0,
      max: entry.values.max ?? 100,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      dpId: entry.dpId,
    };
  };
}

/**
 * Build every Gladys feature this integration recognizes for a device,
 * from its cloud-reported DP schema. Codes the device doesn't report, or
 * whose live `type` doesn't match what a builder expects, are silently
 * skipped (see the module doc comment above) — never an error.
 *
 * Several codes are aliases of one feature (`switch_status`/`power_go` ->
 * `power`, `electricity_left`/`battery_percentage` -> `battery`): when a
 * device reports more than one of them, only the first in KNOWN_CODES order
 * is built. Building both used to emit two features with the SAME
 * external_id, and map two DPs onto one feature key.
 * @param {Map<string, {dpId:number,type:string,values:object}>} dpsByCode
 * @param {'en'|'fr'} [language]
 */
export function buildKnownFeatures(dpsByCode, language = 'en') {
  const features = [];
  const builtKeys = new Set();
  for (const [code, builder] of Object.entries(KNOWN_CODES)) {
    const entry = dpsByCode.get(code);
    if (!entry) {
      continue;
    }
    const feature = builder(entry, language);
    if (feature && !builtKeys.has(feature.key)) {
      builtKeys.add(feature.key);
      features.push({ ...feature, code });
    }
  }
  return features;
}

/**
 * The DPs the integration drives without a feature of their own: the
 * command DPs behind widget buttons, scene actions and zone cleaning.
 * @returns {{ dock?: object, direction?: object, commandTrans?: object,
 *   start?: object, pause?: object, seek?: object, mode?: object }}
 */
export function commandDps(dpsByCode) {
  const pickDp = (code, type) => {
    const entry = dpsByCode.get(code);
    return entry && (!type || entry.type === type)
      ? { code, dpId: entry.dpId, type: entry.type, values: entry.values }
      : undefined;
  };
  return {
    dock: pickDp('switch_charge', 'Boolean'),
    direction: pickDp('direction_control', 'Enum'),
    commandTrans: pickDp('command_trans', 'Raw'),
    start: pickDp('power_go', 'Boolean') ?? pickDp('switch_go', 'Boolean'),
    pause: pickDp('pause', 'Boolean'),
    seek: pickDp('seek', 'Boolean'),
    mode: pickDp('mode', 'Enum'),
  };
}
