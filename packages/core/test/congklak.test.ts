import { test } from 'node:test';
import assert from 'node:assert/strict';

import { congklakEngine } from '../dist/rules/congklak/index.js';
import type { CongklakState, CongklakMove } from '../dist/index.js';
import type { CongklakSetup, GameConfig, MissionGoal } from '../dist/types/mission.js';

// The demo's board, preserved exactly:
//   index 0      = player 2's store (lumbung)
//   indices 1–5  = player 2's row
//   index 6      = player 1's store
//   indices 7–11 = player 1's row
const START = [0, 7, 7, 7, 7, 7, 0, 7, 7, 7, 7, 7];

function setup(pits: number[], toMove: 1 | 2 = 1, playerSide: 1 | 2 = 1): CongklakSetup {
  return { game: 'congklak', pits: pits.slice(), playerSide, toMove };
}

function init(pits: number[], config: GameConfig = {}, toMove: 1 | 2 = 1): CongklakState {
  return congklakEngine.init(setup(pits, toMove), config) as CongklakState;
}

const PLAIN: GameConfig = {
  extraTurnOnStore: true,
  captureEnabled: false,
  continuationEnabled: false,
  sweepOnEnd: true,
};

// ---------------------------------------------------------------------------
// Characterisation: behaviour the existing implementation already had right
// ---------------------------------------------------------------------------

// Every fixture leaves the opponent at least one seed. A board where the side
// to move has an empty row correctly ends the game and sweeps — which is the
// rule under test elsewhere, and noise here.
test('sowing drops one seed per pit, counter-clockwise', () => {
  // Pit 7 holds 3 seeds → they land in 8, 9, 10.
  const state = init([0, 0, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0], PLAIN);
  const { state: after } = congklakEngine.applyMove(state, { kind: 'sow', pit: 7 });

  assert.deepEqual((after as CongklakState).pits, [0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0]);
});

test("a player skips the opponent's store", () => {
  // Player 1 sows from pit 11 with 3 seeds: 0 is player 2's store and must be
  // skipped, so the seeds land in 1, 2, 3.
  const state = init([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], PLAIN);
  const { state: after } = congklakEngine.applyMove(state, { kind: 'sow', pit: 11 });
  const pits = (after as CongklakState).pits;

  assert.equal(pits[0], 0, "player 1 must not seed player 2's store");
  assert.deepEqual(pits.slice(1, 4), [1, 1, 1]);
});

test('player 2 skips player 1 store and seeds their own', () => {
  const state = init([0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0], PLAIN, 2);
  const { state: after } = congklakEngine.applyMove(state, { kind: 'sow', pit: 5 });
  const pits = (after as CongklakState).pits;

  assert.equal(pits[6], 0, "player 2 must not seed player 1's store");
  assert.deepEqual(pits.slice(7, 10), [1, 1, 1]);
});

test('landing in your own store earns another turn', () => {
  // From pit 11, index 0 is skipped, so 6 seeds travel 1,2,3,4,5 and land on
  // the store at index 6. Pit 7 keeps seeds so the row is not emptied.
  const state = init([0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 6], PLAIN);
  const result = congklakEngine.applyMove(state, { kind: 'sow', pit: 11 });

  assert.equal((result.state as CongklakState).pits[6], 1, 'last seed reached the store');
  assert.equal(result.turnEnded, false, 'the mover keeps the turn');
  assert.equal((result.state as CongklakState).toMove, 1);
  assert.ok(result.events.some((e) => e.kind === 'extraTurn'));
});

// ---------------------------------------------------------------------------
// The rules the demo was missing
// ---------------------------------------------------------------------------

test('continuation: landing in a non-empty pit picks it up and keeps sowing', () => {
  const state = init([0, 0, 0, 0, 0, 1, 0, 1, 2, 0, 0, 0], {
    ...PLAIN,
    continuationEnabled: true,
  });

  // Pit 7 has 1 seed → lands in pit 8, which holds 2 → now 3, picked up and
  // sown into 9, 10, 11. Pit 11 was empty → lands on 1 seed, chain stops.
  const result = congklakEngine.applyMove(state, { kind: 'sow', pit: 7 });
  const pits = (result.state as CongklakState).pits;

  assert.deepEqual(pits, [0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1]);
  assert.equal((result.state as CongklakState).maxChainBy[0], 1);
  assert.ok(result.events.some((e) => e.kind === 'chain'));
});

