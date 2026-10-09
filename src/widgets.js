// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+), content builders — pure functions.
//
//   - vacuum      : the robot at a glance — battery first, state, program,
//                   suction, water, the session under way (area, time), a
//                   fault, the link (local or cloud) — and the everyday keys
//                   of its remote: start / pause / resume, return to dock,
//                   locate, stop;
//   - quick_clean : up to four one-tap cleanings for a wall tablet, each a
//                   program (smart, edges, spot, mop) or a zone (typed or
//                   learned, see src/zones.js), named in the widget settings;
//   - remote      : manual driving, the arrow keys of the robot's remote
//                   (forward, turn left, turn right, stop) — only on a robot
//                   with a `direction_control` DP;
//   - maintenance : the remaining life of each part as gauges, the most worn
//                   first, and a reset key for a worn part once replaced.
//
// What they deliberately do NOT redo: the core's "Devices" box already shows
// the state badge, a dock button and every setting as a select — settings
// stay there (lists and sliders are kept out of widgets by the core, on
// purpose). These widgets add what a device box can't: the whole robot in
// one card, keys that follow its state, programs and zones in one tap.
//
// A widget shows the vacuum picked in its settings (`vacuum`, a
// `source: "devices"` select whose value is the device external_id), else
// the first one connected. Buttons are widget actions carrying the vacuum
// external_id in their params; onWidgetAction only accepts the commands
// listed in widgetCommand(). Gladys renders at most 8 components (2 texts,
// 4 buttons, 6 tiles, 1 status) and drops a button whose action key another
// one already uses. A current choice is shown by its icon (`check-circle`),
// never by the `primary` style: in dark mode Gladys paints a primary button
// like the others (GladysAssistant/Gladys#3153).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import {
  CISTERN_LABELS,
  FEATURE_NAMES,
  MODE_LABELS,
  STATE_LABELS,
  SUCTION_LABELS,
  pick,
} from './i18n.js';
import { CONSUMABLES, VACUUM_STATE, faultLabels, scaled } from './tuya/dpsSchema.js';
import { availableMoves, availablePrograms, currentProgram, stateOf } from './cleaning.js';
import { findZone, zoneSlug } from './zones.js';

/** Widget keys, declared in the manifest `widgets` (forever: never rename). */
export const WIDGET = {
  VACUUM: 'vacuum',
  QUICK_CLEAN: 'quick_clean',
  REMOTE: 'remote',
  MAINTENANCE: 'maintenance',
};

/** The widget settings naming the buttons of the quick_clean widget. */
export const BUTTON_SETTINGS = ['button_1', 'button_2', 'button_3', 'button_4'];

/** Freshness of each content, in seconds (10–3600 for the core). */
export const WIDGET_TTL_SECONDS = {
  [WIDGET.VACUUM]: 30,
  [WIDGET.QUICK_CLEAN]: 60,
  [WIDGET.REMOTE]: 30,
  [WIDGET.MAINTENANCE]: 600,
  empty: 300,
};

const MAX_BUTTONS = 4;
const CURRENT_ICON = 'check-circle';
const WORN_PERCENT = 20;
const CRITICAL_PERCENT = 10;
const LOW_BATTERY_PERCENT = 20;

