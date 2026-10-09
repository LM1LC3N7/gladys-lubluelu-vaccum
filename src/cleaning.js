// -----------------------------------------------------------------------------
// Cleaning programs and one-tap commands, shared by the dashboard widgets
// (src/widgets.js) and the scene actions (src/scenes.js).
//
// A manifest declares its scene-action options and widget buttons once, for
// every robot — but each Tuya robot names its own enum values (`smart` or
// `auto`, `gentle` or `quiet`, `middle` or `medium`...). This module speaks a
// small generic vocabulary and translates it to the robot's own enum, using
// the DP schema it reported; a word the robot has no value for is an explicit
// error, never a silent no-op.
// -----------------------------------------------------------------------------

import { VACUUM_STATE, vacuumStateOf } from './tuya/dpsSchema.js';
import { cleanZone, getConnection, returnToDock, sendDpCommand } from './devices/vacuum.js';

/** Generic program -> the `mode` enum values that mean it, in preference order. */
export const PROGRAMS = {
  auto: ['smart', 'auto'],
  edge: ['wall_follow', 'edge'],
  spot: ['spot', 'spiral', 'left_spiral', 'right_spiral'],
  mop: ['mop'],
};

export const SUCTION_LEVELS = {
  quiet: ['gentle', 'quiet', 'low'],
  normal: ['normal', 'standard'],
  strong: ['strong', 'high'],
  max: ['max', 'boost_iq', 'turbo'],
};

export const WATER_LEVELS = {
  off: ['closed', 'off'],
  low: ['low'],
  medium: ['middle', 'medium'],
  high: ['high'],
};

// Which feature carries each setting (aliases in KNOWN_CODES order).
const SUCTION_KEYS = ['suction', 'power_level', 'speed'];

/** The first enum value of `range` that `candidates` lists, or undefined. */
export function resolveEnum(range, candidates) {
  return (candidates ?? []).find((value) => (range ?? []).includes(value));
}

function rangeOf(entry, code) {
  return entry.dpsByCode?.get(code)?.values?.range ?? [];
}

/** The generic programs this robot can run, in PROGRAMS order. */
export function availablePrograms(entry) {
  const range = rangeOf(entry, 'mode');
  return Object.keys(PROGRAMS).filter(
    (program) =>
      resolveEnum(range, PROGRAMS[program]) !== undefined ||
      (program === 'auto' && Boolean(entry.commands?.start)),
  );
}

/** The generic program the robot reports running, if it maps to one. */
export function currentProgram(entry) {
  const mode = entry.values?.get('mode');
  return Object.keys(PROGRAMS).find((program) => PROGRAMS[program].includes(mode));
}

/** Gladys VACUUM_STATE of a connection, `undefined` when not reported yet. */
export function stateOf(entry) {
  return vacuumStateOf(entry.values?.get('status'));
}

function requireConnection(externalId) {
  const entry = getConnection(externalId);
  if (!entry) {
    throw new Error(`${externalId} is not connected`);
  }
  return entry;
}

async function setEnum(gladys, externalId, entry, featureKeys, table, word, config, what) {
  const key = featureKeys.find((k) => entry.featureKeyToDp.get(k));
  const target = key ? entry.featureKeyToDp.get(key) : undefined;
  const value = target ? resolveEnum(rangeOf(entry, target.code), table[word]) : undefined;
  if (value === undefined) {
    throw new Error(`This vacuum has no "${word}" ${what}`);
  }
  await sendDpCommand(gladys, externalId, target, value, config);
}

/**
 * Start cleaning with an optional program, suction and water level, applied
 * together: settings first, then the program (on Tuya robots, picking a
 * `mode` starts it), or the start DP when no program is asked for.
 * @param {{ program?: string, suction?: string, water?: string }} options
 *   generic words (see PROGRAMS, SUCTION_LEVELS, WATER_LEVELS); empty or
 *   `unchanged` keeps the robot's current setting
 * @returns {Promise<'local'|'cloud'>} the transport the start command took
 */
export async function startCleaning(gladys, externalId, options, config) {
  const entry = requireConnection(externalId);
  const given = (word) => (word && word !== 'unchanged' ? word : undefined);
  const suction = given(options?.suction);
  const water = given(options?.water);
  const program = given(options?.program);

  if (suction) {
    await setEnum(
      gladys,
      externalId,
      entry,
      SUCTION_KEYS,
      SUCTION_LEVELS,
      suction,
      config,
      'suction level',
    );
  }
  if (water) {
    await setEnum(
      gladys,
      externalId,
      entry,
      ['cistern'],
      WATER_LEVELS,
      water,
      config,
      'water level',
    );
  }

  const mode = entry.featureKeyToDp.get('mode');
  const modeValue =
    program && mode ? resolveEnum(rangeOf(entry, 'mode'), PROGRAMS[program]) : undefined;
  if (modeValue !== undefined) {
    return sendDpCommand(gladys, externalId, mode, modeValue, config);
  }
  if (program && program !== 'auto') {
    throw new Error(`This vacuum has no "${program}" program`);
  }
  return resume(gladys, externalId, config);
}

/** Start, or resume a paused clean. */
export async function resume(gladys, externalId, config) {
  const entry = requireConnection(externalId);
  if (stateOf(entry) === VACUUM_STATE.PAUSED && entry.commands?.pause) {
    return sendDpCommand(gladys, externalId, entry.commands.pause, false, config);
  }
  if (entry.commands?.start) {
    return sendDpCommand(gladys, externalId, entry.commands.start, true, config);
  }
  const mode = entry.featureKeyToDp.get('mode');
  const smart = resolveEnum(rangeOf(entry, 'mode'), PROGRAMS.auto);
  if (mode && smart !== undefined) {
    return sendDpCommand(gladys, externalId, mode, smart, config);
  }
  throw new Error('This vacuum has no start command');
}

export async function pause(gladys, externalId, config) {
  const entry = requireConnection(externalId);
  if (entry.commands?.pause) {
    return sendDpCommand(gladys, externalId, entry.commands.pause, true, config);
  }
  if (entry.commands?.start) {
    return sendDpCommand(gladys, externalId, entry.commands.start, false, config);
  }
  throw new Error('This vacuum has no pause command');
}

export async function stop(gladys, externalId, config) {
  const entry = requireConnection(externalId);
  if (entry.commands?.start) {
    return sendDpCommand(gladys, externalId, entry.commands.start, false, config);
  }
  return pause(gladys, externalId, config);
}

export async function locate(gladys, externalId, config) {
  const entry = requireConnection(externalId);
  if (!entry.commands?.seek) {
    throw new Error('This vacuum cannot be located');
  }
  return sendDpCommand(gladys, externalId, entry.commands.seek, true, config);
}

/** The manual-driving moves the robot accepts (its `direction_control` enum). */
export const MOVES = ['forward', 'turn_left', 'turn_right', 'backward', 'stop'];

export function availableMoves(entry) {
  const range = entry.commands?.direction?.values?.range ?? [];
  return MOVES.filter((move) => range.includes(move));
}

export async function move(gladys, externalId, direction, config) {
  const entry = requireConnection(externalId);
  if (!availableMoves(entry).includes(direction)) {
    throw new Error(`This vacuum cannot move "${direction}"`);
  }
  return sendDpCommand(gladys, externalId, entry.commands.direction, direction, config);
}

export { cleanZone, returnToDock };
