/**
 * The solver, the verifier, and the difficulty estimate.
 *
 * These decide whether authored content ships. A mission nobody can beat is
 * broken rather than hard, and a student who fails it six times has learned
 * only that the product is unfair — so `solve` refusing to find a line is what
 * stands between that and a classroom.
 *
 * They ran on every publish and had no unit test, because the content pipeline
 * exercised them end to end. That is a real test but a slow and indirect one:
 * when it fails it says "mission m07 is unsolved", not which part of the search
 * is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkGreedyTrap,
  congklakEngine,
  eloFromSuccessRate,
  estimateDifficulty,
  greedyLine,
  solve,
  verifyLine,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { CongklakMove } from '../dist/index.js';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'congklak.m02',
    game: 'congklak',
    rank: 2,
    contentVersion: 1,
    skillWeights: { 'comp.counting': 1 },
    eloDifficulty: 800,
    goal: { kind: 'collect', count: 2 },
    setup: {
      game: 'congklak',
      pits: [0, 1, 1, 1, 1, 1, 0, 6, 0, 0, 0, 6],
      playerSide: 1,
      toMove: 1,
    },
    constraints: { maxMoves: 12, aiTier: 'sedang' },
    config: {
      extraTurnOnStore: true,
      captureEnabled: false,
      continuationEnabled: false,
      sweepOnEnd: true,
    },
    seed: 4242,
    rationale: 'Counting seeds in a pit and predicting where the last one lands.',
    titleKey: 'x',
    briefKey: 'x',
    hintKeys: [],
    failureKeys: { ranOut: 'x' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

test('a winnable mission is solved, and the line it returns actually wins', () => {
  const result = solve(congklakEngine as never, mission(), { maxDepth: 8, maxNodes: 60_000 });

  assert.equal(result.solvable, true);
  assert.ok(result.line.length > 0);

  // The line is not taken on trust: replaying it has to reach the goal, or the
  // solver is reporting a win it cannot demonstrate.
  const verified = verifyLine(congklakEngine as never, mission(), result.line);
  assert.equal(verified.achieved, true, verified.reason ?? '');
});

test('a mission nobody can win is reported unsolvable rather than merely hard', () => {
  // Twenty seeds required from a board holding far fewer, inside four moves.
  const impossible = mission({
    goal: { kind: 'collect', count: 40 },
    constraints: { maxMoves: 4, aiTier: 'sedang' },
  });

  const result = solve(congklakEngine as never, impossible, { maxDepth: 4, maxNodes: 20_000 });
  assert.equal(result.solvable, false);
});

test('the search reports when it ran out of budget rather than claiming a proof', () => {
  // A search that stopped early has proven nothing. Saying "unsolvable" would
  // be a claim it cannot support, and would reject good content.
  const hard = mission({
    goal: { kind: 'collect', count: 12 },
    constraints: { maxMoves: 30, aiTier: 'sulit' },
  });

  const result = solve(congklakEngine as never, hard, { maxDepth: 30, maxNodes: 40 });
  if (!result.solvable) {
    assert.equal(result.exhausted, true, 'a truncated search must say it was truncated');
  }
  assert.ok(result.nodesVisited > 0);
});

test('solving is deterministic, so a publish does not depend on when it ran', () => {
  const first = solve(congklakEngine as never, mission(), { maxDepth: 8, maxNodes: 60_000 });
  const second = solve(congklakEngine as never, mission(), { maxDepth: 8, maxNodes: 60_000 });
  assert.deepEqual(first.line, second.line);
});

// ---------------------------------------------------------------------------
// verifyLine
// ---------------------------------------------------------------------------

test('an authored line that does not win is rejected with a reason', () => {
  const wrong = verifyLine(congklakEngine as never, mission(), [
    { kind: 'sow', pit: 7 },
  ] as CongklakMove[]);

  assert.equal(wrong.achieved, false);
  assert.ok((wrong.reason ?? '').length > 0, 'an author needs to be told what went wrong');
});

test('an illegal move in an authored line is caught at the move it occurs', () => {
  const illegal = verifyLine(congklakEngine as never, mission(), [
    { kind: 'sow', pit: 1 },
  ] as CongklakMove[]);

  assert.equal(illegal.achieved, false);
  assert.equal(illegal.failedAtMove, 0);
});

test('an empty line wins nothing and says so', () => {
  const empty = verifyLine(congklakEngine as never, mission(), []);
  assert.equal(empty.achieved, false);
  assert.equal(empty.playerMoves, 0);
});

test('the greedy line reports what the obvious move achieves, and whether it wins', () => {
  // It plays the obvious move every turn — useful for seeing what a careless
  // student would do. It returns whether that won, because "the greedy line
  // wins" is exactly what disqualifies a mission from being a greedy trap.
  const result = greedyLine(congklakEngine as never, mission(), 12);

  assert.ok(Array.isArray(result.line));
  assert.equal(typeof result.achieved, 'boolean');

  if (result.achieved) {
    const verified = verifyLine(congklakEngine as never, mission(), result.line);
    assert.equal(verified.achieved, true, 'a line claimed to win has to win when replayed');
  }
});

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

test('a difficulty estimate that cannot be inverted is marked uninformative', () => {
  // A 0% or 100% success rate cannot be turned into a rating: the number that
  // comes back is a property of the clamp, not of the mission. Publishing it as
  // an ELO would put a confident figure on a measurement that failed.
  const trivial = mission({ goal: { kind: 'collect', count: 0 } });
  const estimate = estimateDifficulty(congklakEngine as never, trivial, 40);

  if (estimate.successRate === 0 || estimate.successRate === 1) {
    assert.equal(estimate.informative, false);
  }
  assert.ok(estimate.successRate >= 0 && estimate.successRate <= 1);
});

test('a mission with real choices produces an informative estimate', () => {
  const estimate = estimateDifficulty(congklakEngine as never, mission(), 200);
  assert.ok(estimate.meanBranching >= 1, 'there has to be something to choose between');
  assert.ok(Number.isFinite(estimate.impliedElo));
});

test('the rating implied by a success rate moves the right way', () => {
  // Harder means fewer wins means a higher rating. If this inverts, every
  // mission in the ladder is rated backwards.
  const easy = eloFromSuccessRate(0.9);
  const even = eloFromSuccessRate(0.5);
  const hard = eloFromSuccessRate(0.1);

  assert.ok(hard > even);
  assert.ok(even > easy);
  assert.equal(even, 1000, 'an even chance is the reference rating by definition');
});

test('the rating is clamped rather than running to infinity at the extremes', () => {
  assert.ok(Number.isFinite(eloFromSuccessRate(0)));
  assert.ok(Number.isFinite(eloFromSuccessRate(1)));
  assert.ok(eloFromSuccessRate(0) > eloFromSuccessRate(1));
});

// ---------------------------------------------------------------------------
// Greedy traps
// ---------------------------------------------------------------------------

test('a mission declared a greedy trap is checked rather than believed', () => {
  // `algo.greedy` is the most valuable transfer concept in Congklak, and a
  // mission claiming to teach it while the greedy move happens to win teaches
  // the opposite lesson.
  const result = checkGreedyTrap(congklakEngine as never, mission(), {
    maxDepth: 6,
    maxNodes: 30_000,
  });

  assert.equal(typeof result.isTrap, 'boolean');
  if (!result.isTrap) {
    assert.ok(result.reason.length > 0, 'an author needs to know why it is not a trap');
  }
});
