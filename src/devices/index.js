// -----------------------------------------------------------------------------
// Device discovery + connection composition.
//
// Two independent, mergeable onboarding methods feed the same registry:
//   - "Simple" (recommended): src/tuya/deviceSharing.js — one QR login lists
//     EVERY device on the account, each with its local_key + full DP schema
//     already attached. Nothing to configure per device: pairing a new
//     vacuum in the Smart Life app is enough, exactly like the official app.
//   - "Advanced": the Tuya Cloud API (src/tuya/cloud.js) for an explicit
//     list of Device ids (config.device_ids).
// Both are then joined with whatever LAN IP the mediated UDP broadcast scan
// reports (best-effort, config.device_ips is the manual fallback) into the
// payload gladys.publishDiscoveredDevices() expects, and used to keep
// already-created devices' local sessions in sync (a rotated local_key, an
// IP that changed in DHCP...) — see src/devices/vacuum.js for the per-device
// connection logic itself; this module only composes.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { discoverTuyaAnnouncements } from '../tuya/udpDiscovery.js';
import { indexDpsByCode } from '../tuya/dpsSchema.js';
import { toRegistryEntry } from '../tuya/deviceSharing.js';
import { buildDiscoveredDevice, connectDevice, deviceIdOf } from './vacuum.js';

const logger = createLogger({ name: 'discovery' });

/**
 * Whether `ip` is a private IPv4 address (RFC1918 + loopback + link-local).
 * Tuya's device-sharing API's own `device.ip` field has been observed to
 * report the device's WAN-facing address (as seen by Tuya's servers, since
 * the vacuum reaches the cloud through the same router as everything else on
 * the LAN) rather than a real LAN address — trusting it as a local_key-style
 * fallback for local control then means `tuya-local`'s TCP client hammers a
 * public IP forever with "connection timed out", never actually reaching the
 * device. Only the UDP broadcast scan (a real LAN packet) or an explicit
 * manual `device_ips` override are trustworthy local IPs; this rejects
 * anything else so the caller falls back to "no LAN IP known yet" instead.
 */
function isPrivateIPv4(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip ?? '');
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Caches what each configured onboarding method + the UDP broadcast scan know
 * about every device, and refresh()es it on demand — the entry point
 * (index.js) calls refresh() at startup, on every config change, on Discovery
 * scans, and on a periodic timer (config.refresh_interval_minutes) to catch a
 * rotated local_key before it locks the local session out.
 */
export class TuyaDeviceRegistry {
  /** @param {{ cloud?: import('../tuya/cloud.js').TuyaCloudClient, sharing?: import('../tuya/deviceSharing.js').TuyaDeviceSharingClient }} clients */
  constructor({ cloud, sharing } = {}) {
    this.cloud = cloud;
    this.sharing = sharing;
    // deviceId -> { deviceId, name, localKey, version, dpsByCode, ip, cloud, source }
    this.devices = new Map();
  }

  get(deviceId) {
    return this.devices.get(deviceId);
  }

  values() {
    return [...this.devices.values()];
  }

  /**
   * Re-fetch every source and merge the result. A single device (or an
   * entire source) failing is logged and skipped rather than aborting the
   * other source's refresh — and never evicts what a previous, successful
   * refresh already knows (see the per-source pruning below).
   */
  async refresh(gladys, deviceIds) {
    let announcements = [];
    try {
      announcements = await discoverTuyaAnnouncements(gladys);
    } catch (err) {
      logger.warn(`UDP broadcast scan failed: ${err.message}`);
    }
    const ipByGwId = new Map(announcements.map((a) => [a.gwId, a]));

    if (this.sharing) {
      await this._refreshSharing(ipByGwId);
    }
    if (this.cloud) {
      await this._refreshCloud(deviceIds, ipByGwId);
    }
  }

  async _refreshSharing(ipByGwId) {
    let devices;
    try {
      devices = await this.sharing.discoverDevices();
    } catch (err) {
      // "No active device-sharing session" just means the QR login hasn't
      // happened (yet) — expected and silent-ish, not a failure to surface
      // loudly on every refresh tick until the user does log in.
      const level = /No active device-sharing session/.test(err.message) ? 'debug' : 'error';
      logger[level](`Device sharing discovery failed: ${err.message}`);
      return;
    }

    const freshIds = new Set();
    for (const device of devices) {
      const entry = toRegistryEntry(device);
      const announcement = ipByGwId.get(entry.deviceId);
      if (entry.ip && !announcement && !isPrivateIPv4(entry.ip)) {
        logger.debug(
          `Ignoring non-LAN IP reported by device sharing for ${entry.deviceId}: ${entry.ip}`,
        );
      }
      this.devices.set(entry.deviceId, {
        ...entry,
        ip: announcement?.ip || (isPrivateIPv4(entry.ip) ? entry.ip : undefined),
        version: announcement?.version,
        cloud: this.sharing,
        source: 'sharing',
      });
      freshIds.add(entry.deviceId);
    }

    // Only a device-sharing entry from a PREVIOUS successful call can be
    // pruned here (an unlinked/removed device) — cloud-sourced entries are
    // pruned by _refreshCloud() against config.device_ids instead.
    for (const [id, entry] of this.devices) {
      if (entry.source === 'sharing' && !freshIds.has(id)) {
        this.devices.delete(id);
      }
    }
  }

  async _refreshCloud(deviceIds, ipByGwId) {
    for (const deviceId of deviceIds) {
      try {
        const [details, specifications] = await Promise.all([
          this.cloud.getDevice(deviceId),
          this.cloud.getSpecifications(deviceId),
        ]);
        const announcement = ipByGwId.get(deviceId);
        this.devices.set(deviceId, {
          deviceId,
          name: details.name,
          localKey: details.local_key,
          version: announcement?.version,
          dpsByCode: indexDpsByCode(specifications),
          ip: announcement?.ip,
          cloud: this.cloud,
          source: 'cloud',
        });
      } catch (err) {
        logger.error(`Tuya Cloud lookup failed for ${deviceId}: ${err.message}`);
      }
    }

    for (const [id, entry] of this.devices) {
      if (entry.source === 'cloud' && !deviceIds.includes(id)) {
        this.devices.delete(id);
      }
    }
  }
}

/** Build the full discovery payload: one entry per successfully-refreshed device. */
export function buildDiscoveredDevices(gladys, registry) {
  return registry
    .values()
    .filter((entry) => entry.localKey && entry.dpsByCode.size > 0)
    .map((entry) => buildDiscoveredDevice(gladys, entry));
}

/**
 * (Re)connect every device Gladys already created, using the registry's
 * current data — safe to call repeatedly (connectDevice() is idempotent,
 * see src/devices/vacuum.js), and the way a rotated local_key or a changed
 * LAN IP actually reaches an already-running local session.
 */
export async function reconcileConnections(gladys, config, registry) {
  const devices = await gladys.getDevices();
  for (const device of devices) {
    const deviceId = deviceIdOf(device);
    const entry = deviceId ? registry.get(deviceId) : undefined;
    if (!entry) {
      continue; // Not (yet, or anymore) known by any configured method — nothing to connect with.
    }
    if (!entry.localKey || entry.dpsByCode.size === 0) {
      logger.warn(`Skipping ${device.external_id}: incomplete Tuya data`);
      continue;
    }
    connectDevice(gladys, device, config, entry);
  }
}
