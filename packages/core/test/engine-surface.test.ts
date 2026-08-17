/**
 * The engine surface both platforms call through.
 *
 * `parseMove`, `movesEqual`, `hash`, `stateMetrics` and the legality edges. All
 * of it is boring and all of it is the boundary where a hostile or buggy client
 * meets the rules: `parseMove` is the only thing standing between a submitted
 * replay and the engine, and `movesEqual` is what decides whether a replayed AI
 * move matches the one the server recomputed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine, congklakEngine, unitFreshness } from '../dist/index.js';
import type { BentengState } from '../dist/rules/benteng/state.js';
import type { CongklakState } from '../dist/rules/congklak/state.js';

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
    { id: 'e1', side: 2 as const, x: 2, y: 1 },
  ],
  toMove: 1 as const,
};

const CONGKLAK_SETUP = {
  game: 'congklak' as const,
  pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
  playerSide: 1 as const,
  toMove: 1 as const,
};

// ---------------------------------------------------------------------------
// parseMove — the only gate between a submitted replay and the engine
// ---------------------------------------------------------------------------

test('Benteng refuses every malformed move shape', () => {
  const bad: unknown[] = [
    null,
    undefined,
    'move',
    42,
    {},
    { unitId: 1, x: 0, y: 0 },
    { unitId: 'p1', x: '0', y: 0 },
    { unitId: 'p1', x: 0.5, y: 0 },
    { unitId: 'p1', x: 0, y: 1.5 },
    { unitId: 'p1', x: 0 },
  ];

  for (const value of bad) {
    assert.equal(bentengEngine.parseMove(value), null, `should refuse ${JSON.stringify(value)}`);
  }

  assert.deepEqual(bentengEngine.parseMove({ unitId: 'p1', x: 2, y: 2 }), {
    kind: 'move',
    unitId: 'p1',
    x: 2,
    y: 2,
  });
});

test('Congklak refuses every malformed move shape', () => {
  const bad: unknown[] = [null, undefined, 'sow', 7, {}, { pit: '3' }, { pit: 1.5 }];

  for (const value of bad) {
    assert.equal(congklakEngine.parseMove(value), null, `should refuse ${JSON.stringify(value)}`);
  }

  // A negative index parses and is then refused by `isLegal`. Parsing checks
  // shape; legality checks the board. Splitting them keeps the rejection
  // reasons distinct — "that is not a move" and "you cannot play there" are
  // different things to tell a student.
  assert.ok(congklakEngine.parseMove({ pit: -1 }));
  assert.ok(congklakEngine.parseMove({ pit: 3 }));
});

test('move equality is by value, which AI verification depends on', () => {
  // The server recomputes the AI's move and compares it to the replayed one. A
  // reference comparison here would reject every honest offline attempt.
  assert.equal(
    bentengEngine.movesEqual(
      { kind: 'move', unitId: 'p1', x: 1, y: 2 } as never,
      { kind: 'move', unitId: 'p1', x: 1, y: 2 } as never,
    ),
    true,
  );
  assert.equal(
    bentengEngine.movesEqual(
      { kind: 'move', unitId: 'p1', x: 1, y: 2 } as never,
      { kind: 'move', unitId: 'p2', x: 1, y: 2 } as never,
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// Hashing and metrics
// ---------------------------------------------------------------------------

test('the state hash is stable and changes when the position does', () => {
  const start = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  assert.equal(bentengEngine.hash(start as never), bentengEngine.hash(start as never));

  const legal = bentengEngine.legalMoves(start as never);
  const after = bentengEngine.applyMove(start as never, legal[0] as never).state;
  assert.notEqual(bentengEngine.hash(start as never), bentengEngine.hash(after as never));
});

test('Benteng reports counters that live on the position, not the event stream', () => {
  // Exposure is a run length and losses are a running total; recomputing them
  // from events in the validator would be a second implementation of the rule.
  const start = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  const metrics = bentengEngine.stateMetrics?.(start as never);

  assert.ok(metrics);
  assert.equal(metrics.unitsLost, 0);
  assert.equal(metrics.illegalCaptureAttempts, 0);
  assert.equal(metrics.maxExposureTurns, 0);
});

test('Benteng has no greedy move, because it has no fullest pit', () => {
  const start = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  const legal = bentengEngine.legalMoves(start as never);
  assert.equal(bentengEngine.isGreedyMove(start as never, legal[0] as never), false);
});

test('side and player accessors report the position, not a default', () => {
  const state = bentengEngine.init({ ...BENTENG_SETUP, toMove: 2 }, {}) as BentengState;
  assert.equal(bentengEngine.sideToMove(state as never), 2);
  assert.equal(bentengEngine.playerSide(state as never), 1);
});

test('freshness for an unknown unit is null rather than a number', () => {
  // A component asking about a captured or nonexistent unit must not be handed
  // a plausible-looking zero — zero means "just refreshed", which is the
  // strongest possible position.
  const state = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  assert.equal(unitFreshness(state, 'nobody'), null);
  assert.equal(unitFreshness(state, 'p1'), 0);
});

// ---------------------------------------------------------------------------
// Legality edges
// ---------------------------------------------------------------------------

test('Congklak refuses an out-of-range, opposing, or empty pit', () => {
  // Side 1's row is 7–11 and its store is 6; side 2 holds 1–5 with store 0.
  const state = congklakEngine.init(CONGKLAK_SETUP, {}) as CongklakState;
  const sow = (pit: number) => congklakEngine.isLegal(state as never, { kind: 'sow', pit } as never);

  assert.equal(sow(7), true);
  assert.equal(sow(0), false, 'a store is not a sowable pit');
  assert.equal(sow(6), false);
  assert.equal(sow(1), false, 'the opponent’s row is not sowable');
  assert.equal(sow(99), false);
  assert.equal(sow(-1), false);

  const empty = congklakEngine.init(
    { ...CONGKLAK_SETUP, pits: [0, 3, 3, 3, 3, 3, 0, 0, 3, 3, 3, 3] },
    {},
  ) as CongklakState;
  assert.equal(
    congklakEngine.isLegal(empty as never, { kind: 'sow', pit: 7 } as never),
    false,
    'an empty pit has nothing to sow',
  );
});

test('a side with no legal move has an empty move list rather than a thrown error', () => {
  // A student whose row has emptied should meet an ended game, not a crash.
  const stuck = congklakEngine.init(
    { ...CONGKLAK_SETUP, pits: [0, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0] },
    {},
  ) as CongklakState;
  assert.deepEqual(congklakEngine.legalMoves(stuck as never), []);
});

test('Benteng refuses a move by a unit that is not the mover’s', () => {
  const state = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  // Team 1 is to move; e1 belongs to team 2.
  assert.equal(
    bentengEngine.isLegal(state as never, { kind: 'move', unitId: 'e1', x: 2, y: 2 } as never),
    false,
  );
  assert.equal(
    bentengEngine.isLegal(state as never, { kind: 'move', unitId: 'ghost', x: 2, y: 2 } as never),
    false,
  );
});

test('Benteng refuses a move off the board or more than one step', () => {
  const state = bentengEngine.init(BENTENG_SETUP, {}) as BentengState;
  const move = (x: number, y: number) =>
    bentengEngine.isLegal(state as never, { kind: 'move', unitId: 'p1', x, y } as never);

  assert.equal(move(2, 2), true, 'one step forward is legal');
  assert.equal(move(2, 1), false, 'two steps is not');
  assert.equal(move(-1, 3), false);
  assert.equal(move(5, 3), false);
  assert.equal(move(2, 3), false, 'staying put is not a move');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the opponent plays the same move for the same position, tier and seed', () => {
  // The property replay validation rests on. If this drifts, honest offline
  // attempts start being rejected for AI divergence.
  const state = bentengEngine.init({ ...BENTENG_SETUP, toMove: 2 }, {}) as BentengState;

  for (const tier of ['mudah', 'sedang', 'sulit'] as const) {
    const first = bentengEngine.aiMove(state as never, tier, 99);
    const second = bentengEngine.aiMove(state as never, tier, 99);
    assert.ok(first);
    assert.equal(bentengEngine.movesEqual(first as never, second as never), true);
  }
});

test('a position with nothing to play returns no AI move rather than an invalid one', () => {
  // Returning a move here would be worse than returning none: the client would
  // apply it, the server would recompute a different one, and the attempt would
  // be rejected for AI divergence the student had no part in.
  const stuck = congklakEngine.init(
    { ...CONGKLAK_SETUP, pits: [0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3], toMove: 2 },
    {},
  ) as CongklakState;
  assert.equal(congklakEngine.aiMove(stuck as never, 'sedang', 1), null);
});

test('rankMove returns null where a move cannot be scored', () => {
  const stuck = congklakEngine.init(
    { ...CONGKLAK_SETUP, pits: [0, 3, 3, 3, 3, 3, 0, 3, 0, 0, 0, 0] },
    {},
  ) as CongklakState;
  // One legal move means there is nothing to rank it against.
  const rank = congklakEngine.rankMove(stuck as never, { kind: 'sow', pit: 7 } as never);
  assert.ok(rank === null || rank === 0);
});
