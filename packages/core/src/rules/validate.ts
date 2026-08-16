/**
 * Replay validation (20-07).
 *
 * The piece the whole offline model rests on. A student plays offline and the
 * client scores the attempt so they get immediate feedback; the server then
 * decides what the attempt was actually worth. Those two are reconcilable only
 * because the server can independently establish what happened — by
 * re-executing the play through the identical rules module.
 *
 * The `ai_divergence` check is what makes single-player attempts verifiable at
 * all. If the AI is deterministic and the server can reproduce its moves, the
 * entire opponent side of the game is verified rather than trusted.
 */

import type { Mission } from '../types/mission';
import type {
  DerivedMetrics,
  RejectionReason,
  Replay,
  ReplayMove,
  ValidationResult,
} from '../types/attempt';
import { canonicalJson, sha256 } from '../hash';
import type { GameEngine, MoveEvent } from './types';

/** A replay longer than this is malformed, not merely long. */
export const MAX_REPLAY_MOVES = 2000;

/** Timing below these thresholds is implausible for human play (TRD-ENG-006). */
export const MIN_PLAUSIBLE_TOTAL_MS = 500;
export const MIN_PLAUSIBLE_INTERVAL_MS = 50;
export const LONG_GAME_MOVE_THRESHOLD = 10;

/** Canonical hash of a mission's resolved config, compared against the replay. */
export function hashConfig(mission: Pick<Mission, 'config' | 'setup' | 'constraints'>): string {
  return sha256(
    canonicalJson({
      config: mission.config,
      setup: mission.setup,
      constraints: mission.constraints,
    }),
  );
}

function reject(reason: RejectionReason, detail?: string): ValidationResult {
  return detail === undefined ? { valid: false, reason } : { valid: false, reason, detail };
}

/**
 * Re-execute a replay and decide what it was actually worth.
 *
 * `engine` must be the version named in the replay, resolved through the
 * registry (TRD-ENG-007) — validating a 1.2 replay under 1.3 rules is exactly
 * the mass-rejection failure the registry exists to prevent.
 */
export function validateReplay<S, M>(
  replay: Replay,
  mission: Mission,
  engine: GameEngine<S, M>,
): ValidationResult {
  if (!replay || !replay.moves || Object.prototype.toString.call(replay.moves) !== '[object Array]') {
    return reject('malformed_replay', 'moves is not an array');
  }
  if (replay.moves.length > MAX_REPLAY_MOVES) {
    return reject('too_many_moves', `${replay.moves.length} moves`);
  }
  if (replay.missionId !== mission.id) {
    return reject('unknown_mission', `replay is for ${replay.missionId}`);
  }
  if (replay.missionContentVersion !== mission.contentVersion) {
    return reject('config_mismatch', 'mission content version differs');
  }
  if (engine.version !== replay.engineVersion) {
    return reject('core_version_unsupported', `server has ${engine.version}`);
  }
  if (hashConfig(mission) !== replay.configHash) {
    return reject('config_mismatch', 'resolved config differs');
  }

  let state = engine.init(mission.setup, mission.config);
  const playerSide = engine.playerSide(state);
  const aiTier = mission.constraints.aiTier ?? 'sedang';

  const events: MoveEvent[] = [];
  let greedyMoveTaken = 0;
  let rankTotal = 0;
  let rankedMoves = 0;
  let playerMoveCount = 0;
  let terminated = false;

  for (let i = 0; i < replay.moves.length; i++) {
    const entry = replay.moves[i] as ReplayMove;

    if (entry.seq !== i) return reject('sequence_gap', `expected seq ${i}, saw ${entry.seq}`);

    const move = engine.parseMove(entry.move);
    if (move === null) return reject('malformed_replay', `move ${i} is not a valid move`);

    const sideToMove = engine.sideToMove(state);

    if (entry.actor === 'ai') {
      // The opponent's side of the game is verified, not trusted: recompute
      // what the AI would have played and require a match.
      const expected = engine.aiMove(state, aiTier, replay.seed);
      if (expected === null) return reject('ai_divergence', 'no AI move was available');
      if (!engine.movesEqual(expected, move)) {
        return reject('ai_divergence', `move ${i} differs from the deterministic opponent`);
      }
    } else {
      if (!engine.isLegal(state, move)) {
        return reject('illegal_move', `move ${i} is not legal in this position`);
      }
    }

    if (sideToMove === playerSide && entry.actor !== 'ai') {
      playerMoveCount++;
      if (engine.isGreedyMove(state, move)) greedyMoveTaken++;
      const rank = engine.rankMove(state, move);
      if (rank !== null) {
        rankTotal += rank;
        rankedMoves++;
      }
    }

    const result = engine.applyMove(state, move);
    state = result.state;
    for (let e = 0; e < result.events.length; e++) events.push(result.events[e] as MoveEvent);

    if (engine.evaluateGoal(state, mission.goal).terminal) {
      terminated = true;
      // Any move after a terminal position is a fabrication.
      if (i < replay.moves.length - 1) {
        return reject('malformed_replay', 'moves continue past a terminal position');
      }
      break;
    }
  }

  // The state fingerprint must match. This is the check a naive implementation
  // misses: an attacker who edits moves *and* recomputes the hash still fails,
  // because the hash they compute is over their edited state and this one is
  // over the state re-execution actually reached.
  if (engine.hash(state) !== replay.finalStateHash) {
    return reject('replay_mismatch', 'final state differs from the claimed one');
  }

  const status = engine.evaluateGoal(state, mission.goal);
  const actual = status.achieved ? 'success' : status.terminal ? 'failure' : 'abandoned';

  if (actual !== replay.claimedOutcome) {
    return {
      valid: false,
      reason: 'goal_not_met',
      detail: `claimed ${replay.claimedOutcome}, replay shows ${actual}`,
      actualOutcome: actual,
    };
  }

  const plausibility = checkPlausibility(replay);

  return {
    valid: true,
    outcome: actual,
    suspicious: plausibility.suspicious,
    suspicionReasons: plausibility.reasons,
    derivedMetrics: metricsFrom(events, {
      moveCount: terminated ? Math.min(replay.moves.length, MAX_REPLAY_MOVES) : replay.moves.length,
      playerMoveCount,
      greedyMoveTaken,
      optimalMoveRank: rankedMoves === 0 ? null : rankTotal / rankedMoves,
    }),
  };
}

