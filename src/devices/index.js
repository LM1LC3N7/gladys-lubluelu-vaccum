// -----------------------------------------------------------------------------
// Device discovery + connection composition.
//
// Ties together the three independent sources of truth this integration
// needs per configured Tuya device id:
//   - the Tuya Cloud API (src/tuya/cloud.js)   -> local_key + DP schema
//   - the mediated UDP broadcast scan          -> the LAN IP (best-effort)
//   - config.device_ips                        -> the manual IP fallback
// into the payload gladys.publishDiscoveredDevices() expects, and keeps
// already-created devices' local sessions in sync with it (a rotated
// local_key, an IP that changed in DHCP...) — see src/devices/vacuum.js for
// the per-device connection logic itself; this module only composes.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { discoverTuyaAnnouncements } from '../tuya/udpDiscovery.js';
import { indexDpsByCode } from '../tuya/dpsSchema.js';
import { buildDiscoveredDevice, connectDevice, deviceIdOf } from './vacuum.js';

const logger = createLogger({ name: 'discovery' });

/**
 * Caches what the Tuya Cloud API + UDP broadcast know about every configured
 * device id, and refresh()es it on demand — the entry point (index.js) calls
 * refresh() at startup, on every config change, on Discovery scans, and on a
 * periodic timer (config.refresh_interval_minutes) to catch a rotated
 * local_key before it locks the local session out.
 */
export class TuyaDeviceRegistry {
  constructor(cloud) {
    this.cloud = cloud;
    // deviceId -> { deviceId, name, localKey, version, dpsByCode, ip }
    this.devices = new Map();
  }

  get(deviceId) {
    return this.devices.get(deviceId);
  }

  values() {
    return [...this.devices.values()];
  }

  /**
   * Re-fetch cloud device details + DP schema for every configured id, and
   * merge in whatever IP the UDP broadcast scan currently reports. A single
   * device's cloud lookup failing (offline, wrong id...) is logged and
   * skipped rather than aborting every other device's refresh.
   */
  async refresh(gladys, deviceIds) {
    let announcements = [];
    try {
      announcements = await discoverTuyaAnnouncements(gladys);
    } catch (err) {
      logger.warn(`UDP broadcast scan failed: ${err.message}`);
    }
    const ipByGwId = new Map(announcements.map((a) => [a.gwId, a]));

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
        });
      } catch (err) {
        logger.error(`Tuya Cloud lookup failed for ${deviceId}: ${err.message}`);
      }
    }

    // Drop entries for ids no longer configured.
    for (const knownId of this.devices.keys()) {
      if (!deviceIds.includes(knownId)) {
        this.devices.delete(knownId);
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
      continue; // Not (yet, or anymore) known through the cloud — nothing to connect with.
    }
    if (!entry.localKey || entry.dpsByCode.size === 0) {
      logger.warn(`Skipping ${device.external_id}: incomplete Tuya Cloud data`);
      continue;
    }
    connectDevice(gladys, device, config, { ...entry, cloud: registry.cloud });
  }
}
