// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration for the Lubluelu SL68 (and
// compatible Tuya/Smart Life robot vacuums).
//
// Role of this file: wire the SDK to the Tuya cloud+local device logic
// (src/tuya/, src/devices/). It holds NO Tuya protocol knowledge itself —
// only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. keeps a TuyaDeviceRegistry (src/devices/index.js) refreshed from the
//      Tuya Cloud API + a mediated UDP broadcast scan, on a timer — this is
//      what catches a rotated local_key (see the README) before it locks a
//      local session out;
//   3. registers the event handlers BEFORE connect();
//   4. connects/reconciles the local session of every vacuum the user
//      already created.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigured } from './src/config.js';
import { TuyaCloudClient } from './src/tuya/cloud.js';
import {
  TuyaDeviceRegistry,
  buildDiscoveredDevices,
  reconcileConnections,
} from './src/devices/index.js';
import {
  connectDevice,
  disconnectDevice,
  disconnectAllDevices,
  deviceIdOf,
  onSetValue as dispatchSetValue,
  runTestConnectionAction,
} from './src/devices/vacuum.js';

const gladys = new GladysIntegration();

let config = normalizeConfig();
let cloud = null;
let registry = null;
let refreshTimer = null;
// Tracked separately from `config` (which is wholesale-replaced on every
// onConfigUpdated/'connected') so a same-credentials refresh never needlessly
// throws away the registry's cache — only an actual credentials change does.
let lastCredentials = null;

function credentialsChanged(next) {
  return (
    lastCredentials?.access_id !== next.access_id ||
    lastCredentials?.access_secret !== next.access_secret
  );
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefreshTimer() {
  stopRefreshTimer();
  refreshTimer = setInterval(
    () => {
      refreshAndReconcile({ forceDiscovery: false }).catch((err) =>
        logger.error(`Scheduled Tuya refresh failed: ${err.message}`),
      );
    },
    config.refresh_interval_minutes * 60 * 1000,
  );
}

/**
 * Re-fetch every configured device's local_key/DP schema from the Tuya
 * Cloud API + the LAN IP from a UDP broadcast scan, then reconcile: publish
 * discovery (only when `forceDiscovery`, i.e. an explicit scan or a config
 * change — not on every timer tick, matching gladys-hydro-quebec's own
 * distinction) and push the fresh data into already-created devices' local
 * sessions (a rotated key, a changed IP...).
 */
async function refreshAndReconcile({ forceDiscovery }) {
  if (!isConfigured(config)) {
    await gladys.publishDiscoveredDevices([]);
    await gladys.setConnectionStatus(false, {
      en: 'Enter your Tuya Cloud API credentials and at least one device id in the Configuration screen.',
      fr: "Entrez vos identifiants d'API Cloud Tuya et au moins un identifiant d'appareil dans l'écran de configuration.",
    });
    return;
  }

  if (!cloud || credentialsChanged(config)) {
    cloud = new TuyaCloudClient({
      accessId: config.access_id,
      accessSecret: config.access_secret,
      region: config.region,
    });
    registry = new TuyaDeviceRegistry(cloud);
  }
  lastCredentials = { access_id: config.access_id, access_secret: config.access_secret };

  await registry.refresh(gladys, config.deviceIds);

  if (forceDiscovery) {
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, registry));
  }
  await reconcileConnections(gladys, config, registry);

  const ready = registry.values().some((entry) => entry.localKey && entry.dpsByCode.size > 0);
  if (ready) {
    await gladys.setConnectionStatus(true);
  } else {
    await gladys.setConnectionStatus(false, {
      en: 'Could not reach any configured device through the Tuya Cloud API — check the device id(s), region and credentials.',
      fr: "Impossible de joindre un appareil configuré via l'API Cloud Tuya — vérifiez le(s) identifiant(s) d'appareil, la région et les identifiants.",
    });
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> refreshing from the Tuya Cloud API + a LAN broadcast scan');
  try {
    await refreshAndReconcile({ forceDiscovery: true });
  } catch (err) {
    logger.error('Discovery failed', err);
    await gladys.setConnectionStatus(false, {
      en: `Could not reach the Tuya Cloud API: ${err.message}`,
      fr: `Impossible de joindre l'API Cloud Tuya : ${err.message}`,
    });
  }
});

// --- Command: the user acts on a controllable feature -------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  await dispatchSetValue(gladys, { device, feature, value, config });
});

// --- Manifest action: test the connection -------------------------------------
gladys.onAction('test_connection', (fields) => runTestConnectionAction(gladys, { fields }));

// --- Device lifecycle: open/close the local session as devices come and go ---
gladys.onDeviceCreated(async (device) => {
  const deviceId = deviceIdOf(device);
  const entry = deviceId ? registry?.get(deviceId) : undefined;
  if (!entry) {
    logger.warn(`Device created (${device.external_id}) but no Tuya Cloud data known for it yet`);
    return;
  }
  logger.info(`Device created -> connecting ${device.external_id}`);
  connectDevice(gladys, device, config, { ...entry, cloud });
});

gladys.onDeviceDeleted(async (device) => {
  logger.info(`Device deleted -> disconnecting ${device.external_id}`);
  disconnectDevice(device.external_id);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  try {
    await refreshAndReconcile({ forceDiscovery: true });
  } catch (err) {
    logger.error('Refresh after config update failed', err);
    await gladys.setConnectionStatus(false, {
      en: `Could not reach the Tuya Cloud API: ${err.message}`,
      fr: `Impossible de joindre l'API Cloud Tuya : ${err.message}`,
    });
  }
  scheduleRefreshTimer();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await refreshAndReconcile({ forceDiscovery: false });
    scheduleRefreshTimer();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // Deliberately NOT tearing down local sessions here: they are real TCP
  // connections to each vacuum, independent of the Gladys WebSocket — same
  // reasoning as gladys-denon-avr's own 'disconnected' handler.
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshTimer();
  disconnectAllDevices();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Lubluelu SL68 / Tuya vacuum integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