/**
 * Timing plausibility.
 *
 * A legal replay submitted by a script is legal. Timing is the only signal
 * separating it from play, and it is weak enough that it must inform a human
 * rather than trigger a sanction — a student on a fast device who has played
 * a mission twenty times is genuinely quick.
 */
export function checkPlausibility(replay: Replay): { suspicious: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const moves = replay.moves;

  if (moves.length > 0) {
    const total = (moves[moves.length - 1] as ReplayMove).elapsedMs;
    if (total < MIN_PLAUSIBLE_TOTAL_MS) reasons.push('total_elapsed_below_threshold');

    if (moves.length >= LONG_GAME_MOVE_THRESHOLD) {
      let fast = 0;
      for (let i = 1; i < moves.length; i++) {
        const gap = (moves[i] as ReplayMove).elapsedMs - (moves[i - 1] as ReplayMove).elapsedMs;
        if (gap < MIN_PLAUSIBLE_INTERVAL_MS) fast++;
      }
      if (fast > moves.length / 2) reasons.push('move_intervals_below_threshold');
    }

    for (let i = 1; i < moves.length; i++) {
      if ((moves[i] as ReplayMove).elapsedMs < (moves[i - 1] as ReplayMove).elapsedMs) {
        reasons.push('non_monotonic_timing');
        break;
      }
    }
  }

  return { suspicious: reasons.length > 0, reasons };
}

/** Metrics come from the server's own execution, never from the client. */
function metricsFrom(
  events: MoveEvent[],
  base: {
    moveCount: number;
    playerMoveCount: number;
    greedyMoveTaken: number;
    optimalMoveRank: number | null;
  },
): DerivedMetrics {
  let captureCount = 0;
  let chainMaxLength = 0;
  let extraTurnCount = 0;
  let chainRun = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i] as MoveEvent;
    switch (event.kind) {
      case 'capture':
        captureCount += event.count ?? 1;
        break;
      case 'chain':
        chainRun++;
        if (chainRun > chainMaxLength) chainMaxLength = chainRun;
        break;
      case 'extraTurn':
        extraTurnCount++;
        chainRun = 0;
        break;
      default:
        if (event.kind === 'sow' || event.kind === 'move') chainRun = 0;
        break;
    }
  }

  return {
    moveCount: base.moveCount,
    playerMoveCount: base.playerMoveCount,
    captureCount,
    chainMaxLength,
    extraTurnCount,
    greedyMoveTaken: base.greedyMoveTaken,
    optimalMoveRank: base.optimalMoveRank,
    maxExposureTurns: 0,
    illegalCaptureAttempts: 0,
  };
}

/**
 * Merge engine-specific counters the event stream does not carry.
 *
 * Benteng tracks exposure and illegal capture attempts on the state itself
 * because they are properties of positions, not of events.
 */
export function withStateMetrics(
  metrics: DerivedMetrics,
  extra: { maxExposureTurns?: number; illegalCaptureAttempts?: number },
): DerivedMetrics {
  return {
    moveCount: metrics.moveCount,
    playerMoveCount: metrics.playerMoveCount,
    captureCount: metrics.captureCount,
    chainMaxLength: metrics.chainMaxLength,
    extraTurnCount: metrics.extraTurnCount,
    greedyMoveTaken: metrics.greedyMoveTaken,
    optimalMoveRank: metrics.optimalMoveRank,
    maxExposureTurns: extra.maxExposureTurns ?? metrics.maxExposureTurns,
    illegalCaptureAttempts: extra.illegalCaptureAttempts ?? metrics.illegalCaptureAttempts,
  };
}
