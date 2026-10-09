// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code
// — same idea as gladys-denon-avr's test/manifest.test.js: the store indexer
// validates the manifest's shape, but nothing there can know whether every
// declared action has a registered handler, or that the region/protocol
// dropdowns match what src/config.js actually accepts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  VALID_LANGUAGES,
  VALID_REGIONS,
  VALID_PROTOCOL_VERSIONS,
  VALID_QR_SCHEMES,
} from '../src/config.js';
import { WIDGET, BUTTON_SETTINGS } from '../src/widgets.js';
import { SCENE_TRIGGER } from '../src/events.js';
import { SCENE_ACTION } from '../src/scenes.js';
import { PROGRAMS, SUCTION_LEVELS, WATER_LEVELS } from '../src/cleaning.js';
import { CONSUMABLES } from '../src/tuya/dpsSchema.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// Registered directly in index.js.
const HANDLED_ACTIONS = ['test_connection', 'learn_zone', 'forget_zone'];

// Mirrors the store's manifest.schema.json bounds — checked here too since a
// manifest passing this repo's own CI is otherwise no guarantee it clears
// `npx github:GladysAssistant/integration-store .` before a release.
test('name is 3-30 characters (manifest.schema.json)', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, manifest.name);
});

test('description.en/fr are each 10-100 characters (manifest.schema.json)', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} is ${text.length} characters, must be 10-100: "${text}"`,
    );
  }
});

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      HANDLED_ACTIONS.includes(action.key),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the manifest carries the "Tuya Cloud account" intro section');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('region options exactly match src/config.js#VALID_REGIONS', () => {
  const field = manifest.config_schema.find((f) => f.key === 'region');
  assert.deepEqual(
    field.options.map((o) => o.value),
    VALID_REGIONS,
  );
});

test('protocol_version options exactly match src/config.js#VALID_PROTOCOL_VERSIONS', () => {
  const field = manifest.config_schema.find((f) => f.key === 'protocol_version');
  assert.deepEqual(
    field.options.map((o) => o.value),
    VALID_PROTOCOL_VERSIONS,
  );
});

test('qr_scheme options exactly match src/config.js#VALID_QR_SCHEMES', () => {
  const field = manifest.config_schema.find((f) => f.key === 'qr_scheme');
  assert.deepEqual(
    field.options.map((o) => o.value),
    VALID_QR_SCHEMES,
  );
});

test('the QR login is an account_link field (no redirect, matches index.js#onOAuthAuthorizeUrl)', () => {
  const field = manifest.config_schema.find((f) => f.key === 'tuya_qr_login');
  assert.equal(field.type, 'account_link');
  assert.equal(field.default, undefined);
});

test('the classic Tuya Cloud fields are all optional (the simple QR method needs none of them)', () => {
  for (const key of ['access_id', 'access_secret', 'region', 'device_ids']) {
    const field = manifest.config_schema.find((f) => f.key === key);
    assert.equal(field.required, false, `"${key}" must not be required`);
  }
});

test('the test_connection action uses the dynamic "devices" select, no static options', () => {
  const action = manifest.actions.find((a) => a.key === 'test_connection');
  const deviceField = action.fields.find((f) => f.key === 'device');
  assert.equal(deviceField.source, 'devices');
  assert.equal(deviceField.options, undefined);
});

test('network_discovery declares the UDP broadcast ports this integration decodes', () => {
  const udp = manifest.network_discovery.find((d) => d.type === 'udp-broadcast');
  assert.deepEqual(udp.ports, [6666, 6667]);
});

test('transports declares both local and cloud (dual-channel, see src/devices/vacuum.js)', () => {
  assert.deepEqual(manifest.transports, ['local', 'cloud']);
});

test('language options exactly match src/config.js#VALID_LANGUAGES', () => {
  const field = manifest.config_schema.find((f) => f.key === 'language');
  assert.deepEqual(
    field.options.map((o) => o.value),
    VALID_LANGUAGES,
  );
});

test('widgets, scene triggers and scene actions require Gladys 5.1 (store rule)', () => {
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('declared widgets are exactly the ones src/widgets.js builds (keys are forever)', () => {
  assert.deepEqual(
    manifest.widgets.map((w) => w.key),
    Object.values(WIDGET),
  );
  for (const widget of manifest.widgets) {
    const vacuum = widget.settings.find((s) => s.key === 'vacuum');
    assert.equal(vacuum.source, 'devices', `${widget.key}: the vacuum setting lists the devices`);
  }
  const quickClean = manifest.widgets.find((w) => w.key === WIDGET.QUICK_CLEAN);
  assert.deepEqual(
    quickClean.settings.filter((s) => s.key.startsWith('button_')).map((s) => s.key),
    BUTTON_SETTINGS,
  );
});

test('declared scene triggers are exactly the events src/events.js fires', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key),
    Object.values(SCENE_TRIGGER),
  );
  const low = manifest.scene_triggers.find((t) => t.key === SCENE_TRIGGER.CONSUMABLE_LOW);
  assert.deepEqual(
    low.fields.find((f) => f.key === 'consumable').options.map((o) => o.value),
    CONSUMABLES.map((c) => c.key),
  );
});

test('declared scene actions are exactly the handlers, their options the generic vocabulary', () => {
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTION),
  );
  const start = manifest.scene_actions.find((a) => a.key === SCENE_ACTION.START_CLEANING);
  const optionsOf = (key) => start.fields.find((f) => f.key === key).options.map((o) => o.value);
  assert.deepEqual(optionsOf('program'), Object.keys(PROGRAMS));
  assert.deepEqual(optionsOf('suction'), ['unchanged', ...Object.keys(SUCTION_LEVELS)]);
  assert.deepEqual(optionsOf('water'), ['unchanged', ...Object.keys(WATER_LEVELS)]);
});
