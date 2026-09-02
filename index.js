// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration for the Lubluelu SL68 (and
// compatible Tuya/Smart Life robot vacuums).
//
// Role of this file: wire the SDK to the Tuya device logic (src/tuya/,
// src/devices/). It holds NO Tuya protocol knowledge itself — only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. keeps a TuyaDeviceRegistry (src/devices/index.js) refreshed from
//      whichever onboarding method(s) are configured — the "simple" QR/
//      device-sharing login (no developer account) and/or the "advanced"
//      Tuya Cloud API — plus a mediated UDP broadcast scan, on a timer; this
//      is what catches a rotated local_key (see the README) before it locks
//      a local session out;
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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isCloudConfigured, isSharingConfigured } from './src/config.js';
import { TuyaCloudClient } from './src/tuya/cloud.js';
import { PythonBridge } from './src/tuya/pythonBridge.js';
import {
  TuyaDeviceSharingClient,
  buildQrImageUrl,
  waitForQrLogin,
} from './src/tuya/deviceSharing.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config key the device-sharing session (tokens, terminal id...) is persisted
// under, OUTSIDE config_schema — see the SDK README's oauth2 section this
// mirrors: "Store the tokens as config keys outside the config_schema: free
// internal storage, never shown in the UI". Needed so a login survives a
// container restart without asking the user to scan the QR again.
const SHARING_SESSION_CONFIG_KEY = 'tuya_sharing_session';
const QR_LOGIN_ACTION_KEY = 'tuya_qr_login';

const gladys = new GladysIntegration();

const bridge = new PythonBridge({
  logger,
  scriptPath: path.join(__dirname, 'bridge', 'tuya_bridge.py'),
});
const sharing = new TuyaDeviceSharingClient({ bridge });
const registry = new TuyaDeviceRegistry({ sharing });

let config = normalizeConfig();
let cloud = null;
let refreshTimer = null;
// Tracked separately from `config` (which is wholesale-replaced on every
// onConfigUpdated/'connected') so a same-credentials refresh never needlessly
// throws away the registry's cache — only an actual credentials change does.
let lastCloudCredentials = null;