test('continuation is disabled when the mission turns it off', () => {
  const state = init([0, 0, 0, 0, 0, 1, 0, 1, 2, 0, 0, 0], PLAIN);
  const result = congklakEngine.applyMove(state, { kind: 'sow', pit: 7 });

  assert.deepEqual((result.state as CongklakState).pits, [0, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0]);
  assert.equal((result.state as CongklakState).maxChainBy[0], 0);
});

test('capture: an empty own-side pit takes the opposite pit', () => {
  // Player 1 sows 1 seed from pit 7 into pit 8, which is empty and theirs.
  // Pit 8's opposite is 12 − 8 = 4, holding 5 seeds.
  const state = init([0, 0, 0, 0, 5, 0, 0, 1, 0, 0, 0, 0], {
    ...PLAIN,
    captureEnabled: true,
  });

  const result = congklakEngine.applyMove(state, { kind: 'sow', pit: 7 });
  const after = result.state as CongklakState;

  assert.equal(after.pits[4], 0, 'the opposite pit is emptied');
  assert.equal(after.pits[8], 0, 'the landing pit is emptied');
  assert.equal(after.pits[6], 6, 'captured seeds plus the sown one reach the store');
  assert.equal(after.capturedBy[0], 6);
  assert.ok(result.events.some((e) => e.kind === 'capture'));
});

test('capture does not fire against an empty opposite pit', () => {
  const state = init([0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0], {
    ...PLAIN,
    captureEnabled: true,
  });
  const after = congklakEngine.applyMove(state, { kind: 'sow', pit: 7 }).state as CongklakState;

  assert.equal(after.pits[8], 1, 'the seed stays where it landed');
  assert.equal(after.capturedBy[0], 0);
});

test('capture does not fire on the opponent side', () => {
  // Player 1 sowing 2 seeds from pit 11 lands in pit 2 (0 is skipped), which is
  // empty but belongs to player 2.
  const state = init([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], {
    ...PLAIN,
    captureEnabled: true,
  });
  const after = congklakEngine.applyMove(state, { kind: 'sow', pit: 11 }).state as CongklakState;

  assert.equal(after.pits[2], 1);
  assert.equal(after.capturedBy[0], 0);
});

test('the game ends when the player to move has no seeds, and the rest is swept', () => {
  // Player 1 plays their last seeds into their store, earning another turn
  // with an empty row → the game ends and player 2's row sweeps to their store.
  // Sowing adds one seed to each of pits 1–5, so player 2 sweeps 4+1, 3+1,
  // 0+1, 0+1, 0+1 = 12.
  const state = init([0, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 6], PLAIN);
  const result = congklakEngine.applyMove(state, { kind: 'sow', pit: 11 });
  const after = result.state as CongklakState;

  assert.equal(after.finished, true);
  assert.equal(after.pits[0], 12, "player 2's remaining seeds swept into their store");
  assert.deepEqual(after.pits.slice(1, 6), [0, 0, 0, 0, 0]);
  assert.ok(result.events.some((e) => e.kind === 'sweep'));
  assert.ok(result.events.some((e) => e.kind === 'gameEnd'));
});

test('seed conservation holds across a full random game', () => {
  const total = (pits: number[]): number => pits.reduce((a, b) => a + b, 0);
  let state = init(START, {
    extraTurnOnStore: true,
    captureEnabled: true,
    continuationEnabled: true,
    sweepOnEnd: true,
  });
  const expected = total(state.pits);

  for (let i = 0; i < 200 && !state.finished; i++) {
    const move = congklakEngine.aiMove(state, 'sedang', 42);
    if (!move) break;
    state = congklakEngine.applyMove(state, move).state as CongklakState;
    assert.equal(total(state.pits), expected, `seeds were created or destroyed at move ${i}`);
  }
  assert.equal(state.finished, true, 'a full game must terminate');
});

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

