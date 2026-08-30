// -----------------------------------------------------------------------------
// Resilient local Tuya session: connect, keep alive, reconnect with backoff.
//
// The actual AES/framing protocol work (encrypt/decrypt, CRC, 3.1/3.3/3.4
// framing) is delegated to `tuyapi`'s `TuyaDevice` — a maintained, widely
// used implementation (see the module doc comment in src/tuya/cloud.js for
// why this integration doesn't hand-roll that part). This module only owns
// what's specific to running it INSIDE a Gladys integration container: a
// persistent session per device with automatic reconnection (mirrors the
// shape of gladys-denon-avr's src/denon/telnet.js, same reconnect-with-
// capped-backoff idea, different transport), and translating `dps` updates
// into calls a caller in src/devices/vacuum.js can react to.
//
// Only ONE client may hold the TCP connection to a given device at a time
// (shared limitation of the protocol, not this code): keeping the phone app
// open for the same device while this runs will fight over the socket.
// -----------------------------------------------------------------------------

import TuyaDevice from 'tuyapi';
import { MessageParser } from 'tuyapi/lib/message-parser.js';
import { createLogger } from '@gladysassistant/integration-sdk';

const MAX_RECONNECT_DELAY_SECONDS = 120;

/** Same linear-capped backoff curve as gladys-denon-avr's telnet client. */
export function computeReconnectDelayMs(attempt, baseIntervalSeconds) {
  const base = Math.max(1, Number(baseIntervalSeconds) || 10);
  const seconds = Math.min(base * Math.max(1, attempt), MAX_RECONNECT_DELAY_SECONDS);
  return seconds * 1000;
}

/**
 * Open a resilient local session to one Tuya device.
 *
 * @param {object} opts
 * @param {string} opts.id Tuya device id
 * @param {string} opts.key local_key (see src/tuya/cloud.js — rotates, so
 *   `updateKey()` below lets the caller apply a freshly-fetched one without
 *   tearing down and recreating the whole client)
 * @param {string} opts.ip LAN IP address
 * @param {string|number} [opts.version] protocol version (from UDP discovery
 *   when known, otherwise the manifest's configured fallback)
 * @param {number} [opts.reconnectIntervalSeconds]
 * @param {(dps: Record<string, unknown>) => void} [opts.onData] fired with
 *   every `dps` update (both the initial `issueGetOnConnect` snapshot and
 *   later pushed changes)
 * @param {() => void} [opts.onConnect]
 * @param {(consecutiveFailures: number) => void} [opts.onDisconnect]
 * @returns {{ set(dpId: number, value: unknown): Promise<boolean>, isConnected(): boolean,
 *   updateKey(key: string): void, stop(): void }}
 */
export function createTuyaLocalClient({
  id,
  key,
  ip,
  version = '3.3',
  reconnectIntervalSeconds = 10,
  onData,
  onConnect,
  onDisconnect,
}) {
  const logger = createLogger({ name: `tuya-local:${id}` });
  let stopped = false;
  let connected = false;
  let reconnectTimer = null;
  let consecutiveFailures = 0;

  const device = new TuyaDevice({
    id,
    key,
    ip,
    version,
    issueGetOnConnect: true,
  });

  device.on('connected', () => {
    connected = true;
    consecutiveFailures = 0;
    logger.info(`Connected to ${ip}`);
    onConnect?.();
  });

  device.on('data', (data) => {
    if (data?.dps) {
      onData?.(data.dps);
    }
  });

  device.on('dp-refresh', (data) => {
    if (data?.dps) {
      onData?.(data.dps);
    }
  });

  device.on('error', (err) => {
    logger.warn(`Socket error for ${ip}: ${err.message}`);
  });

  device.on('disconnected', () => {
    connected = false;
    consecutiveFailures += 1;
    onDisconnect?.(consecutiveFailures);
    scheduleReconnect();
  });

  // Guarded by `reconnectTimer` below: connect() rejecting AND the device
  // emitting 'disconnected' for the same failure both route here, and the
  // guard makes that harmless instead of scheduling two reconnect timers.
  function scheduleReconnect() {
    if (stopped || reconnectTimer) {
      return;
    }
    const delayMs = computeReconnectDelayMs(consecutiveFailures, reconnectIntervalSeconds);
    logger.debug(
      `Reconnecting to ${ip} in ${delayMs / 1000}s (attempt ${consecutiveFailures + 1})`,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectOnce();
    }, delayMs);
  }

  function connectOnce() {
    if (stopped) {
      return;
    }
    device.connect().catch((err) => {
      logger.warn(`Connect to ${ip} failed: ${err.message}`);
      consecutiveFailures += 1;
      onDisconnect?.(consecutiveFailures);
      scheduleReconnect();
    });
  }

  connectOnce();

  return {
    /** Set one DP by numeric id. Resolves `false` (never rejects) when not connected. */
    async set(dpId, value) {
      if (!connected) {
        return false;
      }
      try {
        await device.set({ dps: dpId, set: value });
        return true;
      } catch (err) {
        logger.warn(`set(${dpId}, ${value}) on ${ip} failed: ${err.message}`);
        return false;
      }
    },
    isConnected() {
      return connected;
    },
    /**
     * Apply a freshly cloud-refreshed local_key without recreating the whole
     * client. `device.device.parser` holds its own AES cipher keyed at
     * construction time (tuyapi internals), so it must be rebuilt too — just
     * assigning `.key` would leave the parser silently decrypting with the
     * stale key.
     */
    updateKey(newKey) {
      if (newKey === device.device.key) {
        return;
      }
      device.device.key = newKey;
      device.device.parser = new MessageParser({ key: newKey, version: device.device.version });
    },
    /** Stop reconnecting and close the current session. */
    stop() {
      stopped = true;
      connected = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      device.disconnect();
    },
  };
}
