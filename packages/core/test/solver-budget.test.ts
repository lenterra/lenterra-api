/**
 * What the solver does when it cannot finish, and what it says about content
 * that is not what it claims to be.
 *
 * These are the paths the content pipeline hits on the days it matters. A
 * search that ran out of budget must not report "unsolvable", because that
 * rejects good content and an author has no way to tell the difference. A
 * mission declared a greedy trap whose greedy move happens to win teaches the
 * opposite of what its brief promises. And a mission nobody can beat looks
 * completely fine in a diff.
 *
 * They were the least-covered code in the package — a large branch denominator
 * of budget checks, depth limits, and early exits, almost none of it exercised,
 * because the content pipeline only ever runs the happy path over content that
 * already passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bentengEngine,
  checkGreedyTrap,
  congklakEngine,
  estimateDifficulty,
  eloFromSuccessRate,
  greedyLine,
  solve,
  verifyLine,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { BentengMove, CongklakMove } from '../dist/index.js';

function congklak(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'congklak.m07',
    game: 'congklak',
    rank: 7,
    contentVersion: 1,
    skillWeights: { 'algo.greedy': 1 },
    eloDifficulty: 1000,
    goal: { kind: 'collect', count: 3 },
    setup: {
      game: 'congklak',
      pits: [0, 2, 2, 2, 2, 2, 0, 5, 1, 3, 2, 1],
      playerSide: 1,
      toMove: 1,
    },
    constraints: { maxMoves: 12, aiTier: 'sedang' },
    config: {
      extraTurnOnStore: true,
      captureEnabled: true,
      continuationEnabled: true,
      sweepOnEnd: true,
    },
    seed: 31,
    rationale: 'Choosing between a full pit and a pit that reaches the store.',
    titleKey: 'x',
    briefKey: 'x',
    hintKeys: [],
    failureKeys: { greedy: 'x' },
    ...overrides,
  };
}

function benteng(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'benteng.m05',
    game: 'benteng',
    rank: 5,
    contentVersion: 1,
    skillWeights: { 'sec.assets': 1 },
    eloDifficulty: 950,
    goal: { kind: 'reach_base' },
    setup: {
      game: 'benteng',
      width: 5,
      height: 5,
      bases: [
        { side: 1, x: 2, y: 4 },
        { side: 2, x: 2, y: 0 },
      ],
      units: [
        { id: 'p1', side: 1, x: 1, y: 3 },
        { id: 'e1', side: 2, x: 3, y: 1 },
      ],
      toMove: 1,
    },
    constraints: { maxMoves: 10, aiTier: 'mudah' },
    config: { freshnessWindow: 0 },
    seed: 9,
    rationale: 'Crossing a board while an opponent is looking for a stale unit.',
    titleKey: 'x',
    briefKey: 'x',
    hintKeys: [],
    failureKeys: { ranOut: 'x' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Budgets and defaults
// ---------------------------------------------------------------------------

test('solving with no options at all uses the built-in budget', () => {
  // Every caller in the content pipeline passes options, so the defaults were
  // never executed — which means the numbers that bound a CI run had never run.
  const result = solve(congklakEngine as never, congklak());

  assert.equal(typeof result.solvable, 'boolean');
  assert.ok(result.nodesVisited > 0, 'the default budget must permit some search');
});

test('a mission with no declared tier or move cap is still searchable', () => {
  // Authored content always sets these. A mission being validated *before* they
  // are filled in is exactly when an author needs the solver to work.
  const bare = congklak({ constraints: {} });

  const result = solve(congklakEngine as never, bare, { maxDepth: 4, maxNodes: 8_000 });
  assert.equal(typeof result.solvable, 'boolean');

  const estimate = estimateDifficulty(congklakEngine as never, bare, 20);
  assert.ok(estimate.playouts === 20);
});

test('a search stopped by its node budget says so rather than claiming a proof', () => {
  // The distinction the whole option exists for. "Unsolvable" is a claim about
  // the mission; "exhausted" is a claim about the search, and reporting the
  // first when only the second is true rejects content that is perfectly fine.
  const result = solve(congklakEngine as never, congklak({ goal: { kind: 'collect', count: 30 } }), {
    maxDepth: 20,
    maxNodes: 3,
  });

  assert.equal(result.solvable, false);
  assert.equal(result.exhausted, true);
  assert.deepEqual(result.line, []);
});

test('a search that finishes without a win is not marked exhausted', () => {
  const result = solve(congklakEngine as never, congklak({ goal: { kind: 'collect', count: 99 } }), {
    maxDepth: 2,
    maxNodes: 200_000,
  });

  assert.equal(result.solvable, false);
  assert.equal(result.exhausted, false, 'a completed search must not claim it was truncated');
});

test('depth zero searches nothing and proves nothing', () => {
  const result = solve(congklakEngine as never, congklak(), { maxDepth: 0, maxNodes: 1000 });
  assert.equal(result.solvable, false);
  assert.equal(result.nodesVisited, 0);
});

// ---------------------------------------------------------------------------
// Greedy traps — every branch of the verdict
// ---------------------------------------------------------------------------

test('a trap check that runs out of budget reports no winning opening', () => {
  // Each opening move gets its own probe, so a tiny budget starves all of them.
  // The result must be the honest "no opening wins", never a claimed trap.
  //
  // The goal has to be out of reach of the opening move itself: a probe checks
  // whether the position is already won *before* it spends any budget, so a
  // one-move win would be found however small the budget is.
  const result = checkGreedyTrap(
    congklakEngine as never,
    congklak({ goal: { kind: 'collect', count: 30 } }),
    { maxDepth: 8, maxNodes: 1 },
  );

  assert.equal(result.isTrap, false);
  assert.equal(result.greedyMoveWins, false);
  assert.equal(result.alternativeWins, false);
  assert.match(result.reason, /no opening wins/);
});

test('a mission already won before a move is played needs no search', () => {
  // `collect 0` is achieved at the opening position. The probe has to notice
  // that before it starts expanding, or every opening "wins" for the wrong
  // reason.
  const result = checkGreedyTrap(congklakEngine as never, congklak({ goal: { kind: 'collect', count: 0 } }), {
    maxDepth: 4,
    maxNodes: 5_000,
  });

  // Every opening wins, including the greedy one — so it is emphatically not a
  // trap, and the reason has to say which half failed.
  assert.equal(result.isTrap, false);
  assert.equal(result.greedyMoveWins, true);
  assert.match(result.reason, /also wins/);
});

test('a game with no greedy move cannot be a trap, whatever else is true', () => {
  const result = checkGreedyTrap(bentengEngine as never, benteng(), {
    maxDepth: 4,
    maxNodes: 5_000,
  });

  assert.equal(result.isTrap, false);
  assert.match(result.reason, /no greedy move/);
});

test('a position with one legal move is not a choice and not a trap', () => {
  const forced = congklak({
    setup: { game: 'congklak', pits: [0, 2, 2, 2, 2, 2, 0, 4, 0, 0, 0, 0], playerSide: 1, toMove: 1 },
  });

  const result = checkGreedyTrap(congklakEngine as never, forced, { maxDepth: 4, maxNodes: 5_000 });
  assert.equal(result.isTrap, false);
  assert.match(result.reason, /two legal opening moves/);
});

// ---------------------------------------------------------------------------
// Difficulty estimation
// ---------------------------------------------------------------------------

test('a grid game counts its moves as real choices', () => {
  // The filter excludes *prediction* phases, where one option per cell would
  // inflate the figure without the student facing any more real choice. It does
  // not exclude Benteng: choosing which unit to move and where is exactly the
  // decision the number is meant to measure.
  //
  // Worth pinning because `isSowPhase` reads as though it means "is Congklak",
  // and a future reader tightening it to that would silently zero the branching
  // of half the ladder — which feeds the difficulty check deciding whether an
  // authored ELO is believed.
  const estimate = estimateDifficulty(bentengEngine as never, benteng(), 15);

  assert.ok(estimate.meanBranching > 1, 'a grid game offers real choices');
  assert.ok(Number.isFinite(estimate.impliedElo));
});

test('an estimate is uninformative at either extreme of the success rate', () => {
  // The rate cannot be inverted at 0 or 1: the number that comes back is a
  // property of the clamp, not of the mission.
  const certain = estimateDifficulty(congklakEngine as never, congklak({ goal: { kind: 'collect', count: 0 } }), 12);
  assert.equal(certain.successRate, 1);
  assert.equal(certain.informative, false);

  const impossible = estimateDifficulty(congklakEngine as never, congklak({ goal: { kind: 'collect', count: 999 } }), 12);
  assert.equal(impossible.successRate, 0);
  assert.equal(impossible.informative, false);
});

test('the same mission estimates identically twice, so a check never flakes', () => {
  const a = estimateDifficulty(congklakEngine as never, congklak(), 40);
  const b = estimateDifficulty(congklakEngine as never, congklak(), 40);
  assert.deepEqual(a, b);
});

test('the implied rating is finite and clamped at both tails', () => {
  assert.ok(Number.isFinite(eloFromSuccessRate(0)));
  assert.ok(Number.isFinite(eloFromSuccessRate(1)));
  assert.equal(eloFromSuccessRate(0.5), 1000);
  // A different reference shifts the whole curve rather than reshaping it.
  assert.equal(eloFromSuccessRate(0.5, 1200), 1200);
});

// ---------------------------------------------------------------------------
// Line verification
// ---------------------------------------------------------------------------

test('a line for a mission already over is refused at its first move', () => {
  const done = congklak({ goal: { kind: 'collect', count: 999 }, constraints: { maxMoves: 1, aiTier: 'sedang' } });
  const result = verifyLine(congklakEngine as never, done, [{ kind: 'sow', pit: 7 }] as CongklakMove[]);

  // Either it is refused, or it is honestly reported as not achieving the goal.
  // What it must never do is claim success.
  assert.equal(result.achieved, false);
});

test('an authored line is not credited for moves it never needed', () => {
  // `playerMoves` is what the move-cap check compares against, so counting
  // unplayed moves would fail content that is within its budget.
  const line: BentengMove[] = [
    { kind: 'move', unitId: 'p1', x: 1, y: 2 },
    { kind: 'move', unitId: 'p1', x: 1, y: 1 },
    { kind: 'move', unitId: 'p1', x: 1, y: 0 },
    { kind: 'move', unitId: 'p1', x: 2, y: 0 },
  ];

  const result = verifyLine(bentengEngine as never, benteng(), line);
  assert.ok(result.playerMoves <= line.length);
});

test('the greedy line is bounded, and reports what it achieved either way', () => {
  // Bounded because a mission with no terminal state inside the cap would
  // otherwise run until something else stopped it.
  const short = greedyLine(congklakEngine as never, congklak(), 1);
  assert.ok(short.line.length <= 1);
  assert.equal(typeof short.achieved, 'boolean');

  const long = greedyLine(congklakEngine as never, congklak(), 40);
  assert.ok(long.line.length <= 40);
  if (long.achieved) {
    const replayed = verifyLine(congklakEngine as never, congklak(), long.line);
    assert.equal(replayed.achieved, true, 'a line claimed to win must win when replayed');
  }
});

test('a greedy line on a mission with nothing to play returns empty', () => {
  const empty = congklak({
    setup: { game: 'congklak', pits: [0, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0], playerSide: 1, toMove: 1 },
  });

  const result = greedyLine(congklakEngine as never, empty, 5);
  assert.equal(result.line.length, 0);
  assert.equal(result.achieved, false);
});

test('the greedy line works on a grid game, where ranking ties are common', () => {
  // Benteng's `rankMove` returns null far more often than Congklak's, which is
  // the tie-breaking path: ties resolve by move order so the result is
  // reproducible from the mission file alone.
  const first = greedyLine(bentengEngine as never, benteng(), 12);
  const second = greedyLine(bentengEngine as never, benteng(), 12);

  assert.deepEqual(first.line, second.line, 'the greedy line must be deterministic');
});
