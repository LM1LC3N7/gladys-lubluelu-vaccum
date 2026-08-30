// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// Reproduces the only surface the device modules rely on — same shape as
// gladys-denon-avr's test-fixtures/fakeGladys.js, plus scanNetwork() for the
// UDP broadcast discovery this integration adds. Lets us test the pure
// "wiring" logic (discovery payloads, dispatch) without a running Gladys
// server, a real WebSocket, or a real LAN broadcast.
// -----------------------------------------------------------------------------

export function createFakeGladys({ scanNetworkResult = [] } = {}) {
  const published = [];
  const transports = [];
  const connectionStatuses = [];
  const discoveredDevices = [];

  return {
    published,
    transports,
    connectionStatuses,
    discoveredDevices,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async publishDiscoveredDevices(devices) {
      discoveredDevices.length = 0;
      discoveredDevices.push(...devices);
    },

    async getDevices() {
      return discoveredDevices;
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async scanNetwork() {
      return scanNetworkResult;
    },
  };
}
