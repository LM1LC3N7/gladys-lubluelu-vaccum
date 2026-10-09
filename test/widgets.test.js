import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  WIDGET,
  emptyContent,
  quickCleanButtons,
  resolveWidgetVacuum,
  widgetCommand,
  widgetContent,
  widgetToast,
} from '../src/widgets.js';
import { runWidgetCommand } from '../src/scenes.js';
import {
  applyDps,
  getConnection,
  listConnections,
  __clearConnectionsForTesting,
} from '../src/devices/vacuum.js';
import { encodeRoomClean } from '../src/tuya/sweeper.js';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { EXTERNAL_ID, ROBOT_SPEC, registerRobot } from '../test-fixtures/robot.js';

const KITCHEN = { name: 'Kitchen', slug: 'kitchen', command: encodeRoomClean([2]) };

// Every robot situation a dashboard may show.
const SITUATIONS = {
  unknown: {},
  cleaning: { 5: 'cleaning', 4: 'smart', 6: 12, 7: 85, 8: 64, 9: 'strong', 10: 'low' },
  paused: { 5: 'paused', 8: 40 },
  docked: { 5: 'charge_done', 8: 100, 17: 15, 19: 60, 21: 5 },
  error: { 5: 'fault', 28: 0b101, 8: 12 },
};

async function robotIn(situation, options = {}) {
  __clearConnectionsForTesting();
  const fakes = registerRobot({ zones: [KITCHEN], ...options });
  await applyDps(createFakeGladys(), EXTERNAL_ID, SITUATIONS[situation]);
  return { ...fakes, entry: getConnection(EXTERNAL_ID) };
}

test('widgets - every widget produces a valid content, in every situation and both languages', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  for (const situation of Object.keys(SITUATIONS)) {
    for (const local of [true, false]) {
      const { entry } = await robotIn(situation, { local });
      for (const key of Object.values(WIDGET)) {
        for (const language of ['en', 'fr']) {
          const content = widgetContent(key, EXTERNAL_ID, entry, {}, language);
          assert.deepEqual(validateWidgetContent(content), [], `${key} ${situation} ${language}`);
        }
      }
    }
  }
});

test('widgets - empty states are a sentence, never an error', () => {
  for (const reason of ['none', 'unknown']) {
    assert.deepEqual(validateWidgetContent(emptyContent(reason)), []);
  }
  assert.deepEqual(resolveWidgetVacuum({}, []), { reason: 'none' });
  assert.deepEqual(resolveWidgetVacuum({ vacuum: 'vacuum:gone' }, [['vacuum:eb111', {}]]), {
    reason: 'unknown',
  });
});

test('widgets - resolveWidgetVacuum picks the vacuum of the setting, else the first one', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  await robotIn('docked');
  assert.equal(resolveWidgetVacuum({}, listConnections()).externalId, EXTERNAL_ID);
  assert.equal(
    resolveWidgetVacuum({ vacuum: EXTERNAL_ID }, listConnections()).externalId,
    EXTERNAL_ID,
  );
});

test('widgets - vacuum: battery first, contextual keys following the state', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const keysOf = (content) =>
    content.components.filter((c) => c.type === 'button').map((c) => c.action.key);

  const cleaning = widgetContent(
    WIDGET.VACUUM,
    EXTERNAL_ID,
    (await robotIn('cleaning')).entry,
    {},
    'fr',
  );
  const status = cleaning.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].label, 'Batterie');
  assert.equal(status.items[0].value, '64 %');
  assert.ok(status.items.some((i) => i.label === 'Ce nettoyage' && i.value === '8.5 m² · 12 min'));
  assert.deepEqual(keysOf(cleaning), ['pause', 'dock', 'locate', 'stop']);

  const paused = widgetContent(
    WIDGET.VACUUM,
    EXTERNAL_ID,
    (await robotIn('paused')).entry,
    {},
    'en',
  );
  assert.deepEqual(keysOf(paused), ['resume', 'dock', 'locate', 'stop']);

  const docked = widgetContent(
    WIDGET.VACUUM,
    EXTERNAL_ID,
    (await robotIn('docked')).entry,
    {},
    'en',
  );
  assert.deepEqual(keysOf(docked), ['start', 'dock', 'locate']);

  const error = widgetContent(WIDGET.VACUUM, EXTERNAL_ID, (await robotIn('error')).entry, {}, 'en');
  const fault = error.components
    .find((c) => c.type === 'status')
    .items.find((i) => i.label === 'Fault');
  assert.equal(fault.value, 'Side brush, Left wheel');
  assert.equal(fault.color, 'danger');
});

test('widgets - no button uses the primary style (invisible in dark mode)', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { entry } = await robotIn('cleaning');
  for (const key of Object.values(WIDGET)) {
    const content = widgetContent(key, EXTERNAL_ID, entry, {}, 'en');
    for (const button of content.components.filter((c) => c.type === 'button')) {
      assert.notEqual(button.style, 'primary', `${key}: ${button.label}`);
    }
  }
});

