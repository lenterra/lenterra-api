/**
 * The opponent when it has nothing to play, and a line the opponent never ends.
 *
 * Both engines are exercised heavily on positions where they succeed and almost
 * never on the ones where they run out of options — which is the wrong way
 * round, because an opponent returning something invalid instead of nothing is
 * how a validation run turns into an illegal move nobody can explain.
 *
 * The last test uses a stub engine deliberately. What it checks is not
 * reachable through either shipped game, and that is exactly why the guard
 * needs a test: it exists so a future engine, or a rule change making an extra
 * turn unconditional, cannot hang the content pipeline. A CI job that never
 * returns is killed with no message.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bentengEngine,
  checkGreedyTrap,
  congklakEngine,
  solve,
  verifyLine,
} from '../dist/index.js';
import { rankMove as congklakRank } from '../dist/rules/congklak/ai.js';
import { rankMove as bentengRank, evaluate as bentengEvaluate } from '../dist/rules/benteng/ai.js';
import type { Mission } from '../dist/types/mission.js';
import type { BentengState, CongklakState } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Opponents at the edges
// ---------------------------------------------------------------------------

const EMPTY_CONGKLAK = congklakEngine.init(
  { game: 'congklak', pits: [0, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0], playerSide: 1, toMove: 1 } as never,
  {} as never,
) as CongklakState;

describe('the Congklak opponent', () => {
  test('returns nothing when there is nothing to play', () => {
    // Null rather than a thrown error or an illegal move: the caller decides
    // what an exhausted side means, and for the solver it means the line ends.
    for (const tier of ['mudah', 'sedang', 'sulit'] as const) {
      assert.equal(congklakEngine.aiMove(EMPTY_CONGKLAK as never, tier, 7), null);
    }
  });

  test('ranks nothing when the move is not among the legal ones', () => {
    const board = congklakEngine.init(
      { game: 'congklak', pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3], playerSide: 1, toMove: 1 } as never,
      {} as never,
    );

    // Pit 1 is the opponent's row: not a legal choice, so it has no rank rather
    // than rank zero. Rank zero would read as "the best available move".
    assert.equal(congklakRank(board as never, { kind: 'sow', pit: 1 } as never), null);

    const ranked = congklakRank(board as never, { kind: 'sow', pit: 7 } as never);
    assert.ok(ranked !== null && ranked >= 0);
  });

  test('every tier picks a legal move on a normal board', () => {
    const board = congklakEngine.init(
      { game: 'congklak', pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3], playerSide: 1, toMove: 1 } as never,
      {} as never,
    );

    for (const tier of ['mudah', 'sedang', 'sulit'] as const) {
      const move = congklakEngine.aiMove(board as never, tier, 42);
      assert.ok(move, `${tier} found no move`);
      assert.equal(congklakEngine.isLegal(board as never, move), true, `${tier} chose an illegal move`);
    }
  });

  test('the same tier and seed always choose the same move', () => {
    // The property the whole replay-validation design rests on: if the opponent
    // were not reproducible, no single-player attempt could be verified at all.
    const board = congklakEngine.init(
      { game: 'congklak', pits: [0, 2, 4, 1, 3, 3, 0, 5, 1, 2, 3, 1], playerSide: 1, toMove: 2 } as never,
      {} as never,
    );

    for (const tier of ['mudah', 'sedang', 'sulit'] as const) {
      assert.deepEqual(
        congklakEngine.aiMove(board as never, tier, 99),
        congklakEngine.aiMove(board as never, tier, 99),
      );
    }
  });

  test('a different seed can change the easy tier’s choice but never its legality', () => {
    const board = congklakEngine.init(
      { game: 'congklak', pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3], playerSide: 1, toMove: 1 } as never,
      {} as never,
    );

    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const move = congklakEngine.aiMove(board as never, 'mudah', seed);
      assert.ok(move && congklakEngine.isLegal(board as never, move));
    }
  });
});

describe('the Benteng opponent', () => {
  const grid = (units: unknown[], toMove: 1 | 2 = 2) =>
    bentengEngine.init(
      {
        game: 'benteng',
        width: 5,
        height: 5,
        bases: [
          { side: 1, x: 2, y: 4 },
          { side: 2, x: 2, y: 0 },
        ],
        units,
        toMove,
      } as never,
      { freshnessWindow: 0 } as never,
    ) as BentengState;

  test('returns nothing when it has no units left', () => {
    const routed = grid([{ id: 'p1', side: 1, x: 2, y: 3 }], 2);
    assert.equal(bentengEngine.aiMove(routed as never, 'sulit', 3), null);
  });

  test('ranks nothing for a move that is not on offer', () => {
    const board = grid([
      { id: 'p1', side: 1, x: 2, y: 3 },
      { id: 'e1', side: 2, x: 2, y: 1 },
    ], 1);

    // Two squares in one step is not a move this game has.
    assert.equal(
      bentengRank(board as never, { kind: 'move', unitId: 'p1', x: 2, y: 1 } as never),
      null,
    );
  });

  test('a finished position is scored by its outcome, not by its material', () => {
    const playing = grid([
      { id: 'p1', side: 1, x: 2, y: 3 },
      { id: 'e1', side: 2, x: 2, y: 1 },
    ]);
    const won = { ...playing, finished: true, outcome: 'won' as const };

    assert.ok(bentengEvaluate(won as never, 1) > bentengEvaluate(playing as never, 1));
  });
});

// ---------------------------------------------------------------------------
// A line the opponent never lets finish
// ---------------------------------------------------------------------------

const STUB_MISSION: Mission = {
  id: 'congklak.m01',
  game: 'congklak',
  rank: 1,
  contentVersion: 1,
  skillWeights: { 'comp.counting': 1 },
  eloDifficulty: 700,
  goal: { kind: 'collect', count: 5 },
  setup: { game: 'congklak', pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3], playerSide: 1, toMove: 1 },
  constraints: { maxMoves: 10, aiTier: 'sedang' },
  config: {},
  seed: 1,
  rationale: 'Sowing seeds one at a time from a chosen pit.',
  titleKey: 'x',
  briefKey: 'x',
  hintKeys: [],
  failureKeys: { ranOut: 'x' },
};

test('a line is abandoned when the opponent never gives the turn back', () => {
  // Not reachable through either shipped engine, which is exactly why it needs a
  // stub: the guard exists so a future engine — or a rule change that makes an
  // extra turn unconditional — cannot hang the content pipeline. A validation
  // run that never returns is a CI job that is killed with no message.
  let calls = 0;
  const engine = {
    gameId: 'congklak',
    version: '1.0.0',
    init: () => ({}),
    legalMoves: () => [{ kind: 'sow', pit: 7 }],
    isLegal: () => true,
    applyMove: (state: unknown) => ({ state, events: [] }),
    evaluateGoal: () => ({ achieved: false, terminal: false, progress: 0 }),
    // Always the opponent's turn, and it always has a move.
    sideToMove: () => 2 as const,
    playerSide: () => 1 as const,
    aiMove: () => {
      calls += 1;
      return { kind: 'sow', pit: 1 };
    },
    hash: () => 'constant',
    parseMove: (value: unknown) => value,
    movesEqual: () => true,
    rankMove: () => null,
    isGreedyMove: () => false,
  };

  const result = verifyLine(engine as never, STUB_MISSION, [{ kind: 'sow', pit: 7 }]);

  assert.equal(result.achieved, false);
  assert.match(result.reason ?? '', /never yielded/);
  assert.equal(result.failedAtMove, 0);
  // Bounded, rather than merely reported — the guard has to stop, not describe.
  assert.ok(calls < 200, `the opponent was consulted ${calls} times`);
});

/**
 * A minimal engine whose behaviour each test dictates.
 *
 * Used only for paths no shipped game can reach. Those paths are guards — the
 * things that stop a validation run from hanging or from crediting a line the
 * rules ended early — and a guard nothing exercises is a guard nobody knows is
 * broken until it is load-bearing.
 */
