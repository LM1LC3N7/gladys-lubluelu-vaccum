import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWEEPER_COMMAND,
  buildFrame,
  decodeFrame,
  encodeRoomClean,
  encodeZoneClean,
  isCleanCommand,
  selectionFromReport,
} from '../src/tuya/sweeper.js';

// The room-clean status frame `xplorer-rs` (src/device.rs tests) reads back
// from a real X-Plorer robot on DP 15: AA 00 04 15 01 01 04 1B — one pass,
// one room, room 4.
const ROOM_STATUS_FROM_ROBOT = 'qgAEFQEBBBs=';

test('decodeFrame reads a frame reported by a real robot and checks its checksum', () => {
  const frame = decodeFrame(ROOM_STATUS_FROM_ROBOT);
  assert.equal(frame.command, SWEEPER_COMMAND.ROOM_CLEAN_STATUS);
  assert.deepEqual([...frame.data], [1, 1, 4]);
});

test('decodeFrame refuses a bad checksum, a bad header, a truncated frame or junk', () => {
  const bytes = Buffer.from(ROOM_STATUS_FROM_ROBOT, 'base64');
  const badChecksum = Buffer.from(bytes);
  badChecksum[bytes.length - 1] ^= 0xff;
  assert.equal(decodeFrame(badChecksum), undefined);
  const badHeader = Buffer.from(bytes);
  badHeader[0] = 0xab;
  assert.equal(decodeFrame(badHeader), undefined);
  assert.equal(decodeFrame(bytes.subarray(0, 5)), undefined);
  assert.equal(decodeFrame('not base64 at all'), undefined);
  assert.equal(decodeFrame(undefined), undefined);
});

test('encodeRoomClean builds the 0x14 frame: passes, count, ids, checksum', () => {
  const bytes = Buffer.from(encodeRoomClean([0, 2]), 'base64');
  // AA, length 5 (command + 4 data bytes), 0x14, 1 pass, 2 rooms, 0, 2, checksum.
  assert.deepEqual([...bytes], [0xaa, 0x00, 0x05, 0x14, 0x01, 0x02, 0x00, 0x02, 0x19]);
  assert.throws(() => encodeRoomClean([]), /Room ids/);
  assert.throws(() => encodeRoomClean([256]), /Room ids/);
});

test('encodeZoneClean matches the reference zone frame byte for byte', () => {
  // xplorer-rs' own test vector (src/protocol.rs): one 82,-13 -> 453,203 rectangle.
  const bytes = Buffer.from(encodeZoneClean([{ x1: 82, y1: -13, x2: 453, y2: 203 }]), 'base64');
  assert.deepEqual(
    [...bytes],
    [
      0xaa, 0x00, 0x14, 0x28, 0x01, 0x01, 0x04, 0x00, 0x52, 0x00, 0xcb, 0x01, 0xc5, 0x00, 0xcb,
      0x01, 0xc5, 0xff, 0xf3, 0x00, 0x52, 0xff, 0xf3, 0xd8,
    ],
  );
});

test('selectionFromReport turns a reported room status into the command replaying it', () => {
  const selection = selectionFromReport(ROOM_STATUS_FROM_ROBOT);
  assert.equal(selection.kind, 'rooms');
  assert.deepEqual(selection.roomIds, [4]);
  assert.equal(selection.cleanTimes, 1);
  assert.equal(selection.command, encodeRoomClean([4]));
  assert.ok(isCleanCommand(selection.command));
});

test('selectionFromReport turns a reported zone status (0x29) into its 0x28 command', () => {
  const command = encodeZoneClean([{ x1: 0, y1: 0, x2: 100, y2: 50 }], 2);
  const frame = decodeFrame(command);
  const status = buildFrame(SWEEPER_COMMAND.ZONE_CLEAN_STATUS, [...frame.data]).toString('base64');
  const selection = selectionFromReport(status);
  assert.equal(selection.kind, 'zones');
  assert.equal(selection.zoneCount, 1);
  assert.equal(selection.cleanTimes, 2);
  assert.equal(selection.command, command);
});

test('selectionFromReport ignores any other sweeper frame', () => {
  assert.equal(selectionFromReport(buildFrame(0x31, [1, 2]).toString('base64')), undefined);
  assert.equal(isCleanCommand(buildFrame(0x15, [1, 1, 4]).toString('base64')), false);
});
