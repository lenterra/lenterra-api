/**
 * Attempts and replays (20-07).
 *
 * A replay is the complete record of what the player decided — enough for the
 * server to reconstruct the attempt exactly, and nothing more. Board states are
 * never stored (TRD-ENG-003): they would double the payload and create a second
 * source of truth that could disagree with the engine.
 */

import type { GameId } from './mission';
import type { SkillNodeId, MasteryBand } from './taxonomy';

export type AttemptOutcome = 'success' | 'failure' | 'abandoned';

export interface ReplayMove {
  seq: number;
  actor: 'player' | 'opponent' | 'ai';
  /** Game-specific; the engine validates its shape. */
  move: unknown;
  /** Since attempt start. Feeds plausibility checks only (TRD-ENG-006). */
  elapsedMs: number;
}

export interface Replay {
  gameId: GameId;
  missionId: string;
  missionContentVersion: number;
  engineVersion: string;
  /** Hash of the resolved game config; catches a client playing different rules. */
  configHash: string;
  seed: number;
  moves: ReplayMove[];
  /** The client's claim about where play ended. */
  finalStateHash: string;
  claimedOutcome: AttemptOutcome;
}

export type RejectionReason =
  | 'core_version_unsupported'
  | 'config_mismatch'
  | 'sequence_gap'
  | 'illegal_move'
  | 'ai_divergence'
  | 'replay_mismatch'
  | 'goal_not_met'
  | 'unknown_mission'
  | 'too_many_moves'
  | 'malformed_replay';

/**
 * Metrics derived from the server's own re-execution (TRD-ENG-005).
 * Client-reported values are ignored — a client-supplied "I played optimally"
 * would be worthless.
 */
export interface DerivedMetrics {
  moveCount: number;
  playerMoveCount: number;
  captureCount: number;
  chainMaxLength: number;
  extraTurnCount: number;
  /** How often the student took the highest-seed pit (the greedy move). */
  greedyMoveTaken: number;
  /** Mean rank of the chosen move among legal moves, 0 = best. `null` when unscored. */
  optimalMoveRank: number | null;
  /** Benteng: longest run of turns a unit spent capturable. */
  maxExposureTurns: number;
  illegalCaptureAttempts: number;
  /** Benteng: units the student lost over the whole game. */
  unitsLost: number;
}

export interface ValidationSuccess {
  valid: true;
  outcome: AttemptOutcome;
  derivedMetrics: DerivedMetrics;
  /** Timing looked implausible. Informs review, never an automatic penalty. */
  suspicious: boolean;
  suspicionReasons: string[];
}

export interface ValidationFailure {
  valid: false;
  reason: RejectionReason;
  /** Human-readable, for logs and the client's correction message. */
  detail?: string;
  /** Present for `goal_not_met`: what the replay actually achieved. */
  actualOutcome?: AttemptOutcome;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// ---------------------------------------------------------------------------
// Submission and results
// ---------------------------------------------------------------------------

export interface AttemptSubmission {
  missionId: string;
  missionContentVersion: number;
  catalogVersion: string;
  gameId: GameId;
  replay: Replay;
  claimedOutcome: AttemptOutcome;
  durationMs: number;
  /** Device clock. Informational; the server timestamps authoritatively. */
  clientStartedAt: string;
  /** Monotonic per device; orders offline batches (20-09). */
  deviceSeq: number;
  hintShown: boolean;
  hintUsed: boolean;
  playedOffline: boolean;
  twoPlayer: boolean;
  coreVersion: string;
}

export interface MasteryChange {
  skillNodeId: SkillNodeId;
  before: number;
  after: number;
  band: MasteryBand;
  bandChanged: boolean;
}

export interface AttemptSummary {
  id: string;
  missionId: string;
  primaryNode: SkillNodeId;
  outcome: AttemptOutcome;
  /** Epoch milliseconds. Server time. */
  at: number;
}