function stubEngine(over: Record<string, unknown> = {}) {
  return {
    gameId: 'congklak',
    version: '1.0.0',
    init: () => ({ n: 0 }),
    legalMoves: () => [{ kind: 'sow', pit: 7 }],
    isLegal: () => true,
    applyMove: (state: { n: number }) => ({ state: { n: state.n + 1 }, events: [] }),
    evaluateGoal: () => ({ achieved: false, terminal: false, progress: 0 }),
    sideToMove: () => 1 as const,
    playerSide: () => 1 as const,
    aiMove: () => ({ kind: 'sow', pit: 1 }),
    hash: (state: { n: number }) => `h${state.n}`,
    parseMove: (value: unknown) => value,
    movesEqual: () => true,
    rankMove: () => null,
    isGreedyMove: () => false,
    ...over,
  } as never;
}

test('a line is refused when the mission ends before it does', () => {
  // Not the same as losing. The line and the mission's goal disagree about when
  // it was over, which means the author is describing a different mission from
  // the one that shipped.
  let calls = 0;
  const engine = stubEngine({
    evaluateGoal: () => {
      calls += 1;
      return { achieved: false, terminal: calls > 1, progress: 0 };
    },
  });

  const result = verifyLine(engine, STUB_MISSION, [
    { kind: 'sow', pit: 7 },
    { kind: 'sow', pit: 8 },
  ]);

  assert.equal(result.achieved, false);
  assert.match(result.reason ?? '', /ended before the line/);
});

