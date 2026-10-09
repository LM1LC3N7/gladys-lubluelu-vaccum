import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findZone,
  parseLearnedZones,
  parseRoomsConfig,
  withLearnedZone,
  zoneSlug,
  zonesFor,
} from '../src/zones.js';
import { encodeRoomClean } from '../src/tuya/sweeper.js';
import { normalizeConfig } from '../src/config.js';

test('zoneSlug is stable, ASCII, accent- and case-insensitive', () => {
  assert.equal(zoneSlug('Salle à manger'), 'salle_a_manger');
  assert.equal(zoneSlug('  CUISINE  '), 'cuisine');
  assert.equal(zoneSlug('!!!'), '');
});

test('parseRoomsConfig reads name=ids entries, + for several rooms, x2 for two passes', () => {
  const { zones, errors } = parseRoomsConfig(
    'Cuisine=2, Salon=0+1; Chambres=3+4x2, broken, =1, Bad=999',
  );
  assert.deepEqual(
    zones.map((z) => [z.name, z.roomIds]),
    [
      ['Cuisine', [2]],
      ['Salon', [0, 1]],
      ['Chambres', [3, 4]],
    ],
  );
  assert.equal(zones[2].command, encodeRoomClean([3, 4], 2));
  assert.deepEqual(errors, ['broken', '=1', 'Bad=999']);
});

test('parseLearnedZones keeps only valid clean commands', () => {
  const learned = parseLearnedZones(
    JSON.stringify({ eb111: { Kitchen: encodeRoomClean([2]), Junk: 'qgAEFQEBBBs=' }, eb2: 'x' }),
  );
  assert.deepEqual(learned, { eb111: { Kitchen: encodeRoomClean([2]) } });
  assert.deepEqual(parseLearnedZones('{not json'), {});
});

test('zonesFor merges typed and learned zones, a learned one winning on the same name', () => {
  const config = normalizeConfig({
    rooms: 'Cuisine=2, Salon=0+1',
    learned_zones: JSON.stringify({
      eb111: { cuisine: encodeRoomClean([7]), Entrée: encodeRoomClean([5]) },
    }),
  });
  const zones = zonesFor(config, 'eb111');
  assert.deepEqual(
    zones.map((z) => [z.name, z.learned]),
    [
      ['cuisine', true],
      ['Entrée', true],
      ['Salon', false],
    ],
  );
  assert.equal(findZone(zones, 'CUISINE').command, encodeRoomClean([7]));
  assert.equal(findZone(zones, 'entree').name, 'Entrée');
  assert.equal(zonesFor(config, 'other').length, 2, 'typed rooms apply to every vacuum');
});

test('withLearnedZone sets, renames by slug and removes, without mutating its input', () => {
  const start = { eb111: { Kitchen: encodeRoomClean([2]) } };
  const added = withLearnedZone(start, 'eb111', 'KITCHEN', encodeRoomClean([3]));
  assert.deepEqual(added, { eb111: { KITCHEN: encodeRoomClean([3]) } });
  assert.deepEqual(start, { eb111: { Kitchen: encodeRoomClean([2]) } });
  assert.deepEqual(withLearnedZone(added, 'eb111', 'kitchen', null), {});
});
