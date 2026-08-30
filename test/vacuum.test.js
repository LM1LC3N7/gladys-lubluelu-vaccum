import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeatures,
  buildDiscoveredDevice,
  deviceIdOf,
  onSetValue,
  runTestConnectionAction,
  __setConnectionForTesting,
  __clearConnectionsForTesting,
} from '../src/devices/vacuum.js';
import { indexDpsByCode } from '../src/tuya/dpsSchema.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

const FULL_SPEC = {
  status: [
    { code: 'switch_status', dp_id: 1, type: 'Boolean', values: '{}' },
    { code: 'mode', dp_id: 2, type: 'Enum', values: '{"range":["smart","chargego","pause"]}' },
    { code: 'electricity_left', dp_id: 4, type: 'Value', values: '{"min":0,"max":100}' },
  ],
};

function fakeLocalClient({ connected = true } = {}) {
  const setCalls = [];
  return {
    setCalls,
    isConnected: () => connected,
    async set(dpId, value) {
      setCalls.push({ dpId, value });
      return true;
    },
    stop() {},
  };
}

test('buildFeatures builds one feature per recognized code plus a synthetic dock button', () => {
  const dpsByCode = indexDpsByCode(FULL_SPEC);
  const { features, featureKeyToDp, dockValue } = buildFeatures('vacuum:eb111', dpsByCode);

  const keys = features.map((f) => f.external_id.split(':').pop());
  assert.ok(keys.includes('power'));
  assert.ok(keys.includes('mode'));
  assert.ok(keys.includes('battery'));
  assert.ok(keys.includes('dock'), 'a dock feature is added because "mode" has a chargego value');
  assert.equal(dockValue, 'chargego');
  assert.equal(featureKeyToDp.get('power').dpId, 1);
  assert.equal(featureKeyToDp.get('mode').dpId, 2);
});

test('buildFeatures builds no dock feature when the mode enum has no dock-like value', () => {
  const dpsByCode = indexDpsByCode({
    status: [{ code: 'mode', dp_id: 2, type: 'Enum', values: '{"range":["smart","spot"]}' }],
  });
  const { features, dockValue } = buildFeatures('vacuum:eb111', dpsByCode);
  assert.equal(dockValue, undefined);
  assert.equal(
    features.some((f) => f.external_id.endsWith(':dock')),
    false,
  );
});

test('buildDiscoveredDevice sets the TUYA_DEVICE_ID param and, when known, IP_ADDRESS', () => {
  const gladys = createFakeGladys();
  const dpsByCode = indexDpsByCode(FULL_SPEC);

  const withIp = buildDiscoveredDevice(gladys, {
    deviceId: 'eb111',
    name: 'Vacuum',
    dpsByCode,
    ip: '192.168.1.42',
  });
  assert.deepEqual(withIp.params, [
    { name: 'TUYA_DEVICE_ID', value: 'eb111' },
    { name: 'IP_ADDRESS', value: '192.168.1.42' },
  ]);
  assert.equal(deviceIdOf(withIp), 'eb111');

  const withoutIp = buildDiscoveredDevice(gladys, { deviceId: 'eb222', dpsByCode });
  assert.deepEqual(withoutIp.params, [{ name: 'TUYA_DEVICE_ID', value: 'eb222' }]);
  assert.equal(withoutIp.name, 'Tuya vacuum (eb222)');
});

test('onSetValue sends locally when connected and preferred', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  const local = fakeLocalClient({ connected: true });
  __setConnectionForTesting('vacuum:eb111', {
    deviceId: 'eb111',
    ip: '192.168.1.42',
    local,
    cloud: null,
    featureKeyToDp: new Map([['power', { dpId: 1, code: 'switch_status' }]]),
    dockValue: undefined,
    lastKnownState: new Map(),
  });

  await onSetValue(gladys, {
    device: { external_id: 'vacuum:eb111' },
    feature: { external_id: 'vacuum:eb111:power' },
    value: true,
    config: {},
  });

  assert.deepEqual(local.setCalls, [{ dpId: 1, value: true }]);
});

