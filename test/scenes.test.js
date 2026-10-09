import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSUMABLE_LOW_PERCENT,
  SCENE_TRIGGER,
  createChangeListener,
  sceneEventsFor,
  staleWidgets,
} from '../src/events.js';
import { runCleanZone, runStartCleaning } from '../src/scenes.js';
import { applyDps, onVacuumChange, __clearConnectionsForTesting } from '../src/devices/vacuum.js';
import { encodeRoomClean } from '../src/tuya/sweeper.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { EXTERNAL_ID, registerRobot } from '../test-fixtures/robot.js';

const KITCHEN = { name: 'Kitchen', slug: 'kitchen', command: encodeRoomClean([2]) };

/** Feed a sequence of DP batches, collect the scene events fired. */
async function eventsFor(batches) {
  registerRobot({ zones: [KITCHEN] });
  const gladys = createFakeGladys();
  const fired = [];
  gladys.publishSceneEvent = async (key, data) => fired.push({ key, data });
  gladys.requestWidgetRefresh = () => {};
  onVacuumChange(createChangeListener({ gladys, getLanguage: () => 'fr' }));
  for (const dps of batches) {
    await applyDps(gladys, EXTERNAL_ID, dps);
  }
  return fired;
}

test('cleaning_finished fires once when a cleaning ends at the dock, pauses allowed', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const fired = await eventsFor([
    { 5: 'charge_done', 8: 100 },
    { 5: 'cleaning', 6: 1, 7: 10 },
    { 5: 'paused' },
    { 5: 'cleaning', 6: 30, 7: 255, 8: 61 },
    { 5: 'goto_charge' },
    { 5: 'charging' },
    { 5: 'charge_done' },
  ]);
  assert.deepEqual(fired, [
    {
      key: SCENE_TRIGGER.CLEANING_FINISHED,
      data: { vacuum: EXTERNAL_ID, area_m2: 25.5, duration_min: 30, battery: 61 },
    },
  ]);
});

test('cleaning_finished does not fire for a clean stopped by hand', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const fired = await eventsFor([{ 5: 'cleaning' }, { 5: 'standby' }, { 5: 'charging' }]);
  assert.deepEqual(fired, []);
});

test('vacuum_error fires when a fault appears, never for one already there at start-up', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const fired = await eventsFor([{ 28: 4 }, { 28: 0 }, { 28: 0b11 }, { 28: 0b11 }]);
  assert.deepEqual(fired, [
    {
      key: SCENE_TRIGGER.VACUUM_ERROR,
      data: {
        vacuum: EXTERNAL_ID,
        error_code: 3,
        error_message: 'Brosse latérale, Brosse principale',
      },
    },
  ]);
});

test('consumable_low fires when a part crosses the threshold, not while it stays below', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const fired = await eventsFor([
    { 21: CONSUMABLE_LOW_PERCENT + 2 },
    { 21: CONSUMABLE_LOW_PERCENT - 1 },
    { 21: CONSUMABLE_LOW_PERCENT - 3 },
    { 17: 3 },
  ]);
  assert.deepEqual(fired, [
    {
      key: SCENE_TRIGGER.CONSUMABLE_LOW,
      data: {
        vacuum: EXTERNAL_ID,
        consumable: 'filter',
        remaining_percent: CONSUMABLE_LOW_PERCENT - 1,
      },
    },
  ]);
});

test('sceneEventsFor fires vacuum_error from the state on a robot without a fault DP', () => {
  const entry = {
    dpsByCode: new Map([['status', { dpId: 5 }]]),
    values: new Map([['status', 'fault']]),
  };
  const events = sceneEventsFor(
    EXTERNAL_ID,
    { changedCodes: ['status'], previous: new Map([['status', 'cleaning']]), entry },
    { cleaning: true },
    'en',
  );
  assert.deepEqual(
    events.map((e) => e.key),
    [SCENE_TRIGGER.VACUUM_ERROR],
  );
});

test('staleWidgets names the widgets a change makes out of date', () => {
  assert.deepEqual(staleWidgets(['status']), ['vacuum', 'quick_clean', 'remote']);
  assert.deepEqual(staleWidgets(['filter']), ['maintenance']);
  assert.deepEqual(staleWidgets(['command_trans']), []);
});

test('start_cleaning applies suction and water, then the program, mapped to the robot enum', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { localCalls } = registerRobot();
  const outputs = await runStartCleaning(
    createFakeGladys(),
    { vacuum: EXTERNAL_ID, program: 'edge', suction: 'quiet', water: 'medium' },
    {},
  );
  assert.deepEqual(outputs, { transport: 'local' });
  assert.deepEqual(localCalls, [
    { dpId: 9, value: 'gentle' },
    { dpId: 10, value: 'middle' },
    { dpId: 4, value: 'wall_follow' },
  ]);
});

test('start_cleaning keeps unchanged settings and starts with power_go for a smart clean', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { localCalls } = registerRobot();
  await assert.rejects(
    runStartCleaning(
      createFakeGladys(),
      { vacuum: EXTERNAL_ID, program: 'mop', suction: 'unchanged', water: 'unchanged' },
      {},
    ),
    /no "mop" program/,
  );
  await runStartCleaning(createFakeGladys(), { vacuum: EXTERNAL_ID }, {});
  assert.deepEqual(localCalls, [{ dpId: 1, value: true }]);
});

test('start_cleaning refuses a level the robot does not have, and an unknown vacuum', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  registerRobot();
  await assert.rejects(
    runStartCleaning(createFakeGladys(), { vacuum: EXTERNAL_ID, water: 'turbo' }, {}),
    /no "turbo" water level/,
  );
  await assert.rejects(
    runStartCleaning(createFakeGladys(), { vacuum: 'vacuum:gone' }, {}),
    /Unknown/,
  );
});

test('clean_zone sends the zone frame, finding the zone by name in any case', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { cloudCalls } = registerRobot({ local: false, zones: [KITCHEN] });
  const outputs = await runCleanZone(
    createFakeGladys(),
    { vacuum: EXTERNAL_ID, zone: 'KITCHEN' },
    {},
  );
  assert.deepEqual(outputs, { transport: 'cloud' });
  assert.deepEqual(cloudCalls, [
    { deviceId: 'eb111', code: 'command_trans', value: KITCHEN.command },
  ]);
  await assert.rejects(
    runCleanZone(createFakeGladys(), { vacuum: EXTERNAL_ID, zone: 'Garage' }, {}),
    /Unknown zone "Garage". Known zones: Kitchen/,
  );
});