const TEXTS = {
  noVacuum: {
    en: 'No vacuum is connected yet. Connect your Smart Life account in the integration configuration, add the vacuum from the Discovery tab, then pick it here.',
    fr: "Aucun aspirateur n'est connecté. Connectez votre compte Smart Life dans la configuration de l'intégration, ajoutez l'aspirateur depuis l'onglet Découverte, puis choisissez-le ici.",
  },
  unknownVacuum: {
    en: 'The vacuum picked in the settings of this widget is no longer connected. Pick another one, or leave the field empty.',
    fr: "L'aspirateur choisi dans les réglages de ce widget n'est plus connecté. Choisissez-en un autre, ou laissez le champ vide.",
  },
  noRemote: {
    en: 'This vacuum offers no manual driving (no direction control).',
    fr: 'Cet aspirateur ne propose pas de pilotage manuel (pas de commande de direction).',
  },
  remoteHint: {
    en: 'Manual driving: keep the robot in sight.',
    fr: 'Pilotage manuel : gardez le robot en vue.',
  },
  allGood: { en: 'Every part is in good shape.', fr: 'Toutes les pièces sont en bon état.' },
  noParts: {
    en: 'This vacuum reports no part wear.',
    fr: "Cet aspirateur ne signale pas l'usure de ses pièces.",
  },
  nothingToClean: {
    en: 'No program nor zone to offer on this vacuum.',
    fr: 'Aucun programme ni zone à proposer sur cet aspirateur.',
  },
  unknownButtons: {
    en: (unknown, known) => `Unknown: ${unknown}. Known: ${known}`,
    fr: (unknown, known) => `Inconnu : ${unknown}. Connus : ${known}`,
  },
  battery: { en: 'Battery', fr: 'Batterie' },
  state: { en: 'State', fr: 'État' },
  program: { en: 'Program', fr: 'Programme' },
  suction: { en: 'Suction', fr: 'Aspiration' },
  water: { en: 'Water', fr: 'Eau' },
  session: { en: 'This cleaning', fr: 'Ce nettoyage' },
  fault: { en: 'Fault', fr: 'Défaut' },
  link: { en: 'Link', fr: 'Liaison' },
  local: { en: 'Local', fr: 'Locale' },
  cloud: { en: 'Cloud', fr: 'Cloud' },
  start: { en: 'Start', fr: 'Démarrer' },
  resume: { en: 'Resume', fr: 'Reprendre' },
  pause: { en: 'Pause', fr: 'Pause' },
  stop: { en: 'Stop', fr: 'Arrêter' },
  dock: { en: 'Back to dock', fr: 'Retour base' },
  locate: { en: 'Locate', fr: 'Localiser' },
  forward: { en: 'Forward', fr: 'Avancer' },
  turnLeft: { en: 'Left', fr: 'Gauche' },
  turnRight: { en: 'Right', fr: 'Droite' },
  halt: { en: 'Stop', fr: 'Stop' },
  reset: { en: (part) => `Reset ${part}`, fr: (part) => `Réinit. ${part}` },
  programs: {
    auto: { en: 'Smart', fr: 'Intelligent' },
    edge: { en: 'Edges', fr: 'Bords' },
    spot: { en: 'Spot', fr: 'Ciblé' },
    mop: { en: 'Mop', fr: 'Serpillière' },
  },
  toast: {
    start: { en: 'Cleaning started.', fr: 'Nettoyage lancé.' },
    resume: { en: 'Cleaning resumed.', fr: 'Nettoyage repris.' },
    pause: { en: 'Cleaning paused.', fr: 'Nettoyage en pause.' },
    stop: { en: 'Cleaning stopped.', fr: 'Nettoyage arrêté.' },
    dock: { en: 'Going back to the dock…', fr: 'Retour à la base…' },
    locate: { en: 'The robot is beeping.', fr: 'Le robot sonne.' },
    move: { en: 'Move sent.', fr: 'Mouvement envoyé.' },
    program: {
      en: (name) => `${name}: cleaning started.`,
      fr: (name) => `${name} : nettoyage lancé.`,
    },
    zone: { en: (name) => `Cleaning ${name}…`, fr: (name) => `Nettoyage : ${name}…` },
    reset: { en: (name) => `${name}: wear reset.`, fr: (name) => `${name} : usure réinitialisée.` },
  },
};

// Words a quick_clean button setting may use for each program (case and
// accents do not matter), in both languages.
const PROGRAM_WORDS = {
  auto: ['auto', 'smart', 'intelligent'],
  edge: ['edge', 'edges', 'bords', 'bord', 'murs', 'wall'],
  spot: ['spot', 'cible', 'zone_ciblee'],
  mop: ['mop', 'serpilliere', 'lavage'],
};

const STATE_COLORS = {
  [VACUUM_STATE.STOPPED]: WIDGET_COLORS.NEUTRAL,
  [VACUUM_STATE.RUNNING]: WIDGET_COLORS.INFO,
  [VACUUM_STATE.PAUSED]: WIDGET_COLORS.WARNING,
  [VACUUM_STATE.ERROR]: WIDGET_COLORS.DANGER,
  [VACUUM_STATE.RETURNING_TO_DOCK]: WIDGET_COLORS.INFO,
  [VACUUM_STATE.CHARGING]: WIDGET_COLORS.SUCCESS,
  [VACUUM_STATE.DOCKED]: WIDGET_COLORS.SUCCESS,
};

