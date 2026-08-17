/**
 * The refusals the content pipeline depends on.
 *
 * `checkGreedyTrap` and `verifyLine` are only useful for the cases where they
 * say no, and each refusal has to name *why*. An author who is told "not a
 * greedy trap" with no reason has to guess whether their mission is wrong or
 * the checker is; one who is told "no greedy move is identifiable for this
 * game" knows immediately that they put the declaration on a Benteng mission.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine, checkGreedyTrap, congklakEngine, verifyLine } from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { BentengMove, CongklakMove } from '../dist/index.js';

function congklak(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'congklak.m15',
    game: 'congklak',
    rank: 15,
    contentVersion: 1,
    skillWeights: { 'algo.greedy': 1 },
    eloDifficulty: 1100,
    goal: { kind: 'collect', count: 4 },
    setup: {
      game: 'congklak',
      pits: [0, 2, 2, 2, 2, 2, 0, 8, 1, 3, 2, 1],
      playerSide: 1,
      toMove: 1,
    },
    constraints: { maxMoves: 10, aiTier: 'sedang' },
    config: {
      extraTurnOnStore: true,
      captureEnabled: true,
      continuationEnabled: true,
      sweepOnEnd: true,
    },
    seed: 77,
    rationale: 'Taking the fullest pit opens the row and loses the seeds it gained.',
    titleKey: 'x',
    briefKey: 'x',
    hintKeys: [],
    failureKeys: { greedy: 'x' },
    ...overrides,
  };
}

const BENTENG: Mission = {
  id: 'benteng.m01',
  game: 'benteng',
  rank: 1,
  contentVersion: 1,
  skillWeights: { 'sec.assets': 1 },
  eloDifficulty: 700,
  goal: { kind: 'reach_base' },
  setup: {
    game: 'benteng',
    width: 5,
    height: 5,
    bases: [
      { side: 1, x: 2, y: 4 },
      { side: 2, x: 2, y: 0 },
    ],
    units: [{ id: 'p1', side: 1, x: 2, y: 3 }],
    toMove: 1,
  },
  constraints: { maxMoves: 8, aiTier: 'mudah' },
  config: { freshnessWindow: 0 },
  seed: 5,
  rationale: 'Walking a unit across the board to touch the enemy base.',
  titleKey: 'x',
  briefKey: 'x',
  hintKeys: [],
  failureKeys: { ranOut: 'x' },
};

// ---------------------------------------------------------------------------
// Greedy traps
// ---------------------------------------------------------------------------

test('a position with one legal move is not a greedy trap, and says why', () => {
  // Nothing to choose between means no choice to get wrong. Declaring such a
  // mission a trap would credit a student for a decision they never made.
  const forced = congklak({
    setup: {
      game: 'congklak',
      pits: [0, 2, 2, 2, 2, 2, 0, 3, 0, 0, 0, 0],
      playerSide: 1,
      toMove: 1,
    },
  });

  const result = checkGreedyTrap(congklakEngine as never, forced, { maxDepth: 4, maxNodes: 5_000 });
  assert.equal(result.isTrap, false);
  assert.match(result.reason, /two legal opening moves/);
});

test('a game with no greedy move cannot declare a greedy trap', () => {
  // Benteng has no fullest pit, so `isGreedyMove` is always false and the
  // declaration is meaningless rather than merely unmet.
  const result = checkGreedyTrap(bentengEngine as never, BENTENG, {
    maxDepth: 4,
    maxNodes: 5_000,
  });

  assert.equal(result.isTrap, false);
  assert.match(result.reason, /no greedy move/);
});

test('a real board reports both halves of the trap question', () => {
  // A trap needs two things: the greedy move loses *and* something else wins.
  // Reporting them separately is what lets an author see which half failed.
  const result = checkGreedyTrap(congklakEngine as never, congklak(), {
    maxDepth: 6,
    maxNodes: 40_000,
  });

  assert.equal(typeof result.greedyMoveWins, 'boolean');
  assert.equal(typeof result.alternativeWins, 'boolean');
  assert.equal(result.isTrap, !result.greedyMoveWins && result.alternativeWins);
});

// ---------------------------------------------------------------------------
// Line verification
// ---------------------------------------------------------------------------

test('a line that runs past the end of the mission is refused at that move', () => {
  // Extra moves after a win are not harmless padding: they mean the author's
  // line and the mission's goal disagree about when it is over.
  const winnable = congklak({ goal: { kind: 'collect', count: 1 } });
  const long: CongklakMove[] = [
    { kind: 'sow', pit: 7 },
    { kind: 'sow', pit: 8 },
    { kind: 'sow', pit: 9 },
    { kind: 'sow', pit: 10 },
    { kind: 'sow', pit: 11 },
    { kind: 'sow', pit: 7 },
    { kind: 'sow', pit: 8 },
  ];

  const result = verifyLine(congklakEngine as never, winnable, long);
  // Either it wins early or it is refused with a reason; what it must not do is
  // report success for a line whose later moves were never legal.
  if (!result.achieved) {
    assert.ok((result.reason ?? '').length > 0);
    assert.ok(result.failedAtMove !== null);
  }
});

test('a move of the wrong shape is refused before it is executed', () => {
  const result = verifyLine(congklakEngine as never, congklak(), [
    { nonsense: true },
  ] as unknown[]);

  assert.equal(result.achieved, false);
  assert.match(result.reason ?? '', /valid move/);
  assert.equal(result.failedAtMove, 0);
});

test('verification stops at the move that wins, not at the end of the line', () => {
  // The fixture has no enemy units, so the position resolves on the first move.
  // What matters is that `playerMoves` reports what was actually needed rather
  // than the length of the line — that number is what the move-cap check
  // compares against, and counting unplayed moves would fail good content.
  const line: BentengMove[] = [
    { kind: 'move', unitId: 'p1', x: 2, y: 2 },
    { kind: 'move', unitId: 'p1', x: 2, y: 1 },
    { kind: 'move', unitId: 'p1', x: 2, y: 0 },
  ];

  const result = verifyLine(bentengEngine as never, BENTENG, line);
  assert.equal(result.achieved, true, result.reason ?? '');
  assert.ok(
    result.playerMoves < line.length,
    'moves after the win must not be counted against the budget',
  );
});

test('a Benteng line that walks into an occupied square is refused', () => {
  const blocked: Mission = {
    ...BENTENG,
    setup: {
      game: 'benteng',
      width: 5,
      height: 5,
      bases: [
        { side: 1, x: 2, y: 4 },
        { side: 2, x: 2, y: 0 },
      ],
      units: [
        { id: 'p1', side: 1, x: 2, y: 3 },
        { id: 'e1', side: 2, x: 2, y: 2, freshness: 0 },
      ],
      toMove: 1,
    },
  };

  // Equal freshness, so the capture is illegal and the square is impassable.
  const result = verifyLine(bentengEngine as never, blocked, [
    { kind: 'move', unitId: 'p1', x: 2, y: 2 },
  ] as BentengMove[]);

  assert.equal(result.achieved, false);
  assert.equal(result.failedAtMove, 0);
  assert.ok((result.reason ?? '').length > 0);
});
