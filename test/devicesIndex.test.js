import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageParser } from 'tuyapi/lib/message-parser.js';
import { UDP_KEY } from 'tuyapi/lib/config.js';
import { TuyaDeviceRegistry } from '../src/devices/index.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

/** Same real-encoder pattern as test/udpDiscovery.test.js. */
function fakeAnnouncement(payload, version = '3.3') {
  const parser = new MessageParser({ key: UDP_KEY, version });
  const buffer = parser.encode({ data: payload, commandByte: 0, sequenceN: 1 });
  return { source_ip: payload.ip, source_port: 6667, payload_base64: buffer.toString('base64') };
}

function fakeSharing(devicesOrError) {
  return {
    async discoverDevices() {
      if (devicesOrError instanceof Error) throw devicesOrError;
      return devicesOrError;
    },
  };
}

function fakeCloud(devicesById) {
  return {
    async getDevice(id) {
      const entry = devicesById[id];
      if (!entry) throw new Error(`unknown device ${id}`);
      return { name: entry.name, local_key: entry.localKey };
    },
    async getSpecifications(id) {
      const entry = devicesById[id];
      return { status: entry.status ?? [], functions: entry.functions ?? [] };
    },
  };
}

function sharingDevice(id, overrides = {}) {
  return {
    id,
    name: `Vacuum ${id}`,
    local_key: `key-${id}`,
    ip: `192.168.1.${id}`,
    dps: { switch_status: { dpId: 1, type: 'Boolean', values: '{}' } },
    ...overrides,
  };
}

test('refresh() populates entries from the sharing client, source-tagged', async () => {
  const gladys = createFakeGladys();
  const registry = new TuyaDeviceRegistry({
    sharing: fakeSharing([sharingDevice('1'), sharingDevice('2')]),
  });

  await registry.refresh(gladys, []);

  assert.equal(registry.values().length, 2);
  const entry = registry.get('1');
  assert.equal(entry.source, 'sharing');
  assert.equal(entry.localKey, 'key-1');
  assert.equal(entry.ip, '192.168.1.1');
  assert.ok(entry.dpsByCode.has('switch_status'));
});

test('refresh() ignores a non-LAN IP reported by device sharing when no UDP announcement confirms it', async () => {
  // Device sharing has been observed reporting a device's WAN-facing IP (as
  // seen by Tuya's own servers) rather than a real LAN address — trusting it
  // would make the local TCP client hammer a public IP forever instead of
  // cleanly falling back to "no LAN IP known yet".
  const gladys = createFakeGladys();
  const registry = new TuyaDeviceRegistry({
    sharing: fakeSharing([sharingDevice('1', { ip: '203.0.113.9' })]),
  });

  await registry.refresh(gladys, []);

  assert.equal(registry.get('1').ip, undefined);
});

test('refresh() still uses the UDP-confirmed IP even when device sharing also reports a non-LAN one', async () => {
  const gladys = createFakeGladys({
    scanNetworkResult: [fakeAnnouncement({ ip: '192.168.1.50', gwId: '1', version: '3.3' })],
  });
  const registry = new TuyaDeviceRegistry({
    sharing: fakeSharing([sharingDevice('1', { ip: '203.0.113.9' })]),
  });

  await registry.refresh(gladys, []);

  assert.equal(registry.get('1').ip, '192.168.1.50');
});

test('refresh() prunes a sharing-sourced device no longer returned by discoverDevices()', async () => {
  const gladys = createFakeGladys();
  const sharing = fakeSharing([sharingDevice('1'), sharingDevice('2')]);
  const registry = new TuyaDeviceRegistry({ sharing });

  await registry.refresh(gladys, []);
  assert.equal(registry.values().length, 2);

  sharing.discoverDevices = async () => [sharingDevice('1')]; // "2" unlinked from the account
  await registry.refresh(gladys, []);

  assert.equal(registry.values().length, 1);
  assert.equal(registry.get('2'), undefined);
});

test('refresh() keeps previously-cached sharing entries when discoverDevices() fails', async () => {
  const gladys = createFakeGladys();
  const registry = new TuyaDeviceRegistry({ sharing: fakeSharing([sharingDevice('1')]) });
  await registry.refresh(gladys, []);
  assert.equal(registry.values().length, 1);

  registry.sharing = fakeSharing(new Error('bridge unreachable'));
  await registry.refresh(gladys, []);

  assert.equal(registry.values().length, 1, 'a failed refresh must not evict cached devices');
});

test('refresh() populates entries from the cloud client for configured device_ids only', async () => {
  const gladys = createFakeGladys();
  const cloud = fakeCloud({
    a: {
      name: 'A',
      localKey: 'ka',
      status: [{ code: 'switch_status', dp_id: 1, type: 'Boolean', values: '{}' }],
    },
    b: {
      name: 'B',
      localKey: 'kb',
      status: [{ code: 'switch_status', dp_id: 1, type: 'Boolean', values: '{}' }],
    },
  });
  const registry = new TuyaDeviceRegistry({ cloud });

  await registry.refresh(gladys, ['a', 'b']);
  assert.equal(registry.values().length, 2);
  assert.equal(registry.get('a').source, 'cloud');

  await registry.refresh(gladys, ['a']); // "b" removed from device_ids
  assert.equal(registry.values().length, 1);
  assert.equal(registry.get('b'), undefined);
});

test('refresh() merges both methods at once; a device_id configured on both is cloud-owned', async () => {
  const gladys = createFakeGladys();
  const sharing = fakeSharing([sharingDevice('shared'), sharingDevice('only-sharing')]);
  const cloud = fakeCloud({
    shared: { name: 'Cloud name', localKey: 'cloud-key', status: [] },
  });
  const registry = new TuyaDeviceRegistry({ sharing, cloud });

  await registry.refresh(gladys, ['shared']);

  assert.equal(registry.values().length, 2);
  assert.equal(registry.get('only-sharing').source, 'sharing');
  assert.equal(registry.get('shared').source, 'cloud');
  assert.equal(registry.get('shared').localKey, 'cloud-key');
});

test('refresh() with neither client configured is a no-op, not a crash', async () => {
  const gladys = createFakeGladys();
  const registry = new TuyaDeviceRegistry({});
  await registry.refresh(gladys, []);
  assert.equal(registry.values().length, 0);
});