test('widgets - quick_clean: programs then zones by default, names in any language', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { entry } = await robotIn('docked');
  const defaults = quickCleanButtons(entry, {}, 'fr');
  assert.deepEqual(
    defaults.buttons.map((b) => [b.kind, b.value]),
    [
      ['program', 'auto'],
      ['program', 'edge'],
      ['program', 'spot'],
      ['zone', 'kitchen'],
    ],
  );
  const named = quickCleanButtons(
    entry,
    { button_1: 'Kitchen', button_2: 'Bords', button_3: 'Garage' },
    'fr',
  );
  assert.deepEqual(
    named.buttons.map((b) => [b.kind, b.value]),
    [
      ['zone', 'kitchen'],
      ['program', 'edge'],
    ],
  );
  assert.deepEqual(named.unknown, ['Garage']);
  const content = widgetContent(
    WIDGET.QUICK_CLEAN,
    EXTERNAL_ID,
    entry,
    { button_3: 'Garage' },
    'fr',
  );
  assert.deepEqual(validateWidgetContent(content), []);
  assert.match(content.components.find((c) => c.variant === 'caption').text, /Inconnu : Garage/);
});

test('widgets - quick_clean ticks the program under way, by icon', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { entry } = await robotIn('cleaning');
  const content = widgetContent(WIDGET.QUICK_CLEAN, EXTERNAL_ID, entry, {}, 'en');
  const smart = content.components.find(
    (c) => c.type === 'button' && c.action.params.value === 'auto',
  );
  assert.equal(smart.icon, 'check-circle');
});

test('widgets - remote: the arrow keys only when the robot has direction control', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { entry } = await robotIn('docked');
  const keys = widgetContent(WIDGET.REMOTE, EXTERNAL_ID, entry, {}, 'en')
    .components.filter((c) => c.type === 'button')
    .map((c) => c.action.key);
  assert.deepEqual(keys, ['forward', 'turn_left', 'turn_right', 'halt']);

  __clearConnectionsForTesting();
  const spec = { status: ROBOT_SPEC.status.filter((d) => d.code !== 'direction_control') };
  registerRobot({ spec });
  const none = widgetContent(WIDGET.REMOTE, EXTERNAL_ID, getConnection(EXTERNAL_ID), {}, 'en');
  assert.equal(
    none.components.some((c) => c.type === 'button'),
    false,
  );
  assert.deepEqual(validateWidgetContent(none), []);
});

test('widgets - maintenance: most worn first, a confirmed reset for worn parts only', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const { entry } = await robotIn('docked');
  const content = widgetContent(WIDGET.MAINTENANCE, EXTERNAL_ID, entry, {}, 'en');
  assert.deepEqual(
    content.components.filter((c) => c.type === 'gauge').map((c) => [c.label, c.value, c.color]),
    [
      ['Filter', 5, 'danger'],
      ['Side brush', 15, 'warning'],
      ['Roll brush', 60, 'success'],
    ],
  );
  const resets = content.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    resets.map((b) => [b.action.key, b.action.params.part, b.action.confirm]),
    [
      ['reset_1', 'filter', true],
      ['reset_2', 'edge_brush', true],
    ],
  );
});

test('widgetCommand only lets the declared buttons through', () => {
  const vacuum = EXTERNAL_ID;
  assert.deepEqual(widgetCommand('pause', { vacuum }), { kind: 'pause', vacuum });
  assert.deepEqual(widgetCommand('halt', { vacuum }), { kind: 'move', vacuum, value: 'stop' });
  assert.deepEqual(widgetCommand('button_2', { vacuum, kind: 'zone', value: 'kitchen' }), {
    kind: 'zone',
    vacuum,
    value: 'kitchen',
  });
  assert.deepEqual(widgetCommand('reset_1', { vacuum, part: 'filter' }), {
    kind: 'reset',
    vacuum,
    value: 'filter',
  });
  assert.equal(widgetCommand('pause', {}), null);
  assert.equal(widgetCommand('rm_rf', { vacuum }), null);
  assert.equal(widgetCommand('button_1', { vacuum, kind: 'shell', value: 'x' }), null);
  assert.equal(widgetCommand('reset_1', { vacuum, part: 'battery' }), null);
});

test('runWidgetCommand routes each button to the right DP', async (t) => {
  t.after(() => __clearConnectionsForTesting());
  const gladys = createFakeGladys();
  const { localCalls } = await robotIn('paused');
  const run = (key, params = {}) =>
    runWidgetCommand(gladys, widgetCommand(key, { vacuum: EXTERNAL_ID, ...params }), {});
  await run('resume');
  await run('pause');
  await run('stop');
  await run('dock');
  await run('locate');
  await run('turn_left');
  await run('button_1', { kind: 'program', value: 'edge' });
  assert.equal(await run('button_2', { kind: 'zone', value: 'kitchen' }), 'Kitchen');
  await run('reset_1', { part: 'filter' });
  assert.deepEqual(localCalls, [
    { dpId: 2, value: false }, // resume a paused clean: pause off
    { dpId: 2, value: true },
    { dpId: 1, value: false },
    { dpId: 3, value: true },
    { dpId: 11, value: true },
    { dpId: 12, value: 'turn_left' },
    { dpId: 4, value: 'wall_follow' },
    { dpId: 15, value: KITCHEN.command },
    { dpId: 22, value: true },
  ]);
});

test('widgetToast answers in both languages', () => {
  assert.deepEqual(widgetToast({ kind: 'dock' }), {
    en: 'Going back to the dock…',
    fr: 'Retour à la base…',
  });
  assert.match(widgetToast({ kind: 'zone', value: 'kitchen' }, { label: 'Kitchen' }).fr, /Kitchen/);
});