test('only non-empty pits in your own row are legal', () => {
  const state = init([0, 7, 0, 7, 7, 7, 0, 0, 3, 0, 5, 0], PLAIN);
  const moves = congklakEngine.legalMoves(state) as CongklakMove[];

  assert.deepEqual(
    moves.map((m) => (m as { pit: number }).pit).sort((a, b) => a - b),
    [8, 10],
  );
  assert.equal(congklakEngine.isLegal(state, { kind: 'sow', pit: 7 }), false, 'empty pit');
  assert.equal(congklakEngine.isLegal(state, { kind: 'sow', pit: 3 }), false, "opponent's pit");
  assert.equal(congklakEngine.isLegal(state, { kind: 'sow', pit: 6 }), false, 'own store');
  assert.equal(congklakEngine.isLegal(state, { kind: 'sow', pit: 99 }), false, 'off the board');
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

test('goal evaluation covers each kind at its boundary', () => {
  const state = init(START, PLAIN);
  state.pits[6] = 5;
  state.capturedBy = [8, 0];
  state.maxChainBy = [4, 0];
  state.extraTurnsBy = [2, 0];
  state.consecutiveExtraBy = [2, 0];
  state.correctPredictions = 1;

  const check = (goal: MissionGoal): boolean => congklakEngine.evaluateGoal(state, goal).achieved;

  assert.equal(check({ kind: 'collect', count: 5 }), true);
  assert.equal(check({ kind: 'collect', count: 6 }), false);
  assert.equal(check({ kind: 'capture', count: 8 }), true);
  assert.equal(check({ kind: 'capture', count: 9 }), false);
  assert.equal(check({ kind: 'chain', count: 4 }), true);
  assert.equal(check({ kind: 'chain', count: 5 }), false);
  assert.equal(check({ kind: 'extra_turns', count: 2, consecutive: true }), true);
  assert.equal(check({ kind: 'extra_turns', count: 3, consecutive: true }), false);
  assert.equal(check({ kind: 'predict_landing', count: 1 }), true);
  assert.equal(check({ kind: 'no_exposure' }), true);
  assert.equal(check({ kind: 'all', goals: [{ kind: 'collect', count: 5 }, { kind: 'chain', count: 4 }] }), true);
  assert.equal(check({ kind: 'all', goals: [{ kind: 'collect', count: 5 }, { kind: 'chain', count: 9 }] }), false);
});

test('a spent move budget is a terminal failure', () => {
  const state = init(START, PLAIN);
  state.playerMoves = 3;

  const goal: MissionGoal = { kind: 'within', moves: 3, goal: { kind: 'collect', count: 99 } };
  const status = congklakEngine.evaluateGoal(state, goal);

  assert.equal(status.achieved, false);
  assert.equal(status.terminal, true, 'the student must be told they ran out of moves');
});

test('outscore is only decidable once the game is over', () => {
  const state = init(START, PLAIN);
  state.pits[6] = 40;
  state.pits[0] = 1;

  assert.equal(congklakEngine.evaluateGoal(state, { kind: 'outscore' }).achieved, false);
  state.finished = true;
  assert.equal(congklakEngine.evaluateGoal(state, { kind: 'outscore' }).achieved, true);
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

test('AI moves are identical across 10,000 repeated calls', () => {
  const state = init(START, PLAIN);
  for (const tier of ['mudah', 'sedang', 'sulit'] as const) {
    const first = congklakEngine.aiMove(state, tier, 12345);
    for (let i = 0; i < 3334; i++) {
      const again = congklakEngine.aiMove(state, tier, 12345);
      assert.deepEqual(again, first, `${tier} diverged on iteration ${i}`);
    }
  }
});

test('a different seed can change the mudah choice but never the strong tiers', () => {
  const state = init(START, PLAIN);
  // sedang and sulit are pure evaluation — the seed must not enter into it, or
  // two servers with different seeds would disagree about a replay.
  assert.deepEqual(
    congklakEngine.aiMove(state, 'sulit', 1),
    congklakEngine.aiMove(state, 'sulit', 999999),
  );
});

test('sulit beats mudah in at least 90% of games', () => {
  let sulitWins = 0;
  const games = 100;

  for (let g = 0; g < games; g++) {
    // Vary the opening so the sample is not one game played 100 times.
    const pits = START.slice();
    pits[7 + (g % 5)] = (pits[7 + (g % 5)] as number) + 1;
    pits[1 + (g % 5)] = (pits[1 + (g % 5)] as number) + 1;

    let state = init(pits, {
      extraTurnOnStore: true,
      captureEnabled: true,
      continuationEnabled: true,
      sweepOnEnd: true,
    });

    for (let i = 0; i < 400 && !state.finished; i++) {
      const tier = state.toMove === 1 ? 'sulit' : 'mudah';
      const move = congklakEngine.aiMove(state, tier, g * 31 + i);
      if (!move) break;
      state = congklakEngine.applyMove(state, move).state as CongklakState;
    }

    if ((state.pits[6] as number) > (state.pits[0] as number)) sulitWins++;
  }

  assert.ok(sulitWins >= games * 0.9, `sulit won ${sulitWins}/${games}`);
});

test('rankMove orders the student choice against the alternatives', () => {
  const state = init([0, 0, 0, 0, 9, 0, 0, 1, 0, 0, 6, 0], {
    ...PLAIN,
    captureEnabled: true,
  });

  const capture = congklakEngine.rankMove(state, { kind: 'sow', pit: 7 });
  const other = congklakEngine.rankMove(state, { kind: 'sow', pit: 10 });

  assert.equal(capture, 0, 'the capture is the best available move');
  assert.ok((other as number) > 0, 'the alternative ranks below it');
});

test('isGreedyMove identifies the fullest pit', () => {
  const state = init([0, 0, 0, 0, 0, 0, 0, 2, 9, 1, 0, 0], PLAIN);
  assert.equal(congklakEngine.isGreedyMove(state, { kind: 'sow', pit: 8 }), true);
  assert.equal(congklakEngine.isGreedyMove(state, { kind: 'sow', pit: 7 }), false);
});

// ---------------------------------------------------------------------------
// Purity and hashing
// ---------------------------------------------------------------------------

test('applyMove never mutates its argument', () => {
  const state = init(START, PLAIN);
  const before = JSON.stringify(state);
  congklakEngine.applyMove(state, { kind: 'sow', pit: 7 });
  assert.equal(JSON.stringify(state), before);
});

test('identical play produces identical hashes', () => {
  const play = (): CongklakState => {
    let state = init(START, PLAIN);
    for (const pit of [7, 8, 9]) {
      if (congklakEngine.isLegal(state, { kind: 'sow', pit })) {
        state = congklakEngine.applyMove(state, { kind: 'sow', pit }).state as CongklakState;
      }
    }
    return state;
  };
  assert.equal(congklakEngine.hash(play()), congklakEngine.hash(play()));
});

test('a single changed seed changes the hash', () => {
  const a = init(START, PLAIN);
  const b = init(START, PLAIN);
  b.pits[3] = (b.pits[3] as number) + 1;
  assert.notEqual(congklakEngine.hash(a), congklakEngine.hash(b));
});

test('a 7-pit board works with the same code', () => {
  // 16 cells: store 0, row 1–7, store 8, row 9–15.
  const pits = [0, 7, 7, 7, 7, 7, 7, 7, 0, 7, 7, 7, 7, 7, 7, 7];
  const state = init(pits, PLAIN);

  const moves = congklakEngine.legalMoves(state) as CongklakMove[];
  assert.deepEqual(
    moves.map((m) => (m as { pit: number }).pit),
    [9, 10, 11, 12, 13, 14, 15],
  );

  const after = congklakEngine.applyMove(state, { kind: 'sow', pit: 15 }).state as CongklakState;
  assert.equal(after.pits[0], 0, "player 1 still skips player 2's store on a bigger board");
});
