// End-to-end-ish tests of a full LiDAR robot through the connection registry:
// features built from its schema, states applied and published, commands
// routed — the paths the widgets, scenes and zones all go through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCloudStatus,
  applyDps,
  getConnection,
  onSetValue,
  onVacuumChange,
  __clearConnectionsForTesting,
} from '../src/devices/vacuum.js';
import { VACUUM_STATE, faultLabels, vacuumStateOf } from '../src/tuya/dpsSchema.js';
import { encodeRoomClean } from '../src/tuya/sweeper.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { EXTERNAL_ID, registerRobot } from '../test-fixtures/robot.js';

const KITCHEN = { name: 'Kitchen', slug: 'kitchen', command: encodeRoomClean([2]) };

test('vacuumStateOf maps the Tuya status enum to the Gladys vacuum states', () => {
  assert.equal(vacuumStateOf('smart'), VACUUM_STATE.RUNNING);
  assert.equal(vacuumStateOf('paused'), VACUUM_STATE.PAUSED);
  assert.equal(vacuumStateOf('goto_charge'), VACUUM_STATE.RETURNING_TO_DOCK);
  assert.equal(vacuumStateOf('charging'), VACUUM_STATE.CHARGING);
  assert.equal(vacuumStateOf('charge_done'), VACUUM_STATE.DOCKED);
  assert.equal(vacuumStateOf('standby'), VACUUM_STATE.STOPPED);
  assert.equal(vacuumStateOf('fault'), VACUUM_STATE.ERROR);
  assert.equal(vacuumStateOf('something_new'), undefined);
});

test('faultLabels names the set bits from the schema labels, translated', () => {
  const values = { label: ['edge_sweep', 'middle_sweep', 'left_wheel'] };
  assert.deepEqual(faultLabels(0, values, 'en'), []);
  assert.deepEqual(faultLabels(0b101, values, 'fr'), ['Brosse latérale', 'Roue gauche']);
  assert.deepEqual(faultLabels(8, {}, 'en'), ['#3']);
});

test('a LiDAR robot gets its state, session, part and reset features, dock and zones', (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { features } = registerRobot({ zones: [KITCHEN], language: 'fr' });
  const byKey = new Map(features.map((f) => [f.external_id.split(':').pop(), f]));
  for (const key of [
    'state',
    'power',
    'pause',
    'mode',
    'battery',
    'suction',
    'cistern',
    'seek',
    'clean_area',
    'clean_time',
    'filter',
    'reset_filter',
    'fault',
    'dock',
    'zone_kitchen',
  ]) {
    assert.ok(byKey.has(key), `missing feature ${key}`);
  }
  assert.equal(byKey.get('state').type, 'state');
  assert.equal(byKey.get('state').max, VACUUM_STATE.DOCKED);
  assert.equal(byKey.get('clean_area').unit, 'square-meter');
  assert.equal(byKey.get('clean_area').keep_history, false, 'session values are verbose');
  assert.equal(byKey.get('state').name, 'État');
  assert.equal(byKey.get('zone_kitchen').name, 'Zone - Kitchen');
  assert.equal(byKey.has('direction_control'), false, 'manual driving is a widget, not a feature');
});

test('applyDps publishes only changed values, in one batch, decoded', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  registerRobot();
  const gladys = createFakeGladys();
  await applyDps(gladys, EXTERNAL_ID, { 5: 'cleaning', 7: 425, 8: 80, 1: true });
  // (Integer keys: JS iterates them in ascending DP id order.)
  assert.deepEqual(gladys.published, [
    { featureExternalId: `${EXTERNAL_ID}:power`, state: 1 },
    { featureExternalId: `${EXTERNAL_ID}:state`, state: VACUUM_STATE.RUNNING },
    { featureExternalId: `${EXTERNAL_ID}:clean_area`, state: 42.5 },
    { featureExternalId: `${EXTERNAL_ID}:battery`, state: 80 },
  ]);
  gladys.published.length = 0;
  // `smart` is another "running" value: same Gladys state, nothing to publish.
  await applyDps(gladys, EXTERNAL_ID, { 5: 'smart', 8: 80 });
  assert.deepEqual(gladys.published, []);
  assert.equal(getConnection(EXTERNAL_ID).values.get('status'), 'smart');
});

test('applyDps tells the change listener which codes changed, with the previous values', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  registerRobot();
  const batches = [];
  onVacuumChange((externalId, batch) =>
    batches.push({ externalId, changed: batch.changedCodes, before: batch.previous.get('status') }),
  );
  const gladys = createFakeGladys();
  await applyDps(gladys, EXTERNAL_ID, { 5: 'cleaning' });
  await applyDps(gladys, EXTERNAL_ID, { 5: 'cleaning' });
  await applyDps(gladys, EXTERNAL_ID, { 5: 'goto_charge', 99: 'unknown dp' });
  assert.deepEqual(batches, [
    { externalId: EXTERNAL_ID, changed: ['status'], before: undefined },
    { externalId: EXTERNAL_ID, changed: ['status'], before: 'cleaning' },
  ]);
});

test('a room clean started from the app is captured, ready to be memorized', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  registerRobot();
  await applyDps(createFakeGladys(), EXTERNAL_ID, { 15: 'qgAEFQEBBBs=' });
  const { lastSelection } = getConnection(EXTERNAL_ID);
  assert.equal(lastSelection.kind, 'rooms');
  assert.deepEqual(lastSelection.roomIds, [4]);
  assert.equal(lastSelection.command, encodeRoomClean([4]));
});

test('applyCloudStatus applies a pushed {code: value} status through the same path', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  registerRobot({ local: false });
  const gladys = createFakeGladys();
  await applyCloudStatus(gladys, 'eb111', { status: 'charging', electricity_left: 55 });
  await applyCloudStatus(gladys, 'other-device', { status: 'cleaning' });
  assert.deepEqual(gladys.published, [
    { featureExternalId: `${EXTERNAL_ID}:state`, state: VACUUM_STATE.CHARGING },
    { featureExternalId: `${EXTERNAL_ID}:battery`, state: 55 },
  ]);
});

test('the dock feature uses switch_charge when the robot has it', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { localCalls } = registerRobot();
  await onSetValue(createFakeGladys(), {
    device: { external_id: EXTERNAL_ID },
    feature: { external_id: `${EXTERNAL_ID}:dock` },
    value: 1,
    config: {},
  });
  assert.deepEqual(localCalls, [{ dpId: 3, value: true }]);
});

test('a zone button sends its frame on command_trans, through the cloud when not local', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { cloudCalls } = registerRobot({ local: false, zones: [KITCHEN] });
  await onSetValue(createFakeGladys(), {
    device: { external_id: EXTERNAL_ID },
    feature: { external_id: `${EXTERNAL_ID}:zone_kitchen` },
    value: 1,
    config: {},
  });
  assert.deepEqual(cloudCalls, [
    { deviceId: 'eb111', code: 'command_trans', value: KITCHEN.command },
  ]);
});

test('a reset button always sends true, whatever value Gladys pushes', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { localCalls } = registerRobot();
  await onSetValue(createFakeGladys(), {
    device: { external_id: EXTERNAL_ID },
    feature: { external_id: `${EXTERNAL_ID}:reset_filter` },
    value: 0,
    config: {},
  });
  assert.deepEqual(localCalls, [{ dpId: 22, value: true }]);
});
