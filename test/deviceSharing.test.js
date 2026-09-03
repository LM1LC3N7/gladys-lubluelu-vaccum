import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQrImageUrl,
  waitForQrLogin,
  toRegistryEntry,
  TuyaDeviceSharingClient,
} from '../src/tuya/deviceSharing.js';

test('buildQrImageUrl renders the raw QR content through the public QR image API', () => {
  const url = buildQrImageUrl('smartlife--qrLogin?token=abc123');
  assert.match(url, /^https:\/\/api\.qrserver\.com\/v1\/create-qr-code\/\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('data'), 'smartlife--qrLogin?token=abc123');
  assert.equal(parsed.searchParams.get('size'), '300x300');
});

function fakeBridge(handlers) {
  const calls = [];
  return {
    calls,
    async call(cmd, params) {
      calls.push({ cmd, params });
      return handlers[cmd](params);
    },
  };
}

test('TuyaDeviceSharingClient methods map to the right bridge command + params', async () => {
  const bridge = fakeBridge({
    qr_start: () => ({ token: 't1', content: 'smartlife--qrLogin?token=t1' }),
    qr_poll: () => ({ status: 'pending' }),
    restore_session: () => ({ success: true }),
    get_session: () => ({ terminal_id: 'x' }),
    discover: () => [],
    send_command: () => ({ success: true }),
    get_status: () => [{ code: 'switch_status', value: true }],
    logout: () => ({ success: true }),
  });
  const client = new TuyaDeviceSharingClient({ bridge });

  await client.startQrLogin('CODE1', 'smartlife');
  assert.deepEqual(bridge.calls[0], {
    cmd: 'qr_start',
    params: { user_code: 'CODE1', scheme: 'smartlife' },
  });

  await client.pollQrLogin('t1', 'CODE1');
  assert.deepEqual(bridge.calls[1], {
    cmd: 'qr_poll',
    params: { token: 't1', user_code: 'CODE1' },
  });

  await client.restoreSession({ terminal_id: 'x' });
  assert.deepEqual(bridge.calls[2], {
    cmd: 'restore_session',
    params: { session: { terminal_id: 'x' } },
  });

  await client.getSession();
  assert.deepEqual(bridge.calls[3], { cmd: 'get_session', params: {} });

  await client.discoverDevices();
  assert.deepEqual(bridge.calls[4], { cmd: 'discover', params: {} });

  await client.sendCommand('dev1', 'switch_status', true);
  assert.deepEqual(bridge.calls[5], {
    cmd: 'send_command',
    params: { device_id: 'dev1', code: 'switch_status', value: true },
  });

  const status = await client.getStatus('dev1');
  assert.deepEqual(bridge.calls[6], { cmd: 'get_status', params: { device_id: 'dev1' } });
  assert.deepEqual(status, [{ code: 'switch_status', value: true }]);

  await client.logout();
  assert.deepEqual(bridge.calls[7], { cmd: 'logout', params: {} });
});

test('waitForQrLogin resolves with the session as soon as polling reports success', async () => {
  let calls = 0;
  const pollFn = async () => {
    calls += 1;
    return calls < 3 ? { status: 'pending' } : { status: 'success', session: { terminal_id: 'x' } };
  };
  const session = await waitForQrLogin(pollFn, 'tok', 'CODE1', { sleep: async () => {} });
  assert.deepEqual(session, { terminal_id: 'x' });
  assert.equal(calls, 3);
});

test('waitForQrLogin throws once the timeout elapses without a success', async () => {
  const pollFn = async () => ({ status: 'pending' });
  let now = 0;
  await assert.rejects(
    waitForQrLogin(pollFn, 'tok', 'CODE1', {
      timeoutMs: 10,
      intervalMs: 5,
      sleep: async () => {
        now += 5;
      },
    }),
    /timed out/,
  );
  assert.ok(now >= 10);
});

test('toRegistryEntry converts a bridge device into the shared registry entry shape', () => {
  const device = {
    id: 'eb111',
    name: 'Vacuum',
    local_key: 'abcdefghijklmnop',
    ip: '192.168.1.42',
    dps: {
      switch_status: { dpId: 1, type: 'Boolean', values: '{}' },
      mode: { dpId: 2, type: 'Enum', values: '{"range":["smart","chargego"]}' },
    },
  };

  const entry = toRegistryEntry(device);

  assert.equal(entry.deviceId, 'eb111');
  assert.equal(entry.name, 'Vacuum');
  assert.equal(entry.localKey, 'abcdefghijklmnop');
  assert.equal(entry.ip, '192.168.1.42');
  assert.equal(entry.dpsByCode.get('switch_status').dpId, 1);
  assert.deepEqual(entry.dpsByCode.get('mode').values, { range: ['smart', 'chargego'] });
});

test('toRegistryEntry tolerates a device with no IP and no dps', () => {
  const entry = toRegistryEntry({ id: 'eb222', name: 'Vacuum 2', local_key: 'k' });
  assert.equal(entry.ip, undefined);
  assert.equal(entry.dpsByCode.size, 0);
});