/** The language of a widget: Gladys sends the user's, the texts exist in two. */
export function widgetLanguage(language) {
  return language === 'fr' ? 'fr' : 'en';
}

/** A text cut to a bound (the core would cut it, and say so in its logs). */
export function fit(text, max) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function t(pair, lang) {
  return pick(pair, lang);
}

/**
 * Resolve the vacuum a widget shows: the device picked in its `vacuum`
 * setting, else the first one connected.
 * @param {object} settings the widget settings ({ vacuum })
 * @param {Array<[string, object]>} connections src/devices/vacuum.js#listConnections()
 * @returns {{ externalId?: string, entry?: object, reason: null|'none'|'unknown' }}
 */
export function resolveWidgetVacuum(settings, connections) {
  const picked = typeof settings?.vacuum === 'string' ? settings.vacuum.trim() : '';
  if (picked) {
    const found = connections.find(([externalId]) => externalId === picked);
    return found ? { externalId: found[0], entry: found[1], reason: null } : { reason: 'unknown' };
  }
  return connections.length > 0
    ? { externalId: connections[0][0], entry: connections[0][1], reason: null }
    : { reason: 'none' };
}

/** A widget with nothing to show but a sentence — never an error. */
export function emptyContent(reason) {
  return {
    version: 1,
    ttl_seconds: WIDGET_TTL_SECONDS.empty,
    components: [
      {
        type: 'text',
        variant: 'body',
        text: reason === 'unknown' ? TEXTS.unknownVacuum : TEXTS.noVacuum,
      },
    ],
  };
}

function heading(name) {
  return { type: 'text', variant: 'heading', text: fit(name, 40) };
}

function actionButton(label, key, params, icon, confirm = false) {
  return {
    type: 'button',
    label,
    icon,
    action: { key, params, ...(confirm ? { confirm: true } : {}) },
  };
}

function numberOf(entry, code) {
  const dp = entry.dpsByCode?.get(code);
  const raw = entry.values?.get(code);
  return dp && raw !== undefined && raw !== null ? scaled(raw, dp.values) : undefined;
}

function batteryOf(entry) {
  return numberOf(entry, 'electricity_left') ?? numberOf(entry, 'battery_percentage');
}

function enumLabel(table, raw, lang) {
  return fit(pick(table[raw] ?? { en: raw, fr: raw }, lang), 40);
}

