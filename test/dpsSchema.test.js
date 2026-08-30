import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexDpsByCode,
  buildKnownFeatures,
  parseValues,
  DOCK_MODE_VALUES,
} from '../src/tuya/dpsSchema.js';

test('parseValues parses the schema JSON string and never throws', () => {
  assert.deepEqual(parseValues('{"range":["smart","chargego"]}'), {
    range: ['smart', 'chargego'],
  });
  assert.deepEqual(parseValues(''), {});
  assert.deepEqual(parseValues(undefined), {});
  assert.deepEqual(parseValues('not-json'), {});
});

test('indexDpsByCode merges functions + status, functions never overriding status', () => {
  const spec = {
    status: [{ code: 'switch_status', dp_id: 1, type: 'Boolean', values: '{}' }],
    functions: [
      { code: 'switch_status', dp_id: 99, type: 'Boolean', values: '{}' },
      { code: 'mode', dp_id: 2, type: 'Enum', values: '{"range":["smart","chargego"]}' },
    ],
  };
  const byCode = indexDpsByCode(spec);
  assert.equal(byCode.get('switch_status').dpId, 1); // status wins, listed first
  assert.equal(byCode.get('mode').dpId, 2);
  assert.deepEqual(byCode.get('mode').values, { range: ['smart', 'chargego'] });
});

test('buildKnownFeatures only builds features for codes actually present', () => {
  const byCode = indexDpsByCode({
    status: [
      { code: 'switch_status', dp_id: 1, type: 'Boolean', values: '{}' },
      { code: 'electricity_left', dp_id: 4, type: 'Value', values: '{"min":0,"max":100}' },
    ],
  });
  const features = buildKnownFeatures(byCode);
  assert.equal(features.length, 2);
  assert.ok(features.some((f) => f.key === 'power' && f.dpId === 1));
  assert.ok(features.some((f) => f.key === 'battery' && f.dpId === 4));
});

test('buildKnownFeatures skips a code whose live type does not match the builder', () => {
  // "mode" reported as a Boolean instead of an Enum: schema surprise, not a crash.
  const byCode = indexDpsByCode({
    status: [{ code: 'mode', dp_id: 2, type: 'Boolean', values: '{}' }],
  });
  assert.deepEqual(buildKnownFeatures(byCode), []);
});

test('mode select carries the raw enum values for onSetValue() dispatch', () => {
  const byCode = indexDpsByCode({
    status: [
      { code: 'mode', dp_id: 2, type: 'Enum', values: '{"range":["smart","chargego","pause"]}' },
    ],
  });
  const [modeFeature] = buildKnownFeatures(byCode);
  assert.deepEqual(modeFeature.rawValues, ['smart', 'chargego', 'pause']);
  assert.equal(modeFeature.supported_options.length, 3);
  assert.ok(modeFeature.rawValues.some((v) => DOCK_MODE_VALUES.includes(v)));
});

test('mode select falls back to the raw token as a label for an unrecognized enum value', () => {
  const byCode = indexDpsByCode({
    status: [{ code: 'mode', dp_id: 2, type: 'Enum', values: '{"range":["some_new_mode"]}' }],
  });
  const [modeFeature] = buildKnownFeatures(byCode);
  assert.deepEqual(modeFeature.supported_options, [
    { value: 'some_new_mode', label: 'some_new_mode' },
  ]);
});

test('battery feature is read-only and bounded from the schema min/max', () => {
  const byCode = indexDpsByCode({
    status: [{ code: 'electricity_left', dp_id: 4, type: 'Value', values: '{"min":0,"max":100}' }],
  });
  const [battery] = buildKnownFeatures(byCode);
  assert.equal(battery.read_only, true);
  assert.equal(battery.min, 0);
  assert.equal(battery.max, 100);
});
