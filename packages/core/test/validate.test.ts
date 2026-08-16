import { test } from 'node:test';
import assert from 'node:assert/strict';

import { congklakEngine } from '../dist/rules/congklak/index.js';
import { validateReplay, hashConfig } from '../dist/rules/validate.js';
import { ReplayRecorder } from '../dist/rules/record.js';
import { engineFor, currentVersion } from '../dist/rules/registry.js';
import type { Mission } from '../dist/types/mission.js';
import type { Replay } from '../dist/types/attempt.js';
import type { CongklakMove, CongklakState } from '../dist/index.js';

// A mission the student can win in a few moves: collect 2 seeds in the store.
// This is the descendant of the demo's one hardcoded condition, `newBoard[6]
// >= 2` — here it is data, evaluated by the shared engine.
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

/** Play the mission honestly, letting the deterministic opponent reply. */
function playHonestly(maxMoves = 40): Replay {
  const recorder = new ReplayRecorder<CongklakState, CongklakMove>(congklakEngine as never, MISSION);
  let elapsed = 0;

  for (let i = 0; i < maxMoves && !recorder.isTerminal(); i++) {
    const state = recorder.state;
    const isPlayer = congklakEngine.sideToMove(state) === congklakEngine.playerSide(state);
    elapsed += 900 + i * 37;

    if (isPlayer) {
      const legal = congklakEngine.legalMoves(state) as CongklakMove[];
      if (legal.length === 0) break;
      // Prefer the move that reaches the store, so the mission is winnable.
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
      const move = recorder.aiMove();
      if (!move) break;
      recorder.play(move, 'ai', elapsed);
    }
  }
  return recorder.finish();
}

test('an honest replay validates and reports the outcome', () => {
  const replay = playHonestly();
  const result = validateReplay(replay, MISSION, congklakEngine as never);

  assert.equal(result.valid, true, result.valid ? '' : `rejected: ${result.reason}`);
  if (result.valid) {
    assert.equal(result.outcome, replay.claimedOutcome);
    assert.ok(result.derivedMetrics.playerMoveCount > 0);
    assert.equal(result.suspicious, false, result.suspicionReasons.join(','));
  }
});

// ---------------------------------------------------------------------------
// Tamper resistance — the security test for the whole offline model.
// All four must be rejected, and the fourth is the one a naive implementation
// misses (20-07).
// ---------------------------------------------------------------------------

test('tamper 1: a replay claiming success from a losing position is rejected', () => {
  const losing: Mission = { ...MISSION, goal: { kind: 'collect', count: 99 } };
  const recorder = new ReplayRecorder<CongklakState, CongklakMove>(congklakEngine as never, losing);
  recorder.play({ kind: 'sow', pit: 7 }, 'player', 1200);

  const replay = recorder.finish();
  replay.claimedOutcome = 'success';

  const result = validateReplay(replay, losing, congklakEngine as never);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'goal_not_met');
});

test('tamper 2: substituting one move is rejected', () => {
  const replay = playHonestly();
  const playerIndex = replay.moves.findIndex((m) => m.actor === 'player');
  assert.ok(playerIndex >= 0);

  const original = replay.moves[playerIndex]!.move as CongklakMove;
  replay.moves[playerIndex]!.move = { kind: 'sow', pit: original.pit === 7 ? 11 : 7 };

  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false, 'a substituted move must not validate');
});

test('tamper 3: replacing an AI move with a favourable one is rejected', () => {
  const replay = playHonestly();
  const aiIndex = replay.moves.findIndex((m) => m.actor === 'ai');

  if (aiIndex < 0) {
    // The mission ended before the opponent moved; construct the case directly.
    const recorder = new ReplayRecorder<CongklakState, CongklakMove>(
      congklakEngine as never,
      { ...MISSION, goal: { kind: 'collect', count: 99 } },
    );
    recorder.play({ kind: 'sow', pit: 8 }, 'player', 1000);
    const forged = recorder.finish();
    forged.moves.push({ seq: 1, actor: 'ai', move: { kind: 'sow', pit: 1 }, elapsedMs: 2000 });
    const result = validateReplay(forged, { ...MISSION, goal: { kind: 'collect', count: 99 } }, congklakEngine as never);
    assert.equal(result.valid, false);
    return;
  }

  const legal = [1, 2, 3, 4, 5];
  const current = (replay.moves[aiIndex]!.move as CongklakMove).pit;
  replay.moves[aiIndex]!.move = { kind: 'sow', pit: legal.find((p) => p !== current)! };

  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.reason === 'ai_divergence' || result.reason === 'illegal_move',
      `unexpected reason ${result.reason}`,
    );
  }
});

