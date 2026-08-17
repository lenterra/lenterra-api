/**
 * Mission validation — the gate authored content passes through.
 *
 * Exercised on every publish but never directly, which meant its own branches
 * were the least-tested code guarding the most-reviewed artefact. Each case
 * breaks one rule from the content table (10-12 PRD-CNT-002) and asserts the
 * refusal, because a check nobody has seen reject anything is indistinguishable
 * from a check that does not work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkGreedyTrapQuota,
  hasErrors,
  primaryNodeOf,
  primaryNodeOfMission,
  validateMission,
  validateMissionSet,
  congklakEngine,
  bentengEngine,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'congklak.m02',
    game: 'congklak',
    rank: 2,
    contentVersion: 1,
    skillWeights: { 'comp.arithmetic': 0.65, 'comp.counting': 0.35 },
    eloDifficulty: 850,
    goal: { kind: 'collect', count: 2 },
    setup: {
      game: 'congklak',
      pits: [0, 1, 1, 1, 1, 1, 0, 6, 0, 0, 0, 6],
      playerSide: 1,
      toMove: 1,
    },
    constraints: { maxMoves: 20, aiTier: 'sedang' },
    config: { extraTurnOnStore: true },
    seed: 4242,
    rationale: 'The student counts seeds in a pit and predicts the landing pit to reach the store.',
    titleKey: 'x.title',
    briefKey: 'x.brief',
    hintKeys: ['x.hint'],
    failureKeys: { ranOut: 'x.fail' },
    ...overrides,
  };
}

const fails = (m: Mission, check: string) =>
  validateMission(m).some((issue) => issue.check === check && issue.severity === 'error');

const warns = (m: Mission, check: string) =>
  validateMission(m).some((issue) => issue.check === check && issue.severity === 'warning');

test('a well-formed mission passes', () => {
  assert.equal(hasErrors(validateMission(mission())), false);
});

// --- schema ----------------------------------------------------------------

test('an id that is not "<game>.<slug>" is refused', () => {
  assert.ok(fails(mission({ id: 'm02' }), 'schema'));
});

test('an id whose prefix disagrees with the game is refused', () => {
  assert.ok(fails(mission({ id: 'benteng.m02' }), 'schema'));
});

test('a rank below one is refused', () => {
  assert.ok(fails(mission({ rank: 0 }), 'schema'));
});

test('a non-integer content version is refused', () => {
  assert.ok(fails(mission({ contentVersion: 1.5 }), 'schema'));
});

test('a non-numeric ELO is refused', () => {
  assert.ok(fails(mission({ eloDifficulty: Number.NaN }), 'schema'));
});

test('a non-integer seed is refused, because determinism depends on it', () => {
  // A mission whose opponent is not reproducible cannot be replay-validated,
  // which means offline play against it can never be trusted.
  assert.ok(fails(mission({ seed: 0.5 }), 'schema'));
});

test('a setup for the wrong game is refused', () => {
  const broken = mission({
    setup: {
      game: 'benteng',
      width: 5,
      height: 5,
      bases: [{ side: 1, x: 2, y: 4 }],
      units: [],
      toMove: 1,
    },
  });
  assert.ok(fails(broken, 'schema'));
});

test('a non-positive move cap is refused and an enormous one is flagged', () => {
  assert.ok(fails(mission({ constraints: { maxMoves: 0 } }), 'schema'));
  // Design rule 4: a mission fits a 2–5 minute session on a borrowed phone.
  assert.ok(warns(mission({ constraints: { maxMoves: 500 } }), 'reading_time'));
});

// --- weights ---------------------------------------------------------------

test('empty weights are refused, because they evidence nothing', () => {
  assert.ok(fails(mission({ skillWeights: {} }), 'weights'));
});

test('weights that do not sum to one are refused', () => {
  assert.ok(fails(mission({ skillWeights: { 'comp.arithmetic': 0.5 } }), 'weights'));
});

test('a weight outside (0,1] is refused', () => {
  assert.ok(
    fails(mission({ skillWeights: { 'comp.arithmetic': 1.4, 'comp.counting': -0.4 } }), 'weights'),
  );
});

test('an unknown skill node is refused', () => {
  assert.ok(fails(mission({ skillWeights: { 'comp.nonsense': 1 } as never }), 'node_references'));
});

test('a mission with no primary node is refused', () => {
  // Design rule 1. A mission that teaches "a bit of everything" produces
  // evidence that moves four nodes slightly and tells a teacher nothing.
  const spread = mission({
    skillWeights: {
      'comp.arithmetic': 0.25,
      'comp.counting': 0.25,
      'comp.modular': 0.25,
      'comp.estimation': 0.25,
    },
  });
  assert.ok(fails(spread, 'primary_skill'));
});

test('a mission with two primary nodes is refused', () => {
  const twin = mission({ skillWeights: { 'comp.arithmetic': 0.5, 'comp.counting': 0.5 } });
  assert.ok(fails(twin, 'primary_skill'));
});

// --- rationale -------------------------------------------------------------

test('a missing or too-short rationale is refused', () => {
  assert.ok(fails(mission({ rationale: '' }), 'rationale'));
  assert.ok(fails(mission({ rationale: 'Teaches counting.' }), 'rationale'));
});

test('a rationale duplicated from another mission is refused', () => {
  // A copy-pasted rationale is the tell that the skill mapping was not thought
  // about for the second mission.
  const seen = new Set<string>();
  assert.equal(hasErrors(validateMission(mission(), seen)), false);
  assert.ok(
    validateMission(mission({ id: 'congklak.m03', rank: 3 }), seen).some(
      (issue) => issue.check === 'rationale' && issue.severity === 'error',
    ),
  );
});

test('a rationale that names no mechanic is flagged', () => {
  // The anti-skin rule: a mission may not claim a skill because its artwork
  // mentions it. Naming the mechanic is what ties the claim to the game.
  const vague = mission({
    rationale: 'This mission develops the student’s algorithmic thinking and numeracy skills.',
  });
  assert.ok(warns(vague, 'rationale'));
});

// --- diagnostics and strings -----------------------------------------------

test('a mission with no failure diagnostic is refused', () => {
  // Design rule 2: a student who cannot name their mistake cannot correct it.
  assert.ok(fails(mission({ failureKeys: {} }), 'diagnostics'));
});

test('missing title or brief keys are refused', () => {
  assert.ok(fails(mission({ titleKey: '' }), 'strings'));
  assert.ok(fails(mission({ briefKey: '' }), 'strings'));
});

// --- the set ---------------------------------------------------------------

test('a duplicate id and content version in one set is refused', () => {
  const issues = validateMissionSet([mission(), mission()]);
  assert.ok(issues.some((issue) => issue.check === 'schema'));
});

test('a gap in the ladder is refused', () => {
  // "Highest unlocked rank + 1" stops unlocking silently at a gap, so a student
  // reaches rank 3 and the ladder simply ends with no message.
  const issues = validateMissionSet([
    mission({ id: 'congklak.m01', rank: 1, rationale: 'Sowing seeds one at a time from a pit.' }),
    mission({ id: 'congklak.m03', rank: 3, rationale: 'Chaining a sowing that lands in a full pit.' }),
  ]);
  assert.ok(issues.some((issue) => issue.check === 'schema'));
});

test('a contiguous ladder passes', () => {
  const issues = validateMissionSet([
    mission({ id: 'congklak.m01', rank: 1, rationale: 'Sowing seeds one at a time from a pit.' }),
    mission({ id: 'congklak.m02', rank: 2 }),
  ]);
  assert.equal(hasErrors(issues), false);
});

// --- greedy-trap quota -----------------------------------------------------

test('the greedy-trap quota refuses a ladder that has eroded', () => {
  // `algo.greedy` is the most valuable transfer concept in Congklak, and a
  // quota is the only thing stopping it thinning out as content is added.
  const ladder = [
    mission({ id: 'congklak.m01', rank: 1, rationale: 'Sowing seeds one at a time from a pit.' }),
    mission({ id: 'congklak.m02', rank: 2 }),
    mission({ id: 'congklak.m03', rank: 3, rationale: 'Chaining a sowing that lands in a full pit.' }),
  ];

  assert.ok(hasErrors(checkGreedyTrapQuota(ladder, new Set())));
  assert.equal(checkGreedyTrapQuota(ladder, new Set(['congklak.m01'])).length, 0);
  // No Congklak missions means no quota to enforce.
  assert.equal(checkGreedyTrapQuota([], new Set()).length, 0);
});

// --- primary node ----------------------------------------------------------

test('the primary node is the heaviest, breaking ties on id for determinism', () => {
  assert.equal(primaryNodeOfMission(mission()), 'comp.arithmetic');
  assert.equal(primaryNodeOf({}), null);
  // A tie resolves the same way on every platform, which matters because the
  // client and server both compute it.
  assert.equal(primaryNodeOf({ 'comp.counting': 0.5, 'comp.arithmetic': 0.5 }), 'comp.arithmetic');
});

// --- engine guards ---------------------------------------------------------

test('a malformed board is refused by the engine rather than played', () => {
  // An odd number of cells cannot be split into two equal rows plus two stores,
  // so there is no board to play on and no sensible default to substitute.
  assert.throws(
    () =>
      congklakEngine.init(
        { game: 'congklak', pits: [0, 1, 1, 1, 1, 1, 0], playerSide: 1, toMove: 1 } as never,
        {},
      ),
    /even number of cells/,
  );
});

test('a board too small to be a board falls back to the standard one', () => {
  // Distinct from the odd-length case: a three-cell board is not a mistake the
  // engine can interpret, but the standard board is a defensible substitute
  // where an odd count is not.
  const state = congklakEngine.init(
    { game: 'congklak', pits: [0, 1, 1], playerSide: 1, toMove: 1 } as never,
    {},
  ) as { pits: number[] };
  assert.equal(state.pits.length, 12);
});

test('the two engines handle a wrong-game setup differently, on purpose', () => {
  // Content validation refuses this combination either way, so what is pinned
  // here is which failure a student would see if one ever slipped past.
  //
  // Congklak substitutes the standard board: every regional variant is a board
  // of the same shape, so there is a defensible default and a playable session
  // beats a crash.
  const congklak = congklakEngine.init(
    { game: 'benteng', width: 5, height: 5, bases: [], units: [], toMove: 1 } as never,
    {},
  ) as { pits: number[] };
  assert.equal(congklak.pits.length, 12);

  // Benteng refuses. There is no default board — the grid size, base positions
  // and unit placement are the mission — so inventing one would put a student
  // in a game nobody authored and then score whatever happened there.
  assert.throws(
    () =>
      bentengEngine.init(
        { game: 'congklak', pits: [0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1], playerSide: 1, toMove: 1 } as never,
        {},
      ),
    /not a benteng setup/,
  );
});
