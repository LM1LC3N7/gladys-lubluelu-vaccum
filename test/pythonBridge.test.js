import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PythonBridge } from '../src/tuya/pythonBridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'test-fixtures', 'echoBridge.js');

const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

function newBridge(options = {}) {
  // The fixture is plain Node, not Python: run it with the current Node binary.
  return new PythonBridge({
    logger: silentLogger,
    scriptPath: FIXTURE_PATH,
    pythonExecutable: process.execPath,
    ...options,
  });
}

test('PythonBridge: call() resolves with the result of a matching response', async () => {
  const bridge = newBridge();
  try {
    const result = await bridge.call('discover', { username: 'demo' });
    assert.deepEqual(result, { echo: { id: 1, cmd: 'discover', username: 'demo' } });
  } finally {
    bridge.stop();
  }
});

test('PythonBridge: call() rejects when the bridge reports ok:false', async () => {
  const bridge = newBridge();
  try {
    await assert.rejects(bridge.call('boom'), /boom failed/);
  } finally {
    bridge.stop();
  }
});

test('PythonBridge: concurrent calls are correlated by id, not call order', async () => {
  const bridge = newBridge();
  try {
    const [slow, fast] = await Promise.all([bridge.call('slow'), bridge.call('discover')]);
    assert.equal(slow, 'late');
    assert.deepEqual(fast, { echo: { id: 2, cmd: 'discover' } });
  } finally {
    bridge.stop();
  }
});

test('PythonBridge: a dead process rejects every pending call', async () => {
  const bridge = newBridge();
  const pending = bridge.call('slow'); // never answered: the process exits first
  await assert.rejects(bridge.call('exit'), /exited/);
  await assert.rejects(pending, /exited/);
});

test('PythonBridge: an unsolicited event line goes to onEvent, not to a pending call', async () => {
  const events = [];
  const bridge = newBridge({ onEvent: (event) => events.push(event) });
  try {
    const result = await bridge.call('push');
    assert.deepEqual(result, { echo: { id: 1, cmd: 'push' } });
    assert.deepEqual(events, [
      { event: 'status', device_id: 'eb111', status: { status: 'charging' } },
    ]);
  } finally {
    bridge.stop();
  }
});

test('PythonBridge: onSpawn runs on a respawn only, its write reaching the new process first', async () => {
  let bridge;
  const spawned = [];
  bridge = newBridge({
    onSpawn: () => {
      spawned.push(bridge.call('restore_session', { session: { user_code: 'x' } }));
    },
  });
  try {
    await bridge.call('discover');
    assert.equal(spawned.length, 0, 'not on the first spawn');
    await assert.rejects(bridge.call('exit'), /exited/);
    const result = await bridge.call('discover');
    assert.equal(spawned.length, 1);
    const restored = await spawned[0];
    assert.equal(restored.echo.cmd, 'restore_session');
    assert.ok(restored.echo.id < result.echo.id, 'the restore is written before the call');
  } finally {
    bridge.stop();
  }
});