test('tamper 4: editing moves AND recomputing the final hash is still rejected', () => {
  // The case a naive implementation misses. An attacker who edits the moves and
  // then recomputes `finalStateHash` over their own doctored state still fails,
  // because re-execution reaches a different state than the one they hashed —
  // and the engine, not the client, decides which state that is.
  const replay = playHonestly();
  const playerIndex = replay.moves.findIndex((m) => m.actor === 'player');
  const original = replay.moves[playerIndex]!.move as CongklakMove;

  // Doctor the move, then rebuild the hash the way a forger would: by replaying
  // their own edited sequence and hashing the result.
  replay.moves[playerIndex]!.move = { kind: 'sow', pit: original.pit === 7 ? 11 : 7 };
  replay.moves = replay.moves.slice(0, playerIndex + 1);
  replay.moves[playerIndex]!.seq = playerIndex;

  let state = congklakEngine.init(MISSION.setup, MISSION.config) as CongklakState;
  for (const entry of replay.moves) {
    const move = congklakEngine.parseMove(entry.move) as CongklakMove;
    if (!congklakEngine.isLegal(state, move)) break;
    state = congklakEngine.applyMove(state, move).state as CongklakState;
  }
  replay.finalStateHash = congklakEngine.hash(state);
  replay.claimedOutcome = 'success';

  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false, 'a self-consistent forgery must still fail the goal check');
});

// ---------------------------------------------------------------------------
// Structural rejections
// ---------------------------------------------------------------------------

test('a sequence gap is rejected', () => {
  const replay = playHonestly();
  if (replay.moves.length > 1) replay.moves[1]!.seq = 99;
  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  if (!result.valid && replay.moves.length > 1) assert.equal(result.reason, 'sequence_gap');
});

test('a mismatched config hash is rejected', () => {
  const replay = playHonestly();
  replay.configHash = 'deadbeef';
  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'config_mismatch');
});

test('a replay for another mission is rejected', () => {
  const replay = playHonestly();
  replay.missionId = 'congklak.m19';
  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'unknown_mission');
});

test('an unsupported engine version is rejected rather than validated by the wrong rules', () => {
  const replay = playHonestly();
  replay.engineVersion = '0.0.1';
  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'core_version_unsupported');
});

test('changing the mission definition invalidates existing replays', () => {
  // A mission whose gameplay changes must bump contentVersion; if it does not,
  // old replays would validate against new rules.
  const replay = playHonestly();
  const changed: Mission = {
    ...MISSION,
    config: { ...MISSION.config, captureEnabled: true },
  };
  assert.notEqual(hashConfig(changed), hashConfig(MISSION));

  const result = validateReplay(replay, changed, congklakEngine as never);
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Plausibility and registry
// ---------------------------------------------------------------------------

test('implausibly fast play is flagged but not rejected', () => {
  const replay = playHonestly();
  for (let i = 0; i < replay.moves.length; i++) replay.moves[i]!.elapsedMs = i;

  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, true, 'a legal replay stays valid');
  if (result.valid) {
    assert.equal(result.suspicious, true, 'but it is flagged for human review');
    assert.ok(result.suspicionReasons.length > 0);
  }
});

test('the registry resolves engines by game and version', () => {
  assert.equal(engineFor('congklak', currentVersion('congklak')), congklakEngine);
  assert.equal(engineFor('congklak', '9.9.9'), null);
  assert.ok(engineFor('benteng') !== null);
});
