// -----------------------------------------------------------------------------
// What a DP change MEANS beyond its feature value: scene triggers (Gladys 5.1)
// and widget refresh nudges, computed from each batch applyDps() hands over.
//
// Scene events follow the SDK doctrine: a value is a device feature (the
// robot's state already is one, usable as a "device state" scene trigger); an
// event says "this happened" — once per TRANSITION, never on the first value
// seen after a restart (nothing happened, the integration just woke up):
//   - cleaning_finished: a cleaning session ended with the robot going home
//     (cleaning -> returning / charging / docked, pauses in between allowed);
//   - vacuum_error: a fault appeared (fault bitmap 0 -> non-zero, or the
//     state turned to "error" on a robot without a fault DP);
//   - consumable_low: a part's remaining life crossed CONSUMABLE_LOW_PERCENT.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { CONSUMABLES, VACUUM_STATE, faultLabels, scaled, vacuumStateOf } from './tuya/dpsSchema.js';

const logger = createLogger({ name: 'events' });

/** Scene trigger keys, declared in the manifest `scene_triggers` (forever: never rename). */
export const SCENE_TRIGGER = {
  CLEANING_FINISHED: 'cleaning_finished',
  VACUUM_ERROR: 'vacuum_error',
  CONSUMABLE_LOW: 'consumable_low',
};

export const CONSUMABLE_LOW_PERCENT = 10;

const HOME_STATES = new Set([
  VACUUM_STATE.RETURNING_TO_DOCK,
  VACUUM_STATE.CHARGING,
  VACUUM_STATE.DOCKED,
]);

// The codes each widget shows: a change re-pulls it (see onWidgetGet).
const WIDGET_CODES = {
  vacuum: [
    'status',
    'mode',
    'suction',
    'power_level',
    'speed',
    'cistern',
    'fault',
    'electricity_left',
    'battery_percentage',
    'clean_area',
    'clean_time',
  ],
  quick_clean: ['status', 'mode'],
  remote: ['status'],
  maintenance: [...CONSUMABLES.map((c) => c.key)],
};

function numberOf(entry, code) {
  const dp = entry.dpsByCode?.get(code);
  const raw = entry.values.get(code);
  return dp && raw !== undefined ? scaled(raw, dp.values) : undefined;
}

/**
 * The scene events one batch of changes fires. Pure: `entry` carries the new
 * raw values, `previous` the ones before the batch, `session` a small mutable
 * per-vacuum memory (is a cleaning session under way).
 * @returns {Array<{ key: string, data: object }>}
 */
export function sceneEventsFor(externalId, { changedCodes, previous, entry }, session, language) {
  const events = [];
  const changed = new Set(changedCodes);

  if (changed.has('status')) {
    const before = vacuumStateOf(previous.get('status'));
    const now = vacuumStateOf(entry.values.get('status'));
    if (now === VACUUM_STATE.RUNNING) {
      session.cleaning = true;
    } else if (session.cleaning && HOME_STATES.has(now)) {
      session.cleaning = false;
      events.push({
        key: SCENE_TRIGGER.CLEANING_FINISHED,
        data: {
          vacuum: externalId,
          area_m2: numberOf(entry, 'clean_area') ?? null,
          duration_min: numberOf(entry, 'clean_time') ?? null,
          battery:
            numberOf(entry, 'electricity_left') ?? numberOf(entry, 'battery_percentage') ?? null,
        },
      });
    } else if (now === VACUUM_STATE.STOPPED) {
      session.cleaning = false; // Stopped by hand: not a finished cleaning.
    }

    const hasFaultDp = entry.dpsByCode?.has('fault');
    if (
      !hasFaultDp &&
      before !== undefined &&
      before !== VACUUM_STATE.ERROR &&
      now === VACUUM_STATE.ERROR
    ) {
      events.push({
        key: SCENE_TRIGGER.VACUUM_ERROR,
        data: {
          vacuum: externalId,
          error_code: null,
          error_message: String(entry.values.get('status')),
        },
      });
    }
  }

  if (changed.has('fault') && previous.has('fault')) {
    const before = Number(previous.get('fault')) || 0;
    const now = Number(entry.values.get('fault')) || 0;
    if (before === 0 && now !== 0) {
      const values = entry.dpsByCode?.get('fault')?.values;
      events.push({
        key: SCENE_TRIGGER.VACUUM_ERROR,
        data: {
          vacuum: externalId,
          error_code: now,
          error_message: faultLabels(now, values, language).join(', '),
        },
      });
    }
  }

  for (const { key } of CONSUMABLES) {
    if (!changed.has(key) || !previous.has(key)) {
      continue;
    }
    const before = Number(previous.get(key));
    const now = Number(entry.values.get(key));
    if (before >= CONSUMABLE_LOW_PERCENT && now < CONSUMABLE_LOW_PERCENT) {
      events.push({
        key: SCENE_TRIGGER.CONSUMABLE_LOW,
        data: { vacuum: externalId, consumable: key, remaining_percent: now },
      });
    }
  }
  return events;
}

/** The widget keys a batch of changed codes makes stale. */
export function staleWidgets(changedCodes) {
  const changed = new Set(changedCodes);
  return Object.keys(WIDGET_CODES).filter((key) =>
    WIDGET_CODES[key].some((code) => changed.has(code)),
  );
}

/**
 * The change listener plugged into src/devices/vacuum.js#onVacuumChange():
 * fires the scene events and nudges the stale widgets.
 * @param {{ gladys: object, getLanguage: () => string }} deps
 */
export function createChangeListener({ gladys, getLanguage }) {
  const sessions = new Map();
  return async (externalId, batch) => {
    if (!sessions.has(externalId)) {
      sessions.set(externalId, { cleaning: false });
    }
    const events = sceneEventsFor(externalId, batch, sessions.get(externalId), getLanguage());
    for (const { key, data } of events) {
      logger.info(`Scene event ${key} for ${externalId}`);
      try {
        await gladys.publishSceneEvent(key, data);
      } catch (err) {
        // A Gladys older than 5.1, or a scene trigger not declared yet.
        logger.warn(`publishSceneEvent(${key}) failed: ${err.message}`);
      }
    }
    for (const widget of staleWidgets(batch.changedCodes)) {
      try {
        gladys.requestWidgetRefresh(widget);
      } catch (err) {
        logger.debug(`requestWidgetRefresh(${widget}) failed: ${err.message}`);
      }
    }
  };
}
