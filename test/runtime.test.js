// -----------------------------------------------------------------------------
// Keep the Node runtime the Docker image ships with and the one CI tests on
// in lockstep, on an LTS line.
//
// CI (.github/workflows/ci.yml) and the release workflow read the Node
// version from `.nvmrc`; the Dockerfile names its own `FROM node:<major>-alpine`
// tags. Nothing tied the two together, and a Dependabot bump moved the image
// to an odd-numbered major (Node 25: never LTS, end-of-life eight months
// after release) while CI kept testing on 22. This fails such a PR instead:
// bump `.nvmrc` in the same PR as the Dockerfile, to an even (LTS) major.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

const nvmrcMajor = Number((await read('.nvmrc')).trim().split('.')[0]);
const dockerfileMajors = [...(await read('Dockerfile')).matchAll(/^FROM node:(\d+)-alpine/gm)].map(
  ([, major]) => Number(major),
);

test('.nvmrc pins an even-numbered (LTS) Node major', () => {
  assert.ok(Number.isInteger(nvmrcMajor), '.nvmrc must start with a Node major version');
  assert.equal(nvmrcMajor % 2, 0, `Node ${nvmrcMajor} is an odd, never-LTS release line`);
});

test('every Dockerfile stage runs the same Node major as .nvmrc (what CI tests on)', () => {
  assert.ok(dockerfileMajors.length > 0, 'no `FROM node:<major>-alpine` line found');
  for (const major of dockerfileMajors) {
    assert.equal(major, nvmrcMajor, `Dockerfile uses node:${major}, .nvmrc says ${nvmrcMajor}`);
  }
});
