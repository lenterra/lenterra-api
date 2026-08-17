#!/usr/bin/env node
// Branch-coverage gate for the shared core (TRD-TEST-001).
//
// The core is the one package where a bug is wrong twice: once on the phone and
// once in the validator, in the same way, so the two agree on an incorrect
// answer and nothing looks broken. Everywhere else a mistake surfaces as a
// mismatch; here it surfaces as a student being told they lost a mission they
// won, with the server agreeing.
//
// TRD-TEST-001 sets the target at 95% of branches, and it is met. The floors
// below sit just under where the suite actually is, so an ordinary change does
// not fail the build for rounding while a real regression does. Lowering one
// should not happen without a note saying why.
//
// A caveat that used to belong here no longer does, and the reason is worth
// keeping: coverage is measured against compiled output, and `export *`
// compiles to `__createBinding`/`__exportStar` helpers that cannot execute
// under a CJS consumer — so they counted permanently as uncovered branches.
// The package now names every export instead, which removed them. If that
// changes back, roughly two points of this number are illusory again.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core');

/**
 * Current floors, set a little under where the suite sits.
 *
 * Branch was the number that lagged, and the reason is worth knowing before
 * anybody tries to raise it by deleting tests: the search and verification code
 * has a high branch density — budget checks, depth limits, early exits — and
 * covering its *lines* is much easier than covering both sides of every
 * condition in it. Adding the solver tests once raised line coverage by six
 * points and *lowered* the branch percentage, because they brought a large
 * branch denominator with them. That was coverage working correctly and a
 * percentage being a poor summary of it.
 */
const MIN_BRANCH = 94;
const MIN_LINE = 98;
const MIN_FUNCTIONS = 96;
const TARGET_BRANCH = 95;

const result = spawnSync(
  process.execPath,
  ['--experimental-test-coverage', '--test', 'test/*.test.ts'],
  { cwd: CORE, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status !== 0) {
  console.error('tests failed; coverage is not meaningful until they pass');
  console.error(output.slice(-4000));
  process.exit(1);
}

// The summary line the runner prints last, e.g.
//   ℹ all files           |  91.41 |    91.35 |   89.63 |
const summary = output.split('\n').find((line) => line.includes('all files'));
if (!summary) {
  console.error('could not find the coverage summary; did the runner change its output?');
  process.exit(1);
}

const numbers = summary.match(/(\d+\.\d+)/g);
if (!numbers || numbers.length < 3) {
  console.error(`could not parse the coverage summary: ${summary.trim()}`);
  process.exit(1);
}

const [line, branch, funcs] = numbers.map(Number);

console.log(`core coverage — line ${line}%, branch ${branch}%, functions ${funcs}%`);
console.log(
  `floor: line ${MIN_LINE}%, branch ${MIN_BRANCH}%, functions ${MIN_FUNCTIONS}%` +
    `    target: branch ${TARGET_BRANCH}%`,
);

let failed = false;
if (branch < MIN_BRANCH) {
  console.error(`✖ branch coverage ${branch}% is below the ${MIN_BRANCH}% floor`);
  failed = true;
}
if (line < MIN_LINE) {
  console.error(`✖ line coverage ${line}% is below the ${MIN_LINE}% floor`);
  failed = true;
}
if (funcs < MIN_FUNCTIONS) {
  console.error(`✖ function coverage ${funcs}% is below the ${MIN_FUNCTIONS}% floor`);
  failed = true;
}

if (failed) process.exit(1);

if (branch < TARGET_BRANCH) {
  // Stated on every run rather than tracked in a document nobody opens. The
  // build passes at the floor; the gap to the target stays visible.
  console.warn(
    `! branch coverage ${branch}% is below TRD-TEST-001's ${TARGET_BRANCH}% target ` +
      `(${(TARGET_BRANCH - branch).toFixed(2)} points to recover)`,
  );
} else {
  console.log('✓ TRD-TEST-001 satisfied');
}
