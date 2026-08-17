/**
 * The fixtures, executed under Node (TRD-TEST-002).
 *
 * Half of a two-runtime comparison. This half runs everywhere and on every
 * change; the other half — `test/integration/conformance.test.mjs` — runs the
 * identical fixtures inside a real Nakama and asserts the two agree exactly.
 *
 * What this half is for on its own: the fixtures record what the rules said at
 * the moment they were generated, so a change to the engine that alters an
 * outcome, a state hash, or a derived metric shows up here as a failing
 * fixture naming the mission it broke. That is a deliberate ratchet. An engine
 * change *should* be hard to make by accident, because every mission's ELO was
 * authored against the current behaviour and the ladder is re-rated silently by
 * anything that moves it.
 *
 * When a change is intended, regenerate with `npm run fixtures:generate` and
 * the diff shows exactly which missions changed and how — which is the review
 * the ratchet exists to force.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bentengEngine,
  congklakEngine,
  hashConfig,
  validateReplay,
} from '../packages/core/dist/index.js';
import { loadMissions } from '../scripts/content-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { fixtures, configHashes } = JSON.parse(
  readFileSync(join(here, 'fixtures', 'replays.json'), 'utf8'),
);

const missions = new Map(
  [...loadMissions('congklak'), ...loadMissions('benteng')].map(({ mission }) => [
    mission.id,
    mission,
  ]),
);

const engineFor = (game) => (game === 'benteng' ? bentengEngine : congklakEngine);

test('the fixture set is large enough to be worth running', () => {
  assert.ok(fixtures.length >= 500, `only ${fixtures.length} fixtures`);
  assert.ok(
    fixtures.some((f) => f.game === 'congklak') && fixtures.some((f) => f.game === 'benteng'),
    'both games must be represented',
  );
});

test('every rejection reason the validator can produce is represented', () => {
  // A conformance suite that only covers the happy path proves the two runtimes
  // agree about valid play, which is the easier half. The disagreement with a
  // victim is one runtime accepting a tampered replay the other rejects.
  const reasons = new Set(fixtures.filter((f) => !f.expected.valid).map((f) => f.expected.reason));

  for (const reason of [
    'sequence_gap',
    'malformed_replay',
    'config_mismatch',
    'core_version_unsupported',
    'unknown_mission',
    'replay_mismatch',
    'illegal_move',
    'ai_divergence',
  ]) {
    assert.ok(reasons.has(reason), `no fixture exercises ${reason}`);
  }
});

test('the fixtures were generated against the rules currently in the tree', () => {
  // Checked before the fixtures themselves, because a mission whose config
  // moved would fail every one of its fixtures and the reason would be buried
  // in five hundred lines of output rather than stated once.
  for (const [missionId, expected] of Object.entries(configHashes)) {
    const mission = missions.get(missionId);
    assert.ok(mission, `fixture set references a mission that no longer exists: ${missionId}`);
    assert.equal(
      hashConfig(mission),
      expected,
      `${missionId}'s resolved config has changed — regenerate the fixtures and review the diff`,
    );
  }
});

describe('replays validate identically to their recorded expectation', () => {
  for (const fixture of fixtures) {
    test(fixture.id, () => {
      const mission = missions.get(fixture.missionId);
      // `unknown_mission` fixtures name a mission that does not exist, which is
      // exactly what they are testing; they validate against the mission the
      // replay was built from.
      const target = mission ?? missions.get(fixture.replay.missionId.replace(/m\d+$/, 'm01'));
      assert.ok(target, `no mission for ${fixture.id}`);

      const result = validateReplay(fixture.replay, target, engineFor(fixture.game));

      assert.equal(result.valid, fixture.expected.valid);
      if (!result.valid) {
        assert.equal(result.reason, fixture.expected.reason);
        return;
      }

      assert.equal(result.outcome, fixture.expected.outcome);
      assert.equal(result.suspicious, fixture.expected.suspicious);
      // Deep equality on every counter. These are what a teacher reads and what
      // the adaptive engine reasons about, so a runtime that agreed on the
      // outcome but not on the capture count would still be feeding two
      // different students' records into one dashboard.
      assert.deepEqual(result.derivedMetrics, fixture.expected.derivedMetrics);
    });
  }
});