function suctionRaw(entry) {
  return ['suction', 'power_level', 'speed']
    .map((code) => entry.values?.get(code))
    .find((value) => value !== undefined);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

/** The status rows of the vacuum widget, battery first (the core caps at 10). */
export function vacuumStatusItems(entry, lang) {
  const items = [];
  const battery = batteryOf(entry);
  if (battery !== undefined) {
    items.push({
      label: t(TEXTS.battery, lang),
      value: `${Math.round(battery)} %`,
      icon: 'battery',
      color: battery < LOW_BATTERY_PERCENT ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
    });
  }
  const state = stateOf(entry);
  if (state !== undefined) {
    items.push({
      label: t(TEXTS.state, lang),
      value: t(STATE_LABELS[state], lang),
      color: STATE_COLORS[state],
    });
  }
  const mode = entry.values?.get('mode');
  if (mode !== undefined) {
    items.push({ label: t(TEXTS.program, lang), value: enumLabel(MODE_LABELS, mode, lang) });
  }
  const suction = suctionRaw(entry);
  if (suction !== undefined) {
    items.push({ label: t(TEXTS.suction, lang), value: enumLabel(SUCTION_LABELS, suction, lang) });
  }
  const water = entry.values?.get('cistern');
  if (water !== undefined) {
    items.push({ label: t(TEXTS.water, lang), value: enumLabel(CISTERN_LABELS, water, lang) });
  }
  const area = numberOf(entry, 'clean_area');
  const minutes = numberOf(entry, 'clean_time');
  if (area !== undefined || minutes !== undefined) {
    const parts = [];
    if (area !== undefined) {
      parts.push(`${round(area)} m²`);
    }
    if (minutes !== undefined) {
      parts.push(`${Math.round(minutes)} min`);
    }
    items.push({ label: t(TEXTS.session, lang), value: parts.join(' · ') });
  }
  const fault = Number(entry.values?.get('fault')) || 0;
  if (fault !== 0) {
    const labels = faultLabels(fault, entry.dpsByCode?.get('fault')?.values, lang);
    items.push({
      label: t(TEXTS.fault, lang),
      value: fit(labels.join(', '), 40),
      icon: 'alert-triangle',
      color: WIDGET_COLORS.DANGER,
    });
  }
  const local = entry.local?.isConnected?.() === true;
  items.push({
    label: t(TEXTS.link, lang),
    value: t(local ? TEXTS.local : TEXTS.cloud, lang),
    color: local ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
  });
  return items.slice(0, 10);
}

/** The "vacuum" widget: the robot at a glance and its everyday keys. */
export function vacuumContent(externalId, entry, language) {
  const lang = widgetLanguage(language);
  const params = { vacuum: externalId };
  const state = stateOf(entry);
  const running = state === VACUUM_STATE.RUNNING;
  const paused = state === VACUUM_STATE.PAUSED;
  const buttons = [];
  if (running) {
    buttons.push(actionButton(t(TEXTS.pause, lang), 'pause', params, 'pause'));
  } else if (paused) {
    buttons.push(actionButton(t(TEXTS.resume, lang), 'resume', params, 'play'));
  } else {
    buttons.push(actionButton(t(TEXTS.start, lang), 'start', params, 'play'));
  }
  if (entry.commands?.dock || entry.dockValue !== undefined) {
    buttons.push(actionButton(t(TEXTS.dock, lang), 'dock', params, 'home'));
  }
  if (entry.commands?.seek) {
    buttons.push(actionButton(t(TEXTS.locate, lang), 'locate', params, 'map-pin'));
  }
  if ((running || paused) && entry.commands?.start) {
    buttons.push(actionButton(t(TEXTS.stop, lang), 'stop', params, 'square'));
  }
  return {
    version: 1,
    ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.VACUUM],
    components: [
      heading(entry.name || externalId),
      { type: 'status', items: vacuumStatusItems(entry, lang) },
      ...buttons.slice(0, MAX_BUTTONS),
    ],
  };
}

function wordKey(word) {
  return zoneSlug(word);
}

/** The program a quick_clean setting names, if any. */
export function programOfWord(word) {
  const key = wordKey(word);
  return Object.keys(PROGRAM_WORDS).find((program) => PROGRAM_WORDS[program].includes(key));
}

/**
 * The buttons of the quick_clean widget: the names typed in its settings,
 * each a program or a zone; without any name, the robot's programs then its
 * zones, four at most.
 * @returns {{ buttons: Array<{ kind: 'program'|'zone', value: string, label: string }>,
 *   unknown: string[], known: string[] }}
 */
export function quickCleanButtons(entry, settings, lang) {
  const programs = availablePrograms(entry);
  const zones = entry.zones ?? [];
  const programButton = (program) => ({
    kind: 'program',
    value: program,
    label: t(TEXTS.programs[program], lang),
  });
  const zoneButton = (zone) => ({ kind: 'zone', value: zone.slug, label: zone.name });
  const known = [...programs.map((p) => t(TEXTS.programs[p], lang)), ...zones.map((z) => z.name)];

  const names = BUTTON_SETTINGS.map((key) => settings?.[key])
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
  if (names.length === 0) {
    const buttons = [...programs.map(programButton), ...zones.map(zoneButton)];
    return { buttons: buttons.slice(0, MAX_BUTTONS), unknown: [], known };
  }
  const buttons = [];
  const unknown = [];
  for (const name of names) {
    const program = programOfWord(name);
    const zone = findZone(zones, name);
    if (zone) {
      buttons.push(zoneButton(zone));
    } else if (program && programs.includes(program)) {
      buttons.push(programButton(program));
    } else {
      unknown.push(name);
    }
  }
  return { buttons: buttons.slice(0, MAX_BUTTONS), unknown, known };
}

