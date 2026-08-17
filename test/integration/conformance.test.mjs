/**
 * The same fixtures, inside goja (TRD-TEST-002).
 *
 * This is the test the whole offline model rests on. A student plays with no
 * signal, the phone scores the attempt so they get an answer immediately, and
 * the server later re-executes the same replay to decide what it was actually
 * worth. Those two numbers being the same is not a nice property — it is the
 * only reason showing the first one is honest.
 *
 * They run in different engines. Hermes on the phone, goja inside Nakama. Same
 * source, same bundle, two implementations of JavaScript with their own
 * histories around number formatting, property order, and string comparison —
 * and the core hashes state and canonicalises JSON, both of which are exactly
 * where those differences bite.
 *
 * A divergence here does not crash anything. It surfaces as the server telling
 * a student their work does not count, and the students it happens to are the
 * offline ones the design exists to serve.
 *
 * Node's side of the comparison is `test/conformance.test.mjs`, which runs
 * everywhere. This side needs the stack and therefore CI.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, disconnect, call, signIn } from './harness.mjs';
import { loadMissions } from '../../scripts/content-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { fixtures } = JSON.parse(
  readFileSync(join(here, '..', 'fixtures', 'replays.json'), 'utf8'),
);

const missions = new Map(
  [...loadMissions('congklak'), ...loadMissions('benteng')].map(({ mission }) => [
    mission.id,
    mission,
  ]),
);

/** goja is synchronous: a large batch stalls the VM other requests queue behind. */
const CHUNK = 25;

let available = false;
let token = null;

before(async () => {
  available = await connect();
  if (available) {
    const session = await signIn();
    token = session.token;

    // The seam is off unless a server was started for this. A green run that
    // silently skipped every fixture would be worse than a red one.
    const probe = await call(token, 'v1.dev.conformance', { cases: [] });
    if (!probe.ok) {
      console.log('skipping conformance: v1.dev.conformance is not registered');
      available = false;
    }
  }
});

after(disconnect);

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

describe('goja and Node agree on every fixture', () => {
  // Grouped into one test per chunk rather than one per fixture: 560 round
  // trips would dominate the job's runtime, and the failure message names the
  // fixture anyway.
  const batches = chunk(fixtures, CHUNK);

  batches.forEach((batch, index) => {
    test(`fixtures ${index * CHUNK + 1}–${index * CHUNK + batch.length}`, async (t) => {
      if (!available) return t.skip('no nakama with the conformance seam');

      const cases = batch.map((fixture) => ({
        id: fixture.id,
        // The mission is sent with the case rather than looked up server-side,
        // so this compares the *rules*, not the catalog. A fixture set and a
        // published catalog disagreeing is a different problem with a different
        // test (`content.test.mjs`).
        mission: missions.get(fixture.missionId) ?? missions.get('congklak.m01'),
        replay: fixture.replay,
      }));

      const response = await call(token, 'v1.dev.conformance', { cases });
      assert.ok(response.ok, `conformance call failed: ${JSON.stringify(response.error)}`);

      const verdicts = new Map(response.data.verdicts.map((v) => [v.id, v]));

      for (const fixture of batch) {
        const goja = verdicts.get(fixture.id);
        assert.ok(goja, `${fixture.id}: no verdict returned`);

        assert.equal(
          goja.valid,
          fixture.expected.valid,
          `${fixture.id}: goja says valid=${goja.valid}, Node says ${fixture.expected.valid}`,
        );

        if (!fixture.expected.valid) {
          // "Both said no" is not agreement when one of them said no for the
          // wrong reason: the reason is what the student is told and what the
          // server logs for review.
          assert.equal(
            goja.reason,
            fixture.expected.reason,
            `${fixture.id}: rejected for ${goja.reason}, expected ${fixture.expected.reason}`,
          );
          continue;
        }

        assert.equal(goja.outcome, fixture.expected.outcome, `${fixture.id}: outcome`);
        assert.equal(goja.suspicious, fixture.expected.suspicious, `${fixture.id}: suspicious`);
        // Every counter, not just the outcome. A runtime that agreed a mission
        // was won but not on how many captures it took would still be feeding
        // two different versions of one student into a teacher's dashboard.
        assert.deepEqual(
          goja.derivedMetrics,
          fixture.expected.derivedMetrics,
          `${fixture.id}: derived metrics differ between runtimes`,
        );
      }
    });
  });
});

test('the seam refuses a batch larger than it will process', async (t) => {
  if (!available) return t.skip('no nakama with the conformance seam');

  const oversized = { cases: new Array(CHUNK * 4).fill(null).map(() => ({ id: 'x' })) };
  const response = await call(token, 'v1.dev.conformance', oversized);

  // Bounded rather than truncated. A handler that silently processed the first
  // 50 would report agreement on fixtures it never ran.
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INVALID_ARGUMENT');
});
