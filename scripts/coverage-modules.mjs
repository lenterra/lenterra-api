#!/usr/bin/env node
// Coverage for the Nakama runtime handlers.
//
// **Why this is separate from `coverage-gate.mjs`, and why the distinction
// matters more than the numbers.** That gate measures `packages/core` and
// nothing else. Its result — 95.19% branch — was quoted in a status report as
// though it described the project, and it does not: it says nothing at all
// about `modules/src/rpc/`, which is where every authorisation decision in the
// system lives. A coverage figure that is believed to cover more than it does
// is worse than no figure, because it retires the question.
//
// So this file reports the handlers honestly, and its most useful output is not
// a percentage. It is the list of modules with *no* coverage, printed every
// run. An average over twelve files hides the four that have never been
// executed; a list of names cannot.
//
// The floors are per-file rather than global, for the same reason. A global
// number can be held up by a well-tested file while the file that decides who
// may read a school's children drifts to nothing.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files with contract tests, and the floors they must hold.
 *
 * Set just under where the suite sits, so an ordinary change does not fail the
 * build for rounding while a real regression does. Adding a file here is how a
 * handler graduates from "untested" to "guarded" — the list is the commitment,
 * not the percentage.
 */
const GUARDED = {
  'rpc/staff.ts': { line: 95, branch: 88 },
  'db/queries.ts': { line: 95, branch: 95 },
};

const result = spawnSync(
  process.execPath,
  [
    '--import',
    './test/ts-resolve.mjs',
    '--experimental-test-coverage',
    '--test',
    'test/staff.test.mts',
    'test/reward.test.mts',
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status !== 0) {
  console.error('contract tests failed; coverage is not meaningful until they pass');
  console.error(output.slice(-4000));
  process.exit(1);
}

/**
 * Parse the runner's table.
 *
 * Rows look like:
 *   ℹ    staff.ts           |  99.27 |    92.00 |  100.00 | 263-264
 * The leading path is truncated by the reporter, so rows are matched on the
 * basename and disambiguated against the files actually on disk.
 */
const covered = new Map();
for (const line of output.split('\n')) {
  const row = line.match(/^ℹ\s+(\S+\.ts)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
  if (row) covered.set(row[1], { line: Number(row[2]), branch: Number(row[3]) });
}

let failed = 0;

console.log('\nhandler coverage (contract tests only)\n');

for (const [file, floor] of Object.entries(GUARDED)) {
  const basename = file.split('/').pop();
  const actual = covered.get(basename);

  if (!actual) {
    console.log(`  ✗ ${file} — no coverage reported; is it still imported by a test?`);
    failed++;
    continue;
  }

  const ok = actual.line >= floor.line && actual.branch >= floor.branch;
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${file.padEnd(20)} line ${actual.line.toFixed(1)}%  ` +
      `branch ${actual.branch.toFixed(1)}%   (floor ${floor.line}/${floor.branch})`,
  );
}

/**
 * The part worth reading: what nothing here fully executes.
 *
 * Three categories, kept separate because they are three different situations
 * and an average over them would describe none of them.
 *
 * A file that is *partially* covered is the one that most needs saying out
 * loud. `social.ts` reports around 50% line coverage, and that is not half a
 * safety net — it is the reward handlers tested and the rest of the file
 * incidentally loaded. Giving it a floor would turn an accident into a claim.
 */
const handlers = readdirSync(join(root, 'modules', 'src', 'rpc')).filter((f) => f.endsWith('.ts'));
const guardedNames = new Set(Object.keys(GUARDED).map((f) => f.split('/').pop()));

const partial = handlers.filter((f) => covered.has(f) && !guardedNames.has(f));
const untested = handlers.filter((f) => !covered.has(f));

if (partial.length > 0) {
  console.log(`\n  partially covered, deliberately without a floor:`);
  for (const file of partial) {
    const actual = covered.get(file);
    console.log(
      `    ${file.padEnd(18)} line ${actual.line.toFixed(1)}%  branch ${actual.branch.toFixed(1)}%` +
        `  — only the handlers a test names`,
    );
  }
}

if (untested.length > 0) {
  console.log(
    `\n  ${untested.length} of ${handlers.length} handler modules have no contract test:`,
  );
  console.log(`    ${untested.join(', ')}`);
  console.log(
    '\n  Not a failure — these are exercised by test/integration/ against a real\n' +
      '  Nakama, which publishes no arm64 image. But nothing on this machine runs\n' +
      '  them, so no number printed above describes them. The list should shrink.',
  );
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
