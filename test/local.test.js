import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReconnectDelayMs } from '../src/tuya/local.js';

test('computeReconnectDelayMs grows linearly with the attempt number', () => {
  assert.equal(computeReconnectDelayMs(1, 10), 10_000);
  assert.equal(computeReconnectDelayMs(2, 10), 20_000);
  assert.equal(computeReconnectDelayMs(3, 10), 30_000);
});

test('computeReconnectDelayMs is capped at 120s', () => {
  assert.equal(computeReconnectDelayMs(50, 10), 120_000);
});

test('computeReconnectDelayMs falls back to a 10s base for an invalid config value', () => {
  assert.equal(computeReconnectDelayMs(1, 'not-a-number'), 10_000);
  assert.equal(computeReconnectDelayMs(1, 0), 10_000);
});