function cloudCredentialsChanged(next) {
  return (
    lastCloudCredentials?.access_id !== next.access_id ||
    lastCloudCredentials?.access_secret !== next.access_secret
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

/** Re-persist the device-sharing session if its tokens rotated since last saved (see bridge/tuya_bridge.py's _TokenSaver). */
async function resyncSharingSession() {
  try {
    const session = await sharing.getSession();
    if (session) {
      await gladys.setConfig({ [SHARING_SESSION_CONFIG_KEY]: JSON.stringify(session) });
    }
  } catch (err) {
    logger.debug(`Could not resync the device-sharing session: ${err.message}`);
  }
}

/**
 * Re-fetch every configured device's local_key/DP schema (from whichever
 * onboarding method(s) are set up) + the LAN IP from a UDP broadcast scan,
 * then reconcile: publish discovery (only when `forceDiscovery`, i.e. an
 * explicit scan or a config change — not on every timer tick, matching
 * gladys-hydro-quebec's own distinction) and push the fresh data into
 * already-created devices' local sessions (a rotated key, a changed IP...).
 */
async function refreshAndReconcile({ forceDiscovery }) {
  if (!isCloudConfigured(config) && !isSharingConfigured(config)) {
    await gladys.publishDiscoveredDevices([]);
    await gladys.setConnectionStatus(false, {
      en: 'Connect your Smart Life account (recommended) or enter your Tuya Cloud API credentials in the Configuration screen.',
      fr: 'Connectez votre compte Smart Life (recommandé) ou entrez vos identifiants API Cloud Tuya dans l’écran de configuration.',
    });
    return;
  }

  if (isCloudConfigured(config)) {
    if (!cloud || cloudCredentialsChanged(config)) {
      cloud = new TuyaCloudClient({
        accessId: config.access_id,
        accessSecret: config.access_secret,
        region: config.region,
      });
      registry.cloud = cloud;
    }
    lastCloudCredentials = { access_id: config.access_id, access_secret: config.access_secret };
  } else {
    cloud = null;
    registry.cloud = null;
  }

  await registry.refresh(gladys, config.deviceIds);
  await resyncSharingSession();

  if (forceDiscovery) {
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, registry));
  }
  await reconcileConnections(gladys, config, registry);

  const ready = registry.values().some((entry) => entry.localKey && entry.dpsByCode.size > 0);
  if (ready) {
    await gladys.setConnectionStatus(true);
  } else {
    await gladys.setConnectionStatus(false, {
      en: 'Could not reach any device yet — check your Smart Life connection or Tuya Cloud API credentials.',
      fr: 'Impossible de joindre un appareil pour le moment — vérifiez la connexion Smart Life ou les identifiants API Cloud Tuya.',
    });
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info(
    'onScanRequest -> refreshing from every configured Tuya method + a LAN broadcast scan',
  );
  try {
    await refreshAndReconcile({ forceDiscovery: true });
  } catch (err) {
    logger.error('Discovery failed', err);
    await gladys.setConnectionStatus(false, {
      en: `Discovery failed: ${err.message}`,
      fr: `Échec de la découverte : ${err.message}`,
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

// --- "Simple" method: QR / device-sharing login, no developer account --------
// account_link never redirects back (see the SDK README): this resolves the
// URL to open (a rendered QR image, see buildQrImageUrl — NOT itself openable
// as a link, see src/tuya/deviceSharing.js), then watches for the approval
// itself and reports it through setConnectionStatus(), exactly per contract.
gladys.onOAuthAuthorizeUrl(async (key) => {
  if (key !== QR_LOGIN_ACTION_KEY) {
    throw new Error(`Unknown account_link key "${key}"`);
  }

  // Re-fetch rather than trust the module-level `config`: Gladys saves the
  // form and requests this authorize URL as two separate calls, and a Connect
  // click can reach this handler before this process's own onConfigUpdated
  // has caught up with a user_code the user just saved — which surfaced as
  // this exact check rejecting a correct, freshly-saved code.
  config = normalizeConfig(await gladys.getConfig());
  if (!config.user_code) {
    throw new Error(
      'Enter your Smart Life user code first (Me > Settings > Account and Security).',
    );
  }

  const { token, content } = await sharing.startQrLogin(config.user_code, config.qr_scheme);

  // Fire-and-forget: the button click only waits for the QR image URL above,
  // this poll loop runs in the background until the user scans it.
  waitForQrLogin(sharing.pollQrLogin.bind(sharing), token, config.user_code)
    .then(async (session) => {
      logger.info('Smart Life QR login succeeded');
      await gladys.setConfig({ [SHARING_SESSION_CONFIG_KEY]: JSON.stringify(session) });
      await refreshAndReconcile({ forceDiscovery: true });
    })
    .catch(async (err) => {
      logger.warn(`Smart Life QR login did not complete: ${err.message}`);
      await gladys
        .setConnectionStatus(false, {
          en: `Smart Life login not completed: ${err.message}`,
          fr: `Connexion Smart Life non terminée : ${err.message}`,
        })
        .catch(() => {});
    });

  return buildQrImageUrl(content);
});

// --- Device lifecycle: open/close the local session as devices come and go ---
gladys.onDeviceCreated(async (device) => {
  const deviceId = deviceIdOf(device);
  const entry = deviceId ? registry.get(deviceId) : undefined;
  if (!entry) {
    logger.warn(`Device created (${device.external_id}) but no Tuya data known for it yet`);
    return;
  }
  logger.info(`Device created -> connecting ${device.external_id}`);
  connectDevice(gladys, device, config, entry);
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
      en: `Refresh failed: ${err.message}`,
      fr: `Échec du rafraîchissement : ${err.message}`,
    });
  }
  scheduleRefreshTimer();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());

    if (config[SHARING_SESSION_CONFIG_KEY]) {
      try {
        const session = JSON.parse(config[SHARING_SESSION_CONFIG_KEY]);
        await sharing.restoreSession(session);
        logger.info('Restored the Smart Life device-sharing session');
      } catch (err) {
        // Not cleared: could be transient (bridge not ready yet at boot) —
        // a real re-login is one QR scan away either way.
        logger.warn(`Could not restore the Smart Life session: ${err.message}`);
      }
    }

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
  bridge.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Lubluelu SL68 / Tuya vacuum integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
