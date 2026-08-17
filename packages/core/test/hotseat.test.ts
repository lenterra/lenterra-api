/**
 * Hot-seat: two students, one phone (TRD-MP-001…003).
 *
 * Two properties are asserted, and the second is the one that matters more than
 * it looks. A hot-seat replay marks the guest's moves `opponent` rather than
 * `ai`, and those moves are checked for legality instead of being recomputed.
 * If a *solo* replay could use the same label, a client would have an opponent
 * exempt from the determinism check — free to play badly on purpose — and every
 * mission in the ladder would be winnable by relabelling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { congklakEngine } from '../dist/rules/congklak/index.js';
import { validateReplay } from '../dist/rules/validate.js';
import { ReplayRecorder } from '../dist/rules/record.js';
import { effectiveWeight, TWO_PLAYER_FACTOR } from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { Replay } from '../dist/types/attempt.js';
import type { CongklakMove, CongklakState } from '../dist/index.js';

const MISSION: Mission = {
  id: 'congklak.m02',
  game: 'congklak',
  rank: 2,
  contentVersion: 1,
  skillWeights: { 'comp.arithmetic': 0.5, 'comp.counting': 0.3, 'comp.modular': 0.2 },
  eloDifficulty: 850,
  goal: { kind: 'collect', count: 2 },
  setup: {
    game: 'congklak',
    pits: [0, 1, 1, 1, 1, 1, 0, 6, 0, 0, 0, 6],
    playerSide: 1,
    toMove: 1,
  },
  constraints: { maxMoves: 20, aiTier: 'sedang' },
  config: {
    extraTurnOnStore: true,
    captureEnabled: false,
    continuationEnabled: false,
    sweepOnEnd: true,
  },
  seed: 4242,
  rationale: 'The student must count seeds in a pit and predict the landing pit to reach the lumbung.',
  titleKey: 'mission.congklak.m02.title',
  briefKey: 'mission.congklak.m02.brief',
  hintKeys: ['mission.congklak.m02.hint1'],
  failureKeys: { ranOut: 'mission.congklak.m02.fail.ranOut' },
};

/**
 * Two people alternating on one device.
 *
 * The guest plays legally but with no help from the engine's own opponent —
 * they simply take the first legal move, which is what a person distracted by
 * a classroom often does.
 */
function playHotSeat(maxMoves = 40): Replay {
  const recorder = new ReplayRecorder<CongklakState, CongklakMove>(congklakEngine as never, MISSION);
  let elapsed = 0;

  for (let i = 0; i < maxMoves && !recorder.isTerminal(); i++) {
    const state = recorder.state;
    const mine = congklakEngine.sideToMove(state) === congklakEngine.playerSide(state);
    const legal = congklakEngine.legalMoves(state) as CongklakMove[];
    if (legal.length === 0) break;
    elapsed += 900 + i * 37;

    if (mine) {
      let chosen = legal[0] as CongklakMove;
      for (const candidate of legal) {
        const after = congklakEngine.applyMove(state, candidate).state as CongklakState;
        if ((after.pits[6] as number) > (state.pits[6] as number)) {
          chosen = candidate;
          break;
        }
      }
      recorder.play(chosen, 'player', elapsed);
    } else {
      recorder.play(legal[0] as CongklakMove, 'opponent', elapsed);
    }
  }

  return recorder.finish();
}

test('a hot-seat replay validates when the attempt says two people played', () => {
  const replay = playHotSeat();
  const result = validateReplay(replay, MISSION, congklakEngine as never, true);

  assert.equal(result.valid, true, result.valid ? '' : `rejected: ${result.reason}`);
});

test('the same replay is refused when the attempt claims solo play', () => {
  // Without this, labelling the AI's moves `opponent` would exempt them from
  // the determinism check and hand the client an opponent it fully controls.
  const replay = playHotSeat();
  const result = validateReplay(replay, MISSION, congklakEngine as never, false);

  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'ai_divergence');
});

test('only the account holder’s own moves are counted as theirs', () => {
  const replay = playHotSeat();
  const result = validateReplay(replay, MISSION, congklakEngine as never, true);
  assert.equal(result.valid, true);

  const ownMoves = replay.moves.filter((move) => move.actor === 'player').length;
  const guestMoves = replay.moves.filter((move) => move.actor === 'opponent').length;

  assert.ok(guestMoves > 0, 'the fixture should exercise a guest turn');
  assert.equal(
    result.valid === true && result.derivedMetrics.playerMoveCount,
    ownMoves,
    'the guest’s moves must not be scored as the student’s',
  );
});

test('shared play is discounted, not discarded', () => {
  const solo = effectiveWeight(0.5, false, false, 'game', false);
  const shared = effectiveWeight(0.5, false, false, 'game', true);

  assert.ok(shared > 0, 'refusing to count shared play would push students to a worse experience');
  assert.equal(shared, solo * TWO_PLAYER_FACTOR);
});