/** The "quick_clean" widget: four one-tap cleanings. */
export function quickCleanContent(externalId, entry, settings, language) {
  const lang = widgetLanguage(language);
  const components = [heading(entry.name || externalId)];
  const { buttons, unknown, known } = quickCleanButtons(entry, settings, lang);
  if (unknown.length > 0 && known.length > 0) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: fit(TEXTS.unknownButtons[lang](unknown.join(', '), known.join(', ')), 80),
    });
  } else if (buttons.length === 0) {
    components.push({ type: 'text', variant: 'body', text: TEXTS.nothingToClean });
  }
  const state = stateOf(entry);
  if (state !== undefined) {
    components.push({
      type: 'status',
      items: [
        {
          label: t(TEXTS.state, lang),
          value: t(STATE_LABELS[state], lang),
          color: STATE_COLORS[state],
        },
      ],
    });
  }
  const running = state === VACUUM_STATE.RUNNING;
  const program = running ? currentProgram(entry) : undefined;
  buttons.forEach((button, index) => {
    const current = button.kind === 'program' && button.value === program;
    components.push(
      actionButton(
        fit(button.label, 24),
        BUTTON_SETTINGS[index],
        { vacuum: externalId, kind: button.kind, value: button.value },
        current ? CURRENT_ICON : button.kind === 'zone' ? 'map' : 'play-circle',
      ),
    );
  });
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.QUICK_CLEAN], components };
}

const MOVE_BUTTONS = [
  { move: 'forward', key: 'forward', label: TEXTS.forward, icon: 'arrow-up' },
  { move: 'turn_left', key: 'turn_left', label: TEXTS.turnLeft, icon: 'rotate-ccw' },
  { move: 'turn_right', key: 'turn_right', label: TEXTS.turnRight, icon: 'rotate-cw' },
  { move: 'stop', key: 'halt', label: TEXTS.halt, icon: 'square' },
];

/** The "remote" widget: the arrow keys of the robot's remote. */
export function remoteContent(externalId, entry, language) {
  const lang = widgetLanguage(language);
  const components = [heading(entry.name || externalId)];
  const moves = availableMoves(entry);
  if (moves.length === 0) {
    components.push({ type: 'text', variant: 'body', text: TEXTS.noRemote });
    return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS.empty, components };
  }
  components.push({ type: 'text', variant: 'caption', text: TEXTS.remoteHint });
  const items = [];
  const state = stateOf(entry);
  if (state !== undefined) {
    items.push({
      label: t(TEXTS.state, lang),
      value: t(STATE_LABELS[state], lang),
      color: STATE_COLORS[state],
    });
  }
  const battery = batteryOf(entry);
  if (battery !== undefined) {
    items.push({ label: t(TEXTS.battery, lang), value: `${Math.round(battery)} %` });
  }
  if (items.length > 0) {
    components.push({ type: 'status', items });
  }
  for (const button of MOVE_BUTTONS) {
    if (moves.includes(button.move)) {
      components.push(
        actionButton(t(button.label, lang), button.key, { vacuum: externalId }, button.icon),
      );
    }
  }
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.REMOTE], components };
}

/** The parts this robot reports wear for, the most worn first. */
export function wornParts(entry, lang) {
  return CONSUMABLES.filter(
    ({ key }) => entry.values?.get(key) !== undefined && entry.featureKeyToDp?.get(key),
  )
    .map(({ key, reset }) => ({
      key,
      reset: entry.dpsByCode?.has(reset) ? reset : undefined,
      name: pick(FEATURE_NAMES[key], lang),
      percent: Math.max(0, Math.min(100, Number(entry.values.get(key)) || 0)),
    }))
    .sort((a, b) => a.percent - b.percent);
}

function wearColor(percent) {
  if (percent < CRITICAL_PERCENT) {
    return WIDGET_COLORS.DANGER;
  }
  return percent < WORN_PERCENT ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS;
}

