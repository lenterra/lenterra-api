/**
 * The last rejections in the replay validator, and two Benteng setups nothing
 * had constructed.
 *
 * Every one of these decides whether a student's work counts. A validator that
 * accepts a fabricated replay hands out points for play that never happened; one
 * that rejects an honest replay tells a child they cheated. Both are visible to
 * a teacher as numbers that cannot be right, and neither announces itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REPLAY_MOVES,
  bentengEngine,
  congklakEngine,
  hashConfig,
  recordReplay,
  ReplayRecorder,
  validateReplay,
} from '../dist/index.js';
import { gridIndex, currentExposure } from '../dist/rules/benteng/moves.js';
import type { Mission } from '../dist/types/mission.js';
import type { BentengState, Replay } from '../dist/index.js';

const MISSION: Mission = {
  id: 'congklak.m02',
  game: 'congklak',
  rank: 2,
  contentVersion: 1,
  skillWeights: { 'comp.counting': 1 },
  eloDifficulty: 850,
  goal: { kind: 'collect', count: 2 },
  setup: {
    game: 'congklak',
    pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
    playerSide: 1,
    toMove: 1,
  },
  constraints: { maxMoves: 20, aiTier: 'sedang' },
  config: { extraTurnOnStore: true, captureEnabled: true, continuationEnabled: true },
  seed: 5,
  rationale: 'Counting seeds in a pit and predicting where the last one lands.',
  titleKey: 'x',
  briefKey: 'x',
  hintKeys: [],
  failureKeys: { ranOut: 'x' },
};

function honest(): Replay {
  return recordReplay(congklakEngine as never, MISSION, [
    { move: { kind: 'sow', pit: 7 } as never, actor: 'player', elapsedMs: 1400 },
  ]);
}

test('a replay longer than the cap is malformed, not merely long', () => {
  // A bound rather than a budget: 2,000 moves is far past any real game, and
  // without the cap a single crafted submission could occupy the VM every other
  // request in a classroom is queued behind.
  const bloated: Replay = {
    ...honest(),
    moves: new Array(MAX_REPLAY_MOVES + 1).fill({ seq: 0, actor: 'player', move: { kind: 'sow', pit: 7 }, atMs: 0 }),
  };

  const result = validateReplay(bloated, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'too_many_moves');
});

test('a move on the opponent’s row is refused as illegal', () => {
  const replay = honest();
  const tampered: Replay = {
    ...replay,
    moves: [{ ...(replay.moves[0] as object), move: { kind: 'sow', pit: 2 } } as never],
  };

  const result = validateReplay(tampered, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'illegal_move');
});

test('a solo replay claiming a human opponent is refused', () => {
  // The hole this closes: if the label were accepted, a client could hand
  // itself an opponent that plays badly on purpose and every mission in both
  // ladders would be winnable.
  // A goal far enough away that play does not end after one move, and a real
  // opponent reply to relabel — the attack is turning `ai` into `opponent`, so
  // there has to be an `ai` move in the replay to begin with.
  const twoMoveMission: Mission = { ...MISSION, goal: { kind: 'collect', count: 12 } };
  const recorder = new ReplayRecorder(congklakEngine as never, twoMoveMission);

  recorder.play({ kind: 'sow', pit: 8 } as never, 'player', 1400);
  const reply = recorder.aiMove();
  assert.ok(reply, 'the fixture needs the opponent to have a reply');
  recorder.play(reply, 'ai', 2900);

  const replay = recorder.finish();
  assert.equal(replay.moves.length, 2);
  assert.equal(replay.moves[1]?.actor, 'ai');

  const relabelled: Replay = {
    ...replay,
    moves: replay.moves.map((move, i) => (i === 1 ? { ...move, actor: 'opponent' } : move)) as never,
  };

  const solo = validateReplay(relabelled, twoMoveMission, congklakEngine as never);
  assert.equal(solo.valid, false);
  assert.equal(solo.valid === false && solo.reason, 'ai_divergence');

  // Declared hot-seat, the same replay is a second person taking their turn —
  // replayed and validated, but never scored as the account holder's evidence.
  const hotSeat = validateReplay(relabelled, twoMoveMission, congklakEngine as never, true);
  assert.equal(hotSeat.valid, true, hotSeat.valid ? '' : hotSeat.reason);
  assert.ok(
    hotSeat.valid && hotSeat.derivedMetrics.playerMoveCount < relabelled.moves.length,
    'a guest’s move was counted as the student’s',
  );
});

test('an edited final-state hash is refused even though every move is legal', () => {
  const replay = honest();
  const lying: Replay = { ...replay, finalStateHash: `${replay.finalStateHash.slice(0, -1)}0` };

  const result = validateReplay(lying, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'replay_mismatch');
});

test('a config hash covers the setup as well as the rules', () => {
  // Two missions with identical toggles and different boards must not share a
  // hash, or a replay played on one could be validated against the other.
  const moved: Mission = {
    ...MISSION,
    setup: { ...MISSION.setup, pits: [0, 4, 3, 3, 3, 3, 0, 3, 3, 3, 3, 2] } as never,
  };

  assert.notEqual(hashConfig(MISSION), hashConfig(moved));
});

// ---------------------------------------------------------------------------
// Benteng setups
// ---------------------------------------------------------------------------

const GRID = {
  game: 'benteng' as const,
  width: 5,
  height: 5,
  bases: [
    { side: 1 as const, x: 2, y: 4 },
    { side: 2 as const, x: 2, y: 0 },
  ],
  toMove: 1 as const,
};

test('a setup that starts with a unit already captured places it at its captor’s base', () => {
  // A mid-game position an author can write directly, so a rank can teach
  // recovery rather than always opening from a clean board. The captured unit
  // has to be held somewhere the board can render.
  const state = bentengEngine.init(
    {
      ...GRID,
      units: [
        { id: 'p1', side: 1, x: 1, y: 3 },
        { id: 'p2', side: 1, x: 3, y: 3, captured: true },
        { id: 'e1', side: 2, x: 2, y: 1 },
      ],
    } as never,
    { freshnessWindow: 0 } as never,
  ) as BentengState;

  assert.equal(state.prisoners.length, 1);
  assert.equal(state.prisoners[0]?.unitId, 'p2');
  assert.equal(state.prisoners[0]?.heldBy, 2);

  // Moved to the captor's base rather than left where it fell.
  const held = state.units.filter((unit) => unit.id === 'p2')[0];
  assert.equal(held?.x, 2);
  assert.equal(held?.y, 0);

  // And it is not available to move.
  const moves = bentengEngine.legalMoves(state as never) as { unitId: string }[];
  assert.equal(moves.some((move) => move.unitId === 'p2'), false);
});

test('a captured unit counts against the side that lost it', () => {
  const state = bentengEngine.init(
    {
      ...GRID,
      units: [
        { id: 'p1', side: 1, x: 1, y: 3 },
        { id: 'e1', side: 2, x: 2, y: 1, captured: true },
        { id: 'e2', side: 2, x: 3, y: 1 },
      ],
    } as never,
    { freshnessWindow: 0 } as never,
  ) as BentengState;

  // Indexed by the team that lost the unit, not the one that took it — the
  // metric a teacher reads is "how many did this student lose".
  assert.equal(state.unitsLostBy[1], 1);
  assert.equal(state.unitsLostBy[0], 0);
});

test('the flat cell index addresses squares the way the animation expects', () => {
  // Used only in events, so a wrong index is not a crash — it is a seed
  // animating into the wrong square, which reads as the game being buggy.
  const state = bentengEngine.init(
    { ...GRID, units: [{ id: 'p1', side: 1, x: 1, y: 3 }] } as never,
    { freshnessWindow: 0 } as never,
  ) as BentengState;

  assert.equal(gridIndex(state as never, 0, 0), 0);
  assert.equal(gridIndex(state as never, 4, 0), 4);
  assert.equal(gridIndex(state as never, 0, 1), state.width);
  assert.equal(gridIndex(state as never, 2, 3), 3 * state.width + 2);

  // Nothing has been exposed yet on a fresh board.
  assert.equal(currentExposure(state as never), state.maxExposureTurns);
});
