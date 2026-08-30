import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isConfigured, parseDeviceIps, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  const config = normalizeConfig();
  assert.equal(config.access_id, '');
  assert.equal(config.region, 'eu');
  assert.deepEqual(config.deviceIds, []);
  assert.deepEqual(config.deviceIps, {});
  assert.equal(config.refresh_interval_minutes, DEFAULT_CONFIG.refresh_interval_minutes);
  assert.equal(config.protocol_version, '3.3');
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    access_id: 'abc',
    access_secret: 'secret',
    region: 'us',
    device_ids: 'eb1234',
  });
  assert.equal(config.access_id, 'abc');
  assert.equal(config.access_secret, 'secret');
  assert.equal(config.region, 'us');
  assert.deepEqual(config.deviceIds, ['eb1234']);
});

test('normalizeConfig falls back to the default for an unknown region', () => {
  assert.equal(normalizeConfig({ region: 'mars' }).region, DEFAULT_CONFIG.region);
});

test('normalizeConfig falls back to the default for an unknown protocol version', () => {
  assert.equal(normalizeConfig({ protocol_version: '9.9' }).protocol_version, '3.3');
  assert.equal(normalizeConfig({ protocol_version: '3.4' }).protocol_version, '3.4');
});

test('normalizeConfig: device_ids are trimmed, deduplicated, and empties dropped', () => {
  const config = normalizeConfig({ device_ids: ' eb111 ,eb222, ,eb111,' });
  assert.deepEqual(config.deviceIds, ['eb111', 'eb222']);
});

test('normalizeConfig coerces refresh_interval_minutes and clamps out-of-range values', () => {
  assert.equal(normalizeConfig({ refresh_interval_minutes: '30' }).refresh_interval_minutes, 30);
  assert.equal(
    normalizeConfig({ refresh_interval_minutes: 1 }).refresh_interval_minutes,
    DEFAULT_CONFIG.refresh_interval_minutes,
  );
  assert.equal(
    normalizeConfig({ refresh_interval_minutes: 99999 }).refresh_interval_minutes,
    DEFAULT_CONFIG.refresh_interval_minutes,
  );
});

test('parseDeviceIps parses device_id=ip pairs and ignores malformed entries', () => {
  assert.deepEqual(parseDeviceIps('eb111=192.168.1.10, eb222 = 192.168.1.11 , not-a-pair'), {
    eb111: '192.168.1.10',
    eb222: '192.168.1.11',
  });
  assert.deepEqual(parseDeviceIps(''), {});
  assert.deepEqual(parseDeviceIps(undefined), {});
});

test('isConfigured requires credentials AND at least one device id', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ access_id: 'a', access_secret: 'b' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ access_id: 'a', access_secret: 'b', device_ids: 'eb111' })),
    true,
  );
});
