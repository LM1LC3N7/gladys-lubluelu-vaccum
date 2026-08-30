// -----------------------------------------------------------------------------
// Decode Tuya's LAN discovery broadcasts.
//
// Tuya devices announce themselves periodically on UDP ports 6666 (plaintext,
// legacy) and 6667 (AES-encrypted, protocol >=3.3) — this is the exact
// "Tuya-style" example the SDK README uses to illustrate mediated discovery
// (see "Mediated network discovery"): the core captures the raw broadcast
// (`network_discovery` in the manifest, `gladys.scanNetwork('udp-broadcast')`
// in src/devices/index.js) because the integration container's own bridge
// network never sees LAN broadcasts, and this module does the "interpret the
// payload" half.
//
// The encrypted broadcast uses a FIXED, universal key baked into every Tuya
// device's firmware (not the device's own `local_key`) — publicly documented
// and reused across every open-source Tuya client (tinytuya, localtuya,
// tuyapi...). Rather than re-deriving the frame format (prefix/CRC/AES-ECB
// framing) by hand, this reuses `tuyapi`'s own bundled, battle-tested parser
// for exactly that one job — the same modules its own (LAN-only, and so
// unusable from inside this container) `.find()` method uses internally.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
// Deep imports: tuyapi has no `exports` map restricting its `lib/` internals,
// and these two are exactly what its own `find()` uses to decode a broadcast
// (see node_modules/tuyapi/index.js) — reused here instead of copied.
import { MessageParser } from 'tuyapi/lib/message-parser.js';
import { UDP_KEY } from 'tuyapi/lib/config.js';

const logger = createLogger({ name: 'tuya-udp-discovery' });

// Broadcasts seen in the wild use 3.1, 3.3 or 3.4 framing depending on the
// device's firmware; the broadcast key is the same fixed one regardless, but
// the frame header format differs by version, so a few candidates are tried
// until one parses cleanly.
const CANDIDATE_VERSIONS = ['3.3', '3.1', '3.4'];

/**
 * Decode one raw broadcast payload (base64, as returned by
 * `gladys.scanNetwork('udp-broadcast')`) into `{ gwId, ip, version, productKey }`,
 * or `undefined` if it doesn't parse as a Tuya announcement.
 */
export function decodeAnnouncement(payloadBase64) {
  const buffer = Buffer.from(payloadBase64, 'base64');
  for (const version of CANDIDATE_VERSIONS) {
    try {
      const parser = new MessageParser({ key: UDP_KEY, version });
      const [packet] = parser.parse(buffer);
      if (!packet || typeof packet.payload !== 'object' || !packet.payload?.gwId) {
        continue;
      }
      return {
        gwId: packet.payload.gwId,
        ip: packet.payload.ip,
        version: packet.payload.version ?? version,
        productKey: packet.payload.productKey,
      };
    } catch {
      // Try the next candidate version — a parse failure just means this
      // wasn't the right framing, not a corrupt/malicious packet.
    }
  }
  return undefined;
}

/**
 * Run one mediated UDP broadcast scan and resolve every Tuya device seen,
 * deduplicated by `gwId`, as `{ gwId, ip, version, productKey }`.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {{ timeoutSeconds?: number }} [options]
 */
export async function discoverTuyaAnnouncements(gladys, { timeoutSeconds = 8 } = {}) {
  const announcements = await gladys.scanNetwork('udp-broadcast', { timeoutSeconds });

  const found = new Map();
  for (const { payload_base64 } of announcements) {
    const decoded = decodeAnnouncement(payload_base64);
    if (decoded?.gwId && decoded.ip) {
      found.set(decoded.gwId, decoded);
    }
  }

  logger.info(`UDP broadcast scan: ${found.size} Tuya device(s) seen on the LAN`);
  return [...found.values()];
}
