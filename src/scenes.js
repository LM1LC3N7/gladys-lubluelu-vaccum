// -----------------------------------------------------------------------------
// Scene actions (Gladys 5.1+) and the widget buttons — what actually runs
// when a scene reaches an action of this integration, or a dashboard button
// is tapped. Both resolve to the same commands (src/cleaning.js).
//
// Scene actions:
//   - start_cleaning: program, suction and water level applied TOGETHER, then
//     the start — one card in a scene instead of three "control a device";
//   - clean_zone: clean a named zone (typed or learned, src/zones.js).
// Plain "return to dock" or "locate" need no action of their own: the
// device's dock and locate features already are scene-controllable.
//
// A scene action receives no user language (the core sends none): its error
// messages are English, its outputs plain values.
// -----------------------------------------------------------------------------

import {
  cleanZone,
  locate,
  move,
  pause,
  resume,
  returnToDock,
  startCleaning,
  stop,
} from './cleaning.js';
import { getConnection, sendDpCommand } from './devices/vacuum.js';
import { findZone } from './zones.js';

/** Scene action keys, declared in the manifest `scene_actions` (forever: never rename). */
export const SCENE_ACTION = {
  START_CLEANING: 'start_cleaning',
  CLEAN_ZONE: 'clean_zone',
};

function vacuumOf(fields) {
  const externalId = typeof fields?.vacuum === 'string' ? fields.vacuum.trim() : '';
  if (!externalId || !getConnection(externalId)) {
    throw new Error(`Unknown or disconnected vacuum: ${externalId || '(none)'}`);
  }
  return externalId;
}

/** `start_cleaning`: resolves the `transport` output ('local' or 'cloud'). */
export async function runStartCleaning(gladys, fields, config) {
  const externalId = vacuumOf(fields);
  const transport = await startCleaning(
    gladys,
    externalId,
    { program: fields.program, suction: fields.suction, water: fields.water },
    config,
  );
  return { transport };
}

/** `clean_zone`: resolves the `transport` output. */
export async function runCleanZone(gladys, fields, config) {
  const externalId = vacuumOf(fields);
  const entry = getConnection(externalId);
  const zone = findZone(entry.zones ?? [], fields.zone);
  if (!zone) {
    const known = (entry.zones ?? []).map((z) => z.name).join(', ') || '(none)';
    throw new Error(`Unknown zone "${fields.zone}". Known zones: ${known}`);
  }
  const transport = await cleanZone(gladys, externalId, zone, config);
  return { transport };
}

/**
 * Run one widget command (src/widgets.js#widgetCommand()).
 * @returns {Promise<string>} a label for the toast (zone or part name)
 */
export async function runWidgetCommand(gladys, command, config) {
  const entry = getConnection(command.vacuum);
  if (!entry) {
    throw new Error('This vacuum is not connected');
  }
  switch (command.kind) {
    case 'start':
      await startCleaning(gladys, command.vacuum, {}, config);
      return '';
    case 'resume':
      await resume(gladys, command.vacuum, config);
      return '';
    case 'pause':
      await pause(gladys, command.vacuum, config);
      return '';
    case 'stop':
      await stop(gladys, command.vacuum, config);
      return '';
    case 'dock':
      await returnToDock(gladys, command.vacuum, config);
      return '';
    case 'locate':
      await locate(gladys, command.vacuum, config);
      return '';
    case 'move':
      await move(gladys, command.vacuum, command.value, config);
      return '';
    case 'program':
      await startCleaning(gladys, command.vacuum, { program: command.value }, config);
      return command.value;
    case 'zone': {
      const zone = findZone(entry.zones ?? [], command.value);
      if (!zone) {
        throw new Error('This zone is no longer configured');
      }
      await cleanZone(gladys, command.vacuum, zone, config);
      return zone.name;
    }
    case 'reset': {
      const reset = `reset_${command.value}`;
      const target = entry.featureKeyToDp.get(reset);
      if (!target) {
        throw new Error('This part cannot be reset from Gladys');
      }
      await sendDpCommand(gladys, command.vacuum, target, true, config);
      return command.value;
    }
    default:
      throw new Error(`Unsupported command: ${command.kind}`);
  }
}
