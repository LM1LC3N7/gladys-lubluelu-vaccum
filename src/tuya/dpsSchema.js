// -----------------------------------------------------------------------------
// Translate a Tuya device's cloud-reported DP schema into Gladys features.
//
// The whole point of fetching `/v1.1/devices/{id}/specifications` (see
// src/tuya/cloud.js) instead of hardcoding DP numbers: Tuya's "Sweep Robot"
// (scwxcy) product category has a standard set of `code` names (switch_status,
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

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

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

// User-facing labels for enum values this integration recognizes across
// brands (Tuya's `values.range` only carries the raw machine tokens).
const MODE_LABELS = {
  smart: { en: 'Smart', fr: 'Intelligent' },
  auto: { en: 'Smart', fr: 'Intelligent' },
  wall_follow: { en: 'Along walls', fr: 'Le long des murs' },
  spot: { en: 'Spot', fr: 'Zone ciblée' },
  single: { en: 'Single room', fr: 'Pièce unique' },
  chargego: { en: 'Return to dock', fr: 'Retour à la base' },
  standby: { en: 'Standby', fr: 'Veille' },
  pause: { en: 'Paused', fr: 'En pause' },
  mop: { en: 'Mopping', fr: 'Serpillière' },
  left_spiral: { en: 'Spiral (left)', fr: 'Spirale (gauche)' },
  right_spiral: { en: 'Spiral (right)', fr: 'Spirale (droite)' },
};

const CISTERN_LABELS = {
  closed: { en: 'Off', fr: 'Coupée' },
  low: { en: 'Low', fr: 'Faible' },
  middle: { en: 'Medium', fr: 'Moyenne' },
  high: { en: 'High', fr: 'Élevée' },
};

const SUCTION_LABELS = {
  gentle: { en: 'Quiet', fr: 'Silencieux' },
  quiet: { en: 'Quiet', fr: 'Silencieux' },
  normal: { en: 'Normal', fr: 'Normal' },
  strong: { en: 'Strong', fr: 'Puissant' },
  high: { en: 'Strong', fr: 'Puissant' },
  max: { en: 'Max', fr: 'Maximum' },
  boost_iq: { en: 'Boost', fr: 'Boost' },
};

// Values in `mode`'s enum that mean "go back to the dock" — used to decide
// whether the VACUUM_CLEANER.DOCK convenience feature can be built (see
// buildFeatures() in src/devices/vacuum.js), and, by onSetValue(), which
// `mode` value to send when the user presses it.
export const DOCK_MODE_VALUES = ['chargego', 'charge_go', 'go_charge', 'docking', 'dock'];

function labelFor(table, value) {
  return table[value] ?? { en: value, fr: value };
}

function optionsFromRange(range, table, language) {
  return (range ?? []).map((value) => ({ value, label: labelFor(table, value)[language] }));
}

/**
 * KNOWN_CODES: `code -> (dpsEntry, language) => featureBlueprint | undefined`.
 * `language` picks the option labels' language ('fr' falls back to French
 * Gladys UIs; the feature `name` itself stays English-only like the rest of
 * this integration's device/feature names, consistent with the other
 * repos this one reuses the pattern from). A builder returns `undefined`
 * when the entry's `type` doesn't match what it expects (e.g. `mode` schema
 * that came back as something other than "Enum") so a surprising schema
 * degrades to "feature not built" rather than a bad one.
 */
export const KNOWN_CODES = {
  switch_status: buildBinarySwitch('Power'),
  power_go: buildBinarySwitch('Power'),
  pause: buildBinarySwitch('Pause'),

  mode: (entry, language) => {
    if (entry.type !== 'Enum' || !Array.isArray(entry.values.range)) {
      return undefined;
    }
    return {
      key: 'mode',
      name: 'Mode',
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
      name: 'Water level',
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

  fault: (entry) => {
    if (entry.type !== 'Value' && entry.type !== 'Bitmap' && entry.type !== 'Integer') {
      return undefined;
    }
    return {
      key: 'fault',
      name: 'Fault code',
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

  seek: (entry) => {
    if (entry.type !== 'Boolean') {
      return undefined;
    }
    return {
      key: 'seek',
      name: 'Find robot',
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      dpId: entry.dpId,
    };
  },

  roll_brush: buildMaintenance('Roll brush', 'roll_brush'),
  edge_brush: buildMaintenance('Side brush', 'edge_brush'),
  filter: buildMaintenance('Filter', 'filter'),
};

function buildBinarySwitch(name) {
  return (entry) => {
    if (entry.type !== 'Boolean') {
      return undefined;
    }
    return {
      key: name.toLowerCase().replace(/\s+/g, '_'),
      name,
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
      dpId: entry.dpId,
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
      name: 'Suction power',
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
  return (entry) => {
    if (entry.type !== 'Value' && entry.type !== 'Integer') {
      return undefined;
    }
    return {
      key: 'battery',
      name: 'Battery',
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

function buildMaintenance(name, key) {
  return (entry) => {
    if (entry.type !== 'Value' && entry.type !== 'Integer') {
      return undefined;
    }
    return {
      key,
      name,
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
 * @param {Map<string, {dpId:number,type:string,values:object}>} dpsByCode
 * @param {'en'|'fr'} [language]
 */
export function buildKnownFeatures(dpsByCode, language = 'en') {
  const features = [];
  for (const [code, builder] of Object.entries(KNOWN_CODES)) {
    const entry = dpsByCode.get(code);
    if (!entry) {
      continue;
    }
    const feature = builder(entry, language);
    if (feature) {
      features.push({ ...feature, code });
    }
  }
  return features;
}
