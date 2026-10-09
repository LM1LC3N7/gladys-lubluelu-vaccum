// -----------------------------------------------------------------------------
// A Tuya LiDAR robot vacuum (category `sd`) for tests: the DP schema of a
// typical laser robot (codes and ranges as the robot-vacuum category and the
// X-Plorer / Home Assistant references name them), and a helper registering a
// connection for it with fake local and cloud clients that record commands.
// -----------------------------------------------------------------------------

import { indexDpsByCode } from '../src/tuya/dpsSchema.js';
import { __setConnectionForTesting, buildFeatures } from '../src/devices/vacuum.js';

const dp = (code, dpId, type, values = {}) => ({
  code,
  dp_id: dpId,
  type,
  values: JSON.stringify(values),
});

export const ROBOT_SPEC = {
  status: [
    dp('power_go', 1, 'Boolean'),
    dp('pause', 2, 'Boolean'),
    dp('switch_charge', 3, 'Boolean'),
    dp('mode', 4, 'Enum', {
      range: ['standby', 'smart', 'wall_follow', 'spiral', 'selectroom', 'zone', 'chargego'],
    }),
    dp('status', 5, 'Enum', {
      range: [
        'standby',
        'smart',
        'cleaning',
        'paused',
        'goto_charge',
        'charging',
        'charge_done',
        'fault',
      ],
    }),
    dp('clean_time', 6, 'Value', { min: 0, max: 9999, scale: 0, unit: 'min' }),
    dp('clean_area', 7, 'Value', { min: 0, max: 9999, scale: 1, unit: 'm²' }),
    dp('electricity_left', 8, 'Value', { min: 0, max: 100, scale: 0, unit: '%' }),
    dp('suction', 9, 'Enum', { range: ['gentle', 'normal', 'strong', 'max'] }),
    dp('cistern', 10, 'Enum', { range: ['closed', 'low', 'middle', 'high'] }),
    dp('seek', 11, 'Boolean'),
    dp('direction_control', 12, 'Enum', {
      range: ['forward', 'backward', 'turn_left', 'turn_right', 'stop'],
    }),
    dp('command_trans', 15, 'Raw'),
    dp('edge_brush', 17, 'Value', { min: 0, max: 100 }),
    dp('reset_edge_brush', 18, 'Boolean'),
    dp('roll_brush', 19, 'Value', { min: 0, max: 100 }),
    dp('reset_roll_brush', 20, 'Boolean'),
    dp('filter', 21, 'Value', { min: 0, max: 100 }),
    dp('reset_filter', 22, 'Boolean'),
    dp('fault', 28, 'Bitmap', {
      label: [
        'edge_sweep',
        'middle_sweep',
        'left_wheel',
        'right_wheel',
        'garbage_box',
        'land_check',
        'collision',
      ],
      maxlen: 7,
    }),
  ],
};

export const EXTERNAL_ID = 'vacuum:eb111';

/**
 * Register a connection for the robot, with recording fakes.
 * @returns {{ entry: object, localCalls: Array, cloudCalls: Array }}
 */
export function registerRobot({
  local = true,
  zones = [],
  spec = ROBOT_SPEC,
  language = 'en',
} = {}) {
  const dpsByCode = indexDpsByCode(spec);
  const tables = buildFeatures(EXTERNAL_ID, dpsByCode, language, { zones });
  const localCalls = [];
  const cloudCalls = [];
  const entry = {
    deviceId: 'eb111',
    name: 'SL68',
    ip: local ? '192.168.1.42' : undefined,
    local: {
      isConnected: () => local,
      async set(dpId, value) {
        localCalls.push({ dpId, value });
        return true;
      },
      updateKey() {},
      stop() {},
    },
    cloud: {
      async sendCommand(deviceId, code, value) {
        cloudCalls.push({ deviceId, code, value });
      },
      async getStatus() {
        return [];
      },
    },
    dpsByCode,
    codeByDpId: new Map([...dpsByCode].map(([code, d]) => [String(d.dpId), code])),
    ...tables,
  };
  delete entry.features;
  __setConnectionForTesting(EXTERNAL_ID, entry);
  return { localCalls, cloudCalls, features: tables.features };
}
