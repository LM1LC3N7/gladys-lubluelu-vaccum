// -----------------------------------------------------------------------------
// Tuya "sweeper" binary protocol: room and zone cleaning on LiDAR robots.
//
// Tuya laser robot vacuums carry room/zone cleaning on a Raw DP, standard
// code `command_trans` (DP 15 on the robots documented so far), whose value
// is a base64-encoded frame:
//
//   0xAA | length (2 bytes, big endian) | command | data... | checksum
//
// `length` counts the command byte plus the data; `checksum` is the low byte
// of the sum of the command and data bytes. The robot answers each setter
// with a status frame on the same DP: 0x14 "clean these rooms" is answered by
// 0x15, 0x28 "clean these zones" by 0x29 — same data, command byte + 1.
//
//   - rooms (0x14): clean_times, room count, room ids (one byte each);
//   - zones (0x28): clean_times, zone count, then per zone a vertex count and
//     the vertices as big-endian signed 16-bit (x, y) pairs, in map units.
//
// Byte layouts cross-checked against the `xplorer-rs` crate (MIT, Tuya v3.3
// X-Plorer robots, src/protocol.rs and its frame tests), NOT yet against a
// real Lubluelu SL68 — see the README's "Tested and confirmed" section.
//
// Room ids only mean something for the map they were taken from: re-mapping
// the home in the Smart Life app can renumber them. Hence this integration's
// "learn" approach (src/zones.js): the status frame the robot reports when
// the APP starts a room or zone clean is captured and replayed as is.
// -----------------------------------------------------------------------------

export const SWEEPER_COMMAND = {
  ROOM_CLEAN: 0x14,
  ROOM_CLEAN_STATUS: 0x15,
  ZONE_CLEAN: 0x28,
  ZONE_CLEAN_STATUS: 0x29,
};

// The setter each status frame answers — what to send to replay it.
const SETTER_OF_STATUS = {
  [SWEEPER_COMMAND.ROOM_CLEAN_STATUS]: SWEEPER_COMMAND.ROOM_CLEAN,
  [SWEEPER_COMMAND.ZONE_CLEAN_STATUS]: SWEEPER_COMMAND.ZONE_CLEAN,
};

/** Low byte of the sum of `bytes`. */
function checksumOf(bytes) {
  let sum = 0;
  for (const byte of bytes) {
    sum += byte;
  }
  return sum & 0xff;
}

/** Build one frame (a Buffer) from a command byte and its data bytes. */
export function buildFrame(command, data = []) {
  const body = Buffer.from([command, ...data]);
  if (body.length > 0xffff) {
    throw new Error('Sweeper frame too long');
  }
  return Buffer.concat([
    Buffer.from([0xaa, body.length >> 8, body.length & 0xff]),
    body,
    Buffer.from([checksumOf(body)]),
  ]);
}

/**
 * Decode one frame (base64 string or Buffer). Never throws: anything that
 * isn't a well-formed frame with a valid checksum resolves `undefined`.
 * @returns {{ command: number, data: Buffer } | undefined}
 */
export function decodeFrame(value) {
  let bytes;
  try {
    bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'base64');
  } catch {
    return undefined;
  }
  if (bytes.length < 5 || bytes[0] !== 0xaa) {
    return undefined;
  }
  const length = (bytes[1] << 8) | bytes[2];
  if (length < 1 || bytes.length < 3 + length + 1) {
    return undefined;
  }
  const body = bytes.subarray(3, 3 + length);
  if (checksumOf(body) !== bytes[3 + length]) {
    return undefined;
  }
  return { command: body[0], data: Buffer.from(body.subarray(1)) };
}

/** Base64 command cleaning `roomIds` (0-255 each), `cleanTimes` passes. */
export function encodeRoomClean(roomIds, cleanTimes = 1) {
  const ids = [...new Set(roomIds.map(Number))];
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 0 || id > 255)) {
    throw new Error('Room ids must be integers between 0 and 255');
  }
  return buildFrame(SWEEPER_COMMAND.ROOM_CLEAN, [
    clampPasses(cleanTimes),
    ids.length,
    ...ids,
  ]).toString('base64');
}

/**
 * Base64 command cleaning rectangles, each `{ x1, y1, x2, y2 }` in map units
 * (corners in the order the app sends them: top-left, top-right,
 * bottom-right, bottom-left).
 */
export function encodeZoneClean(rects, cleanTimes = 1) {
  if (rects.length === 0) {
    throw new Error('At least one zone is required');
  }
  const data = [clampPasses(cleanTimes), rects.length];
  for (const { x1, y1, x2, y2 } of rects) {
    const vertices = [
      [x1, y2],
      [x2, y2],
      [x2, y1],
      [x1, y1],
    ];
    data.push(vertices.length);
    for (const [x, y] of vertices) {
      const pair = Buffer.alloc(4);
      pair.writeInt16BE(x, 0);
      pair.writeInt16BE(y, 2);
      data.push(...pair);
    }
  }
  return buildFrame(SWEEPER_COMMAND.ZONE_CLEAN, data).toString('base64');
}

function clampPasses(cleanTimes) {
  const passes = Number(cleanTimes);
  return Number.isInteger(passes) && passes >= 1 && passes <= 3 ? passes : 1;
}

/**
 * What a frame the robot REPORTED says about a selection started elsewhere
 * (typically from the Smart Life app), and the command replaying it.
 * @returns {{ kind: 'rooms'|'zones', roomIds?: number[], zoneCount?: number,
 *   cleanTimes: number, command: string } | undefined}
 */
export function selectionFromReport(value) {
  const frame = decodeFrame(value);
  if (!frame) {
    return undefined;
  }
  const setter = SETTER_OF_STATUS[frame.command] ?? frame.command;
  if (setter !== SWEEPER_COMMAND.ROOM_CLEAN && setter !== SWEEPER_COMMAND.ZONE_CLEAN) {
    return undefined;
  }
  const command = buildFrame(setter, [...frame.data]).toString('base64');
  const [cleanTimes = 1, count = 0] = frame.data;
  if (setter === SWEEPER_COMMAND.ROOM_CLEAN) {
    const roomIds = [...frame.data.subarray(2, 2 + count)];
    if (count === 0 || roomIds.length !== count) {
      return undefined;
    }
    return { kind: 'rooms', roomIds, cleanTimes, command };
  }
  if (count === 0) {
    return undefined;
  }
  return { kind: 'zones', zoneCount: count, cleanTimes, command };
}

/** Whether `value` is a replayable room/zone command (a setter frame). */
export function isCleanCommand(value) {
  const frame = decodeFrame(value);
  return (
    frame !== undefined &&
    (frame.command === SWEEPER_COMMAND.ROOM_CLEAN || frame.command === SWEEPER_COMMAND.ZONE_CLEAN)
  );
}