test('onSetValue falls back to the cloud when the local session is down', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  const local = fakeLocalClient({ connected: false });
  const cloudCalls = [];
  __setConnectionForTesting('vacuum:eb111', {
    deviceId: 'eb111',
    ip: '192.168.1.42',
    local,
    cloud: { sendCommand: async (id, code, value) => cloudCalls.push({ id, code, value }) },
    featureKeyToDp: new Map([['power', { dpId: 1, code: 'switch_status' }]]),
    dockValue: undefined,
    lastKnownState: new Map(),
  });

  await onSetValue(gladys, {
    device: { external_id: 'vacuum:eb111' },
    feature: { external_id: 'vacuum:eb111:power' },
    value: true,
    config: {},
  });

  assert.deepEqual(cloudCalls, [{ id: 'eb111', code: 'switch_status', value: true }]);
  assert.equal(local.setCalls.length, 0);
  assert.ok(gladys.transports.some((t2) => t2.transport === 'cloud' && t2.degraded === true));
});

test('onSetValue respects GLADYS_PREFER_LOCAL: false and goes straight to the cloud', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  const local = fakeLocalClient({ connected: true });
  const cloudCalls = [];
  __setConnectionForTesting('vacuum:eb111', {
    deviceId: 'eb111',
    ip: '192.168.1.42',
    local,
    cloud: { sendCommand: async (id, code, value) => cloudCalls.push({ id, code, value }) },
    featureKeyToDp: new Map([['power', { dpId: 1, code: 'switch_status' }]]),
    dockValue: undefined,
    lastKnownState: new Map(),
  });

  await onSetValue(gladys, {
    device: { external_id: 'vacuum:eb111' },
    feature: { external_id: 'vacuum:eb111:power' },
    value: true,
    config: { GLADYS_PREFER_LOCAL: false },
  });

  assert.equal(local.setCalls.length, 0);
  assert.deepEqual(cloudCalls, [{ id: 'eb111', code: 'switch_status', value: true }]);
  assert.ok(gladys.transports.some((t2) => t2.transport === 'cloud' && t2.degraded === false));
});

test('onSetValue on the synthetic dock feature sends the mode DP with the dock value', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  const local = fakeLocalClient({ connected: true });
  __setConnectionForTesting('vacuum:eb111', {
    deviceId: 'eb111',
    ip: '192.168.1.42',
    local,
    cloud: null,
    featureKeyToDp: new Map([['mode', { dpId: 2, code: 'mode' }]]),
    dockValue: 'chargego',
    lastKnownState: new Map(),
  });

  await onSetValue(gladys, {
    device: { external_id: 'vacuum:eb111' },
    feature: { external_id: 'vacuum:eb111:dock' },
    value: 1,
    config: {},
  });

  assert.deepEqual(local.setCalls, [{ dpId: 2, value: 'chargego' }]);
});

test('onSetValue throws for an unknown feature key', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  __setConnectionForTesting('vacuum:eb111', {
    deviceId: 'eb111',
    local: fakeLocalClient(),
    featureKeyToDp: new Map(),
    lastKnownState: new Map(),
  });

  await assert.rejects(
    () =>
      onSetValue(gladys, {
        device: { external_id: 'vacuum:eb111' },
        feature: { external_id: 'vacuum:eb111:not_a_real_feature' },
        value: 1,
        config: {},
      }),
    /not controllable/,
  );
});

test('runTestConnectionAction reports the last known local state', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  const lastKnownState = new Map([
    ['power', true],
    ['battery', 80],
  ]);
  __setConnectionForTesting('vacuum:eb111', {
    deviceId: 'eb111',
    ip: '192.168.1.42',
    local: fakeLocalClient({ connected: true }),
    lastKnownState,
  });

  const result = await runTestConnectionAction(gladys, { fields: { device: 'vacuum:eb111' } });

  assert.match(result.en, /192\.168\.1\.42/);
  assert.match(result.en, /power=true/);
  assert.match(result.en, /battery=80/);
});

test('runTestConnectionAction reports "not connected yet" for an unknown device', async () => {
  const gladys = createFakeGladys();
  const result = await runTestConnectionAction(gladys, { fields: { device: 'vacuum:unknown' } });
  assert.match(result.en, /not been connected/);
});
