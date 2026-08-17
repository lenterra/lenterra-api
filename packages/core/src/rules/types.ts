/**
 * The generic game-engine contract (20-07).
 *
 * Every game implements this, and both the app and the Nakama modules consume
 * only this. Two properties are load-bearing and neither is optional:
 *
 *  - **`applyMove` is pure.** It returns a new state; it never mutates its
 *    argument, touches React, sets a timer, or reads a clock. The demo's
 *    sowing drove React state one seed per 200 ms `setTimeout` tick, which is
 *    why it could not run on a server or in a test without a renderer.
 *  - **`aiMove` is a pure function of `(state, tier, seed)`.** No
 *    `Math.random()`. The seed comes from the mission definition, so the same
 *    mission plays identically for every student — and, critically, for the
 *    validator re-executing the replay.
 */

import type {
  AiTier,
  GameConfig,
  GameId,
  MissionGoal,
  MissionSetup,
  GoalStatus,
} from '../types/mission';

export type MoveEventKind =
  | 'sow'
  | 'skip'
  | 'capture'
  | 'extraTurn'
  | 'chain'
  | 'sweep'
  | 'move'
  | 'predict'
  | 'gameEnd';

/**
 * What happened during a move, in order.
 *
 * The animation is driven *from* this list after the fact, which inverts the
 * demo's coupling: logical state is correct the moment the move is applied,
 * and the visuals are a replay of events that already happened. That is what
 * makes a skippable animation implementable at all (PRD-GAME-006).
 */
export interface MoveEvent {
  kind: MoveEventKind;
  /** Pit or cell index the event concerns. */
  index?: number;
  /** Secondary index — the captured pit, or a move's destination. */
  target?: number;
  /** Seeds or units involved. */
  count?: number;
  side?: 1 | 2;
}

export interface MoveResult<S> {
  state: S;
  events: MoveEvent[];
  /** False when the mover earned another turn. */
  turnEnded: boolean;
}

export interface GameEngine<S, M> {
  readonly gameId: GameId;
  /** Bumped on any behavioural change. Enforced by conformance fixtures in CI. */
  readonly version: string;

  init(setup: MissionSetup, config: GameConfig): S;
  legalMoves(state: S): M[];
  isLegal(state: S, move: M): boolean;
  applyMove(state: S, move: M): MoveResult<S>;
  evaluateGoal(state: S, goal: MissionGoal): GoalStatus;
  aiMove(state: S, tier: AiTier, seed: number): M | null;
  /** Canonical state fingerprint. Identical inputs must hash identically. */
  hash(state: S): string;
  /** Whose turn it is. */
  sideToMove(state: S): 1 | 2;
  /** Which side the student controls. */
  playerSide(state: S): 1 | 2;
  /** Narrow an unknown value from a replay into a move, or null. */
  parseMove(value: unknown): M | null;
  /** Structural equality, for comparing a replayed AI move to the expected one. */
  movesEqual(a: M, b: M): boolean;
  /**
   * Rank of `move` among legal moves under the engine's own evaluation,
   * 0 = best. Feeds `optimalMoveRank` (TRD-ENG-005). `null` when unscorable.
   */
  rankMove(state: S, move: M): number | null;
  /** Is this the greedy choice — the pit with the most seeds? */
  isGreedyMove(state: S, move: M): boolean;
  /**
   * Counters the event stream cannot carry.
   *
   * Some metrics are properties of *positions* rather than of moves — how long
   * a unit stood capturable, how many units were lost — and reconstructing them
   * from events would mean re-deriving state the engine already holds. Engines
   * with none of these may omit it.
   */
  stateMetrics?(state: S): StateMetrics;
}

/** Engine-specific counters read off the final state. */
export interface StateMetrics {
  maxExposureTurns?: number;
  illegalCaptureAttempts?: number;
  /** Units the student lost. Zero is what "kept everyone alive" means. */
  unitsLost?: number;
}

export type { AiTier, GameConfig, GameId, MissionGoal, MissionSetup, GoalStatus };
