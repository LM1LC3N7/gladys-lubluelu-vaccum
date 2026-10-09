// -----------------------------------------------------------------------------
// Cleaning zones: named room/zone selections a vacuum can be sent to clean.
//
// Two sources, merged per vacuum (a learned zone wins over a typed one of the
// same name):
//   - typed in the `rooms` config field, by room id: "Kitchen=2, Living=0+1"
//     (`x2` after the ids for two passes). Room ids are the robot's own, as
//     the Smart Life app numbers them — the integration logs the ids each
//     time a room clean is started from the app, so they never have to be
//     guessed;
//   - LEARNED: start a room or zone clean from the Smart Life app, then run
//     the "Memorize the last zone" action with a name. The robot reported the
//     selection back on its `command_trans` DP (see src/tuya/sweeper.js); the
//     integration replays that exact frame. Works for rectangle zones drawn
//     in the app too, which have no id to type.
//
// Learned zones are stored outside the config_schema (free internal storage,
// never shown in the form), under LEARNED_ZONES_CONFIG_KEY, as JSON:
// `{ [tuyaDeviceId]: { [name]: base64Command } }`.
// -----------------------------------------------------------------------------

import { encodeRoomClean, isCleanCommand } from './tuya/sweeper.js';

export const LEARNED_ZONES_CONFIG_KEY = 'learned_zones';

const MAX_NAME_LENGTH = 40;

/**
 * A stable feature/action key for a zone name: lowercase ASCII, accents
 * dropped, anything else an underscore. "Salle à manger" -> "salle_a_manger".
 */
export function zoneSlug(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** Trimmed, bounded display name, or '' when unusable. */
export function zoneName(name) {
  const value = String(name ?? '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return zoneSlug(value) ? value : '';
}

/**
 * Parse the `rooms` config field: comma- or semicolon-separated
 * `name=id+id[x passes]` entries. Malformed entries are skipped and reported.
 * @returns {{ zones: Array<{ name: string, slug: string, command: string, roomIds: number[] }>,
 *   errors: string[] }}
 */
export function parseRoomsConfig(raw) {
  const zones = [];
  const errors = [];
  for (const part of String(raw ?? '').split(/[;,]/)) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    const match = /^(.+?)\s*=\s*([0-9+\s]+?)(?:\s*x\s*([1-3]))?$/i.exec(entry);
    const name = zoneName(match?.[1]);
    const roomIds = (match?.[2] ?? '')
      .split('+')
      .map((id) => id.trim())
      .filter(Boolean)
      .map(Number);
    if (!name || roomIds.length === 0 || roomIds.some((id) => !Number.isInteger(id) || id > 255)) {
      errors.push(entry);
      continue;
    }
    zones.push({
      name,
      slug: zoneSlug(name),
      command: encodeRoomClean(roomIds, Number(match[3] ?? 1)),
      roomIds,
    });
  }
  return { zones, errors };
}

/** Parse the stored learned zones, dropping anything that isn't a valid command. */
export function parseLearnedZones(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const learned = {};
  for (const [deviceId, zones] of Object.entries(parsed ?? {})) {
    if (!zones || typeof zones !== 'object') {
      continue;
    }
    for (const [name, command] of Object.entries(zones)) {
      if (zoneName(name) && isCleanCommand(command)) {
        learned[deviceId] ??= {};
        learned[deviceId][zoneName(name)] = command;
      }
    }
  }
  return learned;
}

/**
 * Every zone of one vacuum, typed and learned, sorted by name.
 * @param {{ roomZones?: Array<object>, learnedZones?: object }} config normalized config
 * @returns {Array<{ name: string, slug: string, command: string, learned: boolean }>}
 */
export function zonesFor(config, deviceId) {
  const bySlug = new Map();
  for (const zone of config.roomZones ?? []) {
    bySlug.set(zone.slug, {
      name: zone.name,
      slug: zone.slug,
      command: zone.command,
      learned: false,
    });
  }
  for (const [name, command] of Object.entries(config.learnedZones?.[deviceId] ?? {})) {
    const slug = zoneSlug(name);
    bySlug.set(slug, { name, slug, command, learned: true });
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a zone by name or slug, ignoring case and accents. */
export function findZone(zones, nameOrSlug) {
  const slug = zoneSlug(nameOrSlug);
  return slug ? zones.find((zone) => zone.slug === slug) : undefined;
}

/**
 * Find a zone typed by hand (a scene field): the exact name first, else the
 * one zone whose name starts with it ("chamb" -> "Chambres"), ignoring case
 * and accents. Several matches is not a guess: the candidates come back.
 * @returns {{ zone?: object, candidates: Array<object> }}
 */
export function resolveZone(zones, query) {
  const exact = findZone(zones, query);
  if (exact) {
    return { zone: exact, candidates: [exact] };
  }
  const slug = zoneSlug(query);
  const candidates = slug ? zones.filter((zone) => zone.slug.startsWith(slug)) : [];
  return candidates.length === 1 ? { zone: candidates[0], candidates } : { candidates };
}

/** The learned-zones map with `name` set (or removed when `command` is null). */
export function withLearnedZone(learnedZones, deviceId, name, command) {
  const next = structuredClone(learnedZones ?? {});
  const slug = zoneSlug(name);
  const zones = next[deviceId] ?? {};
  for (const existing of Object.keys(zones)) {
    if (zoneSlug(existing) === slug) {
      delete zones[existing];
    }
  }
  if (command) {
    zones[zoneName(name)] = command;
  }
  if (Object.keys(zones).length > 0) {
    next[deviceId] = zones;
  } else {
    delete next[deviceId];
  }
  return next;
}