/** The "maintenance" widget: wear gauges and resets for worn parts. */
export function maintenanceContent(externalId, entry, language) {
  const lang = widgetLanguage(language);
  const components = [heading(entry.name || externalId)];
  const parts = wornParts(entry, lang);
  if (parts.length === 0) {
    components.push({ type: 'text', variant: 'body', text: TEXTS.noParts });
    return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS.empty, components };
  }
  for (const part of parts.slice(0, 6)) {
    components.push({
      type: 'gauge',
      value: part.percent,
      min: 0,
      max: 100,
      unit: '%',
      label: fit(part.name, 24),
      color: wearColor(part.percent),
    });
  }
  const resets = parts.filter((part) => part.reset && part.percent < WORN_PERCENT);
  if (resets.length === 0) {
    components.push({ type: 'text', variant: 'caption', text: TEXTS.allGood });
  }
  resets.slice(0, MAX_BUTTONS).forEach((part, index) => {
    components.push(
      actionButton(
        fit(TEXTS.reset[lang](part.name.toLowerCase()), 24),
        `reset_${index + 1}`,
        { vacuum: externalId, part: part.key },
        'refresh-cw',
        true,
      ),
    );
  });
  return { version: 1, ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.MAINTENANCE], components };
}

/** The content of a widget, from what the integration knows of the vacuum. */
export function widgetContent(key, externalId, entry, settings = {}, language = 'en') {
  if (key === WIDGET.VACUUM) {
    return vacuumContent(externalId, entry, language);
  }
  if (key === WIDGET.QUICK_CLEAN) {
    return quickCleanContent(externalId, entry, settings, language);
  }
  if (key === WIDGET.REMOTE) {
    return remoteContent(externalId, entry, language);
  }
  if (key === WIDGET.MAINTENANCE) {
    return maintenanceContent(externalId, entry, language);
  }
  throw new Error(`Unknown widget: ${key}`);
}

const SIMPLE_ACTIONS = ['start', 'resume', 'pause', 'stop', 'dock', 'locate'];
const MOVE_OF_KEY = Object.fromEntries(MOVE_BUTTONS.map(({ key, move }) => [key, move]));
const RESET_KEYS = ['reset_1', 'reset_2', 'reset_3', 'reset_4'];

/**
 * What a widget button stands for — and only what a widget button may do.
 * The params come back exactly as the content declared them (never user
 * input), but the handler still trusts nothing.
 * @returns {{ kind: string, vacuum: string, value?: string } | null}
 */
export function widgetCommand(actionKey, params = {}) {
  const vacuum = typeof params?.vacuum === 'string' ? params.vacuum.trim() : '';
  if (!vacuum) {
    return null;
  }
  if (SIMPLE_ACTIONS.includes(actionKey)) {
    return { kind: actionKey, vacuum };
  }
  if (MOVE_OF_KEY[actionKey]) {
    return { kind: 'move', vacuum, value: MOVE_OF_KEY[actionKey] };
  }
  if (BUTTON_SETTINGS.includes(actionKey) && ['program', 'zone'].includes(params.kind)) {
    const value = typeof params.value === 'string' ? params.value.trim() : '';
    return value ? { kind: params.kind, vacuum, value } : null;
  }
  if (RESET_KEYS.includes(actionKey) && CONSUMABLES.some(({ key }) => key === params.part)) {
    return { kind: 'reset', vacuum, value: params.part };
  }
  return null;
}

/** The toast shown once a widget button did its job (both languages, ≤ 200 characters). */
export function widgetToast(command, { label = '' } = {}) {
  const name = fit(label || command.value || '', 40);
  if (command.kind === 'program') {
    return { en: TEXTS.toast.program.en(name), fr: TEXTS.toast.program.fr(name) };
  }
  if (command.kind === 'zone') {
    return { en: TEXTS.toast.zone.en(name), fr: TEXTS.toast.zone.fr(name) };
  }
  if (command.kind === 'reset') {
    return { en: TEXTS.toast.reset.en(name), fr: TEXTS.toast.reset.fr(name) };
  }
  if (command.kind === 'move') {
    return TEXTS.toast.move;
  }
  return TEXTS.toast[command.kind];
}

export { TEXTS as WIDGET_TEXTS };
