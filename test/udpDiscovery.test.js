// -----------------------------------------------------------------------------
// Round-trip test: encode a fake Tuya LAN broadcast with tuyapi's OWN message
// encoder (the same library this integration decodes with, see
// src/tuya/udpDiscovery.js's module doc comment), feed the raw bytes through
// `gladys.scanNetwork('udp-broadcast')`'s payload shape, and check our
// decoder recovers the announcement. This exercises the real AES-ECB
// framing/CRC, not a mock of our own decoding logic.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageParser } from 'tuyapi/lib/message-parser.js';
import { UDP_KEY } from 'tuyapi/lib/config.js';
import { decodeAnnouncement, discoverTuyaAnnouncements } from '../src/tuya/udpDiscovery.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';

function encodeBroadcast(payload, version = '3.3') {
  const parser = new MessageParser({ key: UDP_KEY, version });
  // commandByte 0 (UDP) — decodeAnnouncement doesn't care which one, same as
  // tuyapi's own find() (see index.js: it only reads `.payload`).
  return parser.encode({ data: payload, commandByte: 0, sequenceN: 1 });
}

test('decodeAnnouncement recovers gwId/ip/version from a real encrypted 3.3 broadcast', () => {
  const buffer = encodeBroadcast({
    ip: '192.168.1.42',
    gwId: 'eb1234567890abcdef01',
    productKey: 'abcdefgh',
    version: '3.3',
  });

  const decoded = decodeAnnouncement(buffer.toString('base64'));

  assert.deepEqual(decoded, {
    gwId: 'eb1234567890abcdef01',
    ip: '192.168.1.42',
    version: '3.3',
    productKey: 'abcdefgh',
  });
});

test('decodeAnnouncement returns undefined for garbage input instead of throwing', () => {
  assert.equal(decodeAnnouncement(Buffer.from('not a tuya packet').toString('base64')), undefined);
});

test('discoverTuyaAnnouncements dedupes by gwId and skips undecodable payloads', async () => {
  const buffer = encodeBroadcast({ ip: '192.168.1.42', gwId: 'eb111', version: '3.3' });
  const gladys = createFakeGladys({
    scanNetworkResult: [
      { source_ip: '192.168.1.42', source_port: 6667, payload_base64: buffer.toString('base64') },
      { source_ip: '192.168.1.42', source_port: 6667, payload_base64: buffer.toString('base64') }, // duplicate
      {
        source_ip: '192.168.1.99',
        source_port: 6666,
        payload_base64: Buffer.from('garbage').toString('base64'),
      },
    ],
  });

  const found = await discoverTuyaAnnouncements(gladys);

  assert.equal(found.length, 1);
  assert.equal(found[0].gwId, 'eb111');
  assert.equal(found[0].ip, '192.168.1.42');
});
