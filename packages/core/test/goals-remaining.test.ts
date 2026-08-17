/**
 * The goal kinds and AI paths the other suites did not reach.
 *
 * `clear_row`, `predict_landing`, `no_exposure` and `best_move` are the four
 * Congklak goals used only by later missions, so nothing exercised them until
 * a student got that far. `rankMove` is what turns a student's choice into the
 * `optimalMoveRank` a teacher reads — a metric nobody had ever asserted on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine, congklakEngine } from '../dist/index.js';
import type { BentengState } from '../dist/rules/benteng/state.js';
import type { CongklakState } from '../dist/rules/congklak/state.js';
import type { MissionGoal } from '../dist/types/mission.js';

const SETUP = {
  game: 'congklak' as const,
  pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
  playerSide: 1 as const,
  toMove: 1 as const,
};

function state(overrides: Partial<CongklakState> = {}): CongklakState {
  return { ...(congklakEngine.init(SETUP, {}) as CongklakState), ...overrides };
}

const evaluate = (s: CongklakState, goal: MissionGoal) =>
  congklakEngine.evaluateGoal(s as never, goal);

test('clear_row is met when the student’s own row is empty', () => {
  // Side 1 holds pits 7–11. Emptying the opponent's row is not this goal.
  const cleared = state({ pits: [0, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0] });
  const result = evaluate(cleared, { kind: 'clear_row' });
  assert.equal(result.achieved, true);
  // Terminal on achievement even mid-game: there is nothing left to play.
  assert.equal(result.terminal, true);

  const theirs = state({ pits: [0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3] });
  assert.equal(evaluate(theirs, { kind: 'clear_row' }).achieved, false);
});

test('predict_landing counts correct predictions and reports progress', () => {
  const half = evaluate(state({ correctPredictions: 1 }), { kind: 'predict_landing', count: 2 });
  assert.equal(half.achieved, false);
  assert.equal(half.progress, 0.5);

  assert.equal(
    evaluate(state({ correctPredictions: 3 }), { kind: 'predict_landing', count: 2 }).achieved,
    true,
  );
});

test('no_exposure holds until it is broken, and then cannot be recovered', () => {
  const clean = evaluate(state({ exposureTurns: 0 }), { kind: 'no_exposure' });
  assert.equal(clean.achieved, true);
  assert.equal(clean.terminal, false, 'the student can still break it by playing on');

  const broken = evaluate(state({ exposureTurns: 2 }), { kind: 'no_exposure' });
  assert.equal(broken.achieved, false);
  assert.equal(broken.terminal, true, 'an exposed pit cannot be un-exposed');
});

test('best_move tolerates exactly the slack it was authored with', () => {
  // maxRank 0 means every move had to be the best available; 1 allows one step
  // down. The default is the strict reading.
  assert.equal(evaluate(state({ worstMoveRank: 0 }), { kind: 'best_move' }).achieved, true);
  assert.equal(evaluate(state({ worstMoveRank: 1 }), { kind: 'best_move' }).achieved, false);
  assert.equal(
    evaluate(state({ worstMoveRank: 1 }), { kind: 'best_move', maxRank: 1 }).achieved,
    true,
  );
  assert.equal(
    evaluate(state({ worstMoveRank: 2 }), { kind: 'best_move', maxRank: 1 }).achieved,
    false,
  );
});

test('a Benteng goal on a Congklak board is unmet rather than thrown', () => {
  for (const goal of [
    { kind: 'reach_base' },
    { kind: 'capture_units', count: 1 },
    { kind: 'survive', turns: 5 },
    { kind: 'defend_base', turns: 5 },
  ] as MissionGoal[]) {
    const result = evaluate(state(), goal);
    assert.equal(result.achieved, false);
    assert.equal(result.progress, 0);
  }
});

test('a capture goal counts what the student captured, not the opponent', () => {
  // capturedBy is indexed by the side that did the capturing, and side 1 sits
  // in slot 0. Reading the wrong slot would credit a student for the machine's
  // captures.
  assert.equal(evaluate(state({ capturedBy: [5, 0] }), { kind: 'capture', count: 8 }).achieved, false);
  assert.equal(evaluate(state({ capturedBy: [9, 0] }), { kind: 'capture', count: 8 }).achieved, true);
  assert.equal(evaluate(state({ capturedBy: [0, 9] }), { kind: 'capture', count: 8 }).achieved, false);
});

test('a compound Congklak goal needs every part', () => {
  const goal: MissionGoal = {
    kind: 'all',
    goals: [{ kind: 'collect', count: 1 }, { kind: 'no_exposure' }],
  };

  const both = state({ pits: [0, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3], exposureTurns: 0 });
  assert.equal(evaluate(both, goal).achieved, true);

  const exposed = state({ pits: [0, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3], exposureTurns: 3 });
  assert.equal(evaluate(exposed, goal).achieved, false);
});

// ---------------------------------------------------------------------------
// Move ranking
// ---------------------------------------------------------------------------

const BENTENG_SETUP = {
  game: 'benteng' as const,
  width: 5,
  height: 5,
  bases: [
    { side: 1 as const, x: 2, y: 4 },
    { side: 2 as const, x: 2, y: 0 },
  ],
  units: [
    { id: 'p1', side: 1 as const, x: 2, y: 3 },
    { id: 'p2', side: 1 as const, x: 1, y: 3 },
    { id: 'e1', side: 2 as const, x: 2, y: 1 },
  ],
  toMove: 1 as const,
};

test('Benteng ranks every legal move, best first, deterministically', () => {
  // This is what becomes `optimalMoveRank` on a teacher's screen, so it has to
  // be a total order with no ties resolved by chance.
  const start = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  const legal = bentengEngine.legalMoves(start as never);
  assert.ok(legal.length > 1);

  const ranks = legal.map((move) => bentengEngine.rankMove(start as never, move));
  assert.ok(ranks.every((rank) => rank !== null));

  const sorted = ranks.slice().sort((a, b) => (a as number) - (b as number));
  assert.deepEqual(sorted, legal.map((_, index) => index), 'ranks must be a permutation of 0..n-1');

  // Same position, same ranking, every time.
  assert.deepEqual(
    legal.map((move) => bentengEngine.rankMove(start as never, move)),
    ranks,
  );
});

test('ranking a move that is not legal here returns null', () => {
  const start = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  assert.equal(
    bentengEngine.rankMove(start as never, { kind: 'move', unitId: 'e1', x: 2, y: 2 } as never),
    null,
  );
});

test('Congklak ranks the student’s choice against the alternatives', () => {
  const start = congklakEngine.init(SETUP, {}) as CongklakState;
  const legal = congklakEngine.legalMoves(start as never);
  const ranks = legal.map((move) => congklakEngine.rankMove(start as never, move));

  assert.ok(ranks.every((rank) => rank !== null));
  assert.ok(ranks.includes(0), 'some move has to be the best one');
});