test('a line whose move the engine cannot read is refused at that move', () => {
  const result = verifyLine(stubEngine({ parseMove: () => null }), STUB_MISSION, [
    { kind: 'sow', pit: 7 },
  ]);

  assert.equal(result.achieved, false);
  assert.equal(result.failedAtMove, 0);
});

test('a search is bounded when the opponent never gives the turn back', () => {
  // The same guard as the line verifier's, in the solver. Without it a mission
  // whose opponent always takes another turn would spin inside CI rather than
  // failing, and the job would be killed with no message about which mission.
  let replies = 0;
  const engine = stubEngine({
    sideToMove: () => 2 as const,
    aiMove: () => {
      replies += 1;
      return { kind: 'sow', pit: 1 };
    },
  });

  const result = solve(engine, STUB_MISSION, { maxDepth: 2, maxNodes: 20 });

  assert.equal(result.solvable, false);
  assert.ok(replies > 0 && replies < 5000, `the opponent was consulted ${replies} times`);
});

test('a search ends rather than looping when the opponent runs out of moves', () => {
  const engine = stubEngine({ sideToMove: () => 2 as const, aiMove: () => null });
  const result = solve(engine, STUB_MISSION, { maxDepth: 3, maxNodes: 100 });

  assert.equal(result.solvable, false);
});

test('a trap probe refuses an opening the rules do not allow', () => {
  // `checkGreedyTrap` probes each opening independently, so an opening that is
  // offered but not legal must score as "does not win" rather than throwing
  // half way through a content run.
  const engine = stubEngine({
    isLegal: () => false,
    isGreedyMove: (_state: unknown, move: { pit: number }) => move.pit === 7,
    legalMoves: () => [
      { kind: 'sow', pit: 7 },
      { kind: 'sow', pit: 8 },
    ],
    movesEqual: (a: { pit: number }, b: { pit: number }) => a.pit === b.pit,
  });

  const result = checkGreedyTrap(engine, STUB_MISSION, { maxDepth: 2, maxNodes: 50 });

  assert.equal(result.isTrap, false);
  assert.equal(result.greedyMoveWins, false);
  assert.equal(result.alternativeWins, false);
});

test('a position already lost at the opening is not a winnable trap', () => {
  const engine = stubEngine({
    evaluateGoal: () => ({ achieved: false, terminal: true, progress: 0 }),
    isGreedyMove: (_state: unknown, move: { pit: number }) => move.pit === 7,
    legalMoves: () => [
      { kind: 'sow', pit: 7 },
      { kind: 'sow', pit: 8 },
    ],
    movesEqual: (a: { pit: number }, b: { pit: number }) => a.pit === b.pit,
  });

  const result = checkGreedyTrap(engine, STUB_MISSION, { maxDepth: 2, maxNodes: 50 });
  assert.equal(result.isTrap, false);
  assert.match(result.reason, /no opening wins/);
});

test('an opening that wins immediately is recognised without searching', () => {
  const engine = stubEngine({
    evaluateGoal: () => ({ achieved: true, terminal: true, progress: 1 }),
    isGreedyMove: (_state: unknown, move: { pit: number }) => move.pit === 7,
    legalMoves: () => [
      { kind: 'sow', pit: 7 },
      { kind: 'sow', pit: 8 },
    ],
    movesEqual: (a: { pit: number }, b: { pit: number }) => a.pit === b.pit,
  });

  const result = checkGreedyTrap(engine, STUB_MISSION, { maxDepth: 2, maxNodes: 50 });
  assert.equal(result.greedyMoveWins, true);
  assert.equal(result.alternativeWins, true);
  assert.equal(result.isTrap, false);
});

test('a search that keeps finding new positions stops at its depth limit', () => {
  // Every move reaches a position never seen before, so the transposition table
  // never prunes and only the depth limit ends it.
  let n = 0;
  const engine = stubEngine({
    hash: () => `unique-${n++}`,
    legalMoves: () => [
      { kind: 'sow', pit: 7 },
      { kind: 'sow', pit: 8 },
    ],
  });

  const result = solve(engine, STUB_MISSION, { maxDepth: 3, maxNodes: 100_000 });
  assert.equal(result.solvable, false);
  assert.equal(result.exhausted, false);
  assert.ok(result.nodesVisited > 0);
});

test('positions already seen are not expanded twice', () => {
  // The transposition check. On a twelve-pit board distinct move orders reach
  // the same position constantly, and without this the search is exponential
  // in a way that would put content validation past any CI budget.
  const engine = stubEngine({
    hash: () => 'always-the-same',
    legalMoves: () => [
      { kind: 'sow', pit: 7 },
      { kind: 'sow', pit: 8 },
    ],
  });

  const result = solve(engine, STUB_MISSION, { maxDepth: 6, maxNodes: 100_000 });
  assert.ok(result.nodesVisited <= 4, `expanded ${result.nodesVisited} identical positions`);
});
