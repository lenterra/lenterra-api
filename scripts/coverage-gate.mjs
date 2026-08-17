#!/usr/bin/env node
// Branch-coverage gate for the shared core (TRD-TEST-001).
//
// The core is the one package where a bug is wrong twice: once on the phone and
// once in the validator, in the same way, so the two agree on an incorrect
// answer and nothing looks broken. Everywhere else a mistake surfaces as a
// mismatch; here it surfaces as a student being told they lost a mission they
// won, with the server agreeing.
//
// TRD-TEST-001 sets the target at 95% of branches. The gate below is a ratchet:
// it holds the line at what has actually been reached, so coverage cannot slide
// backwards while the remaining gap is closed. Raising it is a one-line change;
// lowering it should not happen without a note saying why.
//
// A caveat worth recording, because it is not obvious from the number: coverage
// is measured against the compiled output, which contains TypeScript's own
// `__createBinding` and `__exportStar` helpers. Those run only under an ESM
// consumer and cannot execute in this CJS test run, so a small residue of
// "uncovered" branches belongs to the compiler rather than to this code.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core');

/** Current floor. TRD-TEST-001's target is 95. */
const MIN_BRANCH = 90;
const MIN_LINE = 90;
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
console.log(`floor: line ${MIN_LINE}%, branch ${MIN_BRANCH}%    target: branch ${TARGET_BRANCH}%`);

let failed = false;
if (branch < MIN_BRANCH) {
  console.error(`✖ branch coverage ${branch}% is below the ${MIN_BRANCH}% floor`);
  failed = true;
}
if (line < MIN_LINE) {
  console.error(`✖ line coverage ${line}% is below the ${MIN_LINE}% floor`);
  failed = true;
}

if (failed) process.exit(1);

if (branch < TARGET_BRANCH) {
  // Stated on every run rather than tracked in a document nobody opens. The
  // build passes; the gap stays visible.
  console.warn(
    `! branch coverage ${branch}% has not yet reached TRD-TEST-001's ${TARGET_BRANCH}% target ` +
      `(${(TARGET_BRANCH - branch).toFixed(2)} points remaining)`,
  );
} else {
  console.log('✓ TRD-TEST-001 satisfied');
}
