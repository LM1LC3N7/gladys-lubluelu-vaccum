// -----------------------------------------------------------------------------
// Tests the request-building/signing logic against a mocked `fetch`, and the
// signature format against Tuya's documented "new signature" shape. No real
// Tuya Cloud account was available while writing this (see the README's
// "Tested and confirmed" section) — these tests confirm the client sends
// what the docs describe, not that Tuya's servers accept it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildStringToSign, signRequest, TuyaCloudClient } from '../src/tuya/cloud.js';

test('buildStringToSign joins METHOD/content-hash/empty-headers/path with newlines', () => {
  const str = buildStringToSign('GET', '/v1.0/token?grant_type=1', '');
  const [method, contentHash, headers, path] = str.split('\n');
  assert.equal(method, 'GET');
  assert.equal(contentHash, crypto.createHash('sha256').update('').digest('hex'));
  assert.equal(headers, '');
  assert.equal(path, '/v1.0/token?grant_type=1');
});

test('buildStringToSign hashes a non-empty body', () => {
  const body = JSON.stringify({ commands: [{ code: 'switch_status', value: true }] });
  const str = buildStringToSign('POST', '/v1.0/devices/eb111/commands', body);
  const contentHash = str.split('\n')[1];
  assert.equal(contentHash, crypto.createHash('sha256').update(body, 'utf8').digest('hex'));
});

test('signRequest is deterministic and produces an uppercase hex HMAC-SHA256', () => {
  const options = {
    clientId: 'client123',
    secret: 'secret456',
    t: '1700000000000',
    method: 'GET',
    pathWithQuery: '/v1.0/token?grant_type=1',
  };
  const sign = signRequest(options);
  assert.match(sign, /^[0-9A-F]{64}$/);
  assert.equal(sign, signRequest(options));
});

test('signRequest changes when the access token is included (authenticated calls)', () => {
  const base = {
    clientId: 'client123',
    secret: 'secret456',
    t: '1700000000000',
    method: 'GET',
    pathWithQuery: '/v1.0/devices/eb111',
  };
  assert.notEqual(signRequest(base), signRequest({ ...base, accessToken: 'tok' }));
});

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      const response = responses.shift();
      return { json: async () => response };
    },
  };
}

test('TuyaCloudClient fetches a token before its first authenticated request', async () => {
  const { fetchFn, calls } = fakeFetch([
    { success: true, result: { access_token: 'tok1', refresh_token: 'ref1', expire_time: 7200 } },
    { success: true, result: { id: 'eb111', local_key: 'abcdefghijklmnop', name: 'Vacuum' } },
  ]);
  const client = new TuyaCloudClient({
    accessId: 'id',
    accessSecret: 'secret',
    region: 'eu',
    fetchFn,
  });

  const device = await client.getDevice('eb111');

  assert.equal(device.local_key, 'abcdefghijklmnop');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\.0\/token\?grant_type=1$/);
  assert.match(calls[1].url, /\/v1\.0\/devices\/eb111$/);
  assert.equal(calls[1].init.headers.access_token, 'tok1');
});

test('TuyaCloudClient reuses a still-valid token instead of re-fetching it', async () => {
  const { fetchFn, calls } = fakeFetch([
    { success: true, result: { access_token: 'tok1', refresh_token: 'ref1', expire_time: 7200 } },
    { success: true, result: { id: 'eb111', local_key: 'k' } },
    { success: true, result: { id: 'eb111', local_key: 'k' } },
  ]);
  const client = new TuyaCloudClient({
    accessId: 'id',
    accessSecret: 'secret',
    region: 'eu',
    fetchFn,
  });

  await client.getDevice('eb111');
  await client.getDevice('eb111');

  const tokenCalls = calls.filter((c) => c.url.includes('/v1.0/token'));
  assert.equal(tokenCalls.length, 1);
});

test('TuyaCloudClient throws with the Tuya error code/message on a failed response', async () => {
  const { fetchFn } = fakeFetch([{ success: false, code: 1010, msg: 'token invalid' }]);
  const client = new TuyaCloudClient({
    accessId: 'id',
    accessSecret: 'secret',
    region: 'eu',
    fetchFn,
  });

  await assert.rejects(() => client.request('GET', '/v1.0/whatever', { useToken: false }), /1010/);
});

test('sendCommand POSTs the Tuya commands envelope', async () => {
  const { fetchFn, calls } = fakeFetch([
    { success: true, result: { access_token: 'tok1', refresh_token: 'ref1', expire_time: 7200 } },
    { success: true, result: true },
  ]);
  const client = new TuyaCloudClient({
    accessId: 'id',
    accessSecret: 'secret',
    region: 'eu',
    fetchFn,
  });

  await client.sendCommand('eb111', 'switch_status', true);

  const commandCall = calls.find((c) => c.url.includes('/commands'));
  assert.equal(commandCall.init.method, 'POST');
  assert.deepEqual(JSON.parse(commandCall.init.body), {
    commands: [{ code: 'switch_status', value: true }],
  });
});
