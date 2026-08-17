/**
 * Mission definitions (PRD-LRN-002).
 *
 * A mission is authored content, validated before publication (10-12) and
 * shipped through the catalog. These types are the contract that content
 * validation, the game engines, the adaptive selector, and replay validation
 * all agree on.
 */

import type { SkillNodeId } from './taxonomy';

export type GameId = 'congklak' | 'benteng';

export const GAME_IDS: readonly GameId[] = ['congklak', 'benteng'];

export function isGameId(value: string): value is GameId {
  return GAME_IDS.indexOf(value as GameId) >= 0;
}

/** Deterministic opponent strength. Labels are Indonesian in the UI. */
export type AiTier = 'mudah' | 'sedang' | 'sulit';

export const AI_TIERS: readonly AiTier[] = ['mudah', 'sedang', 'sulit'];

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * What the student has to achieve.
 *
 * Discriminated so `evaluateGoal` is exhaustive: adding a goal kind without
 * handling it everywhere becomes a compile error. The demo's goal check was a
 * hardcoded `newBoard[6] >= 2` (games.tsx), which is exactly the shape this
 * replaces.
 */
export type MissionGoal =
  // --- Congklak ----------------------------------------------------------
  /** Hold at least `count` seeds in your store (*lumbung*). */
  | { kind: 'collect'; count: number }
  /** Finish with strictly more than the opponent, by `margin` (default 1). */
  | { kind: 'outscore'; margin?: number }
  /** Capture at least `count` seeds via the capture rule (*menembak*). */
  | { kind: 'capture'; count: number }
  /** Achieve a continuation chain of at least `count` links. */
  | { kind: 'chain'; count: number }
  /** Earn `count` extra turns — in a row when `consecutive` is set. */
  | { kind: 'extra_turns'; count: number; consecutive?: boolean }
  /** Empty your entire row, ending the round. */
  | { kind: 'clear_row' }
  /** Declare where the last seed will land, then sow. `count` times correctly. */
  | { kind: 'predict_landing'; count: number }
  /** Never leave a pit the opponent could capture into. */
  | { kind: 'no_exposure' }
  /** Every player move must rank at or above `maxRank` (0 = the best move). */
  | { kind: 'best_move'; maxRank?: number }

  // --- Benteng -----------------------------------------------------------
  /** Reach the opponent's base with any unit. */
  | { kind: 'reach_base' }
  /** Capture `count` opponent units. */
  | { kind: 'capture_units'; count: number }
  /** Survive `turns` turns without losing a unit. */
  | { kind: 'survive'; turns: number }
  /** Keep your base untouched by the opponent for `turns` turns. */
  | { kind: 'defend_base'; turns: number }

  // --- composition -------------------------------------------------------
  /**
   * Achieve `goal` within `moves` player moves. Exceeding the budget is a
   * failure, which is what makes a move budget a *goal* rather than a silent
   * constraint the student cannot see.
   */
  | { kind: 'within'; moves: number; goal: MissionGoal }
  /** Every sub-goal must hold. */
  | { kind: 'all'; goals: MissionGoal[] };

export type MissionGoalKind = MissionGoal['kind'];

export interface GoalStatus {
  /** The goal is met. */
  achieved: boolean;
  /** No further play can change the result. */
  terminal: boolean;
  /** 0–1, for a progress indicator. Never used to decide the outcome. */
  progress: number;
}

// ---------------------------------------------------------------------------
// Setup and constraints
// ---------------------------------------------------------------------------

export interface CongklakSetup {
  game: 'congklak';
  /** 12 pits: index 0 and 6 are the stores (lumbung), 1–5 and 7–11 the rows. */
  pits: number[];
  /** Which side the student plays. */
  playerSide: 1 | 2;
  /** Who moves first. */
  toMove: 1 | 2;
}

export interface BentengSetup {
  game: 'benteng';
  width: number;
  height: number;
  /** Base coordinates, one per side. */
  bases: { side: 1 | 2; x: number; y: number }[];
  units: {
    id: string;
    side: 1 | 2;
    x: number;
    y: number;
    /**
     * Turns since this unit last touched its base, at turn 0.
     *
     * Without this every unit starts equally fresh, and since capture requires
     * *strictly* lower freshness, no capture is possible until somebody goes
     * home — which makes the whole first tier unteachable. A mission that wants
     * to open on "one of these is stale, which one can you take?" says so here.
     *
     * Defaults to 0: on its base, fully fresh.
     */
    freshness?: number;
    /**
     * Start already captured, held at the enemy base.
     *
     * For missions that open from a position the student has to recover from,
     * rather than making them lose two units first to get there.
     */
    captured?: boolean;
  }[];
  toMove: 1 | 2;
}

export type MissionSetup = CongklakSetup | BentengSetup;

export interface MissionConstraints {
  /** Hard cap on player moves; exceeding it ends the attempt as a failure. */
  maxMoves?: number;
  /** Soft target used for star ratings and hints, never for pass/fail. */
  parMoves?: number;
  /** Opponent strength; absent means the mission is single-sided. */
  aiTier?: AiTier;
  /** Seconds. Advisory only — a timer must never be the reason a rural student fails. */
  softTimeLimitSeconds?: number;
}

export interface GameConfig {
  /**
   * Congklak: whether a final seed landing in your own store grants another
   * turn. Standard rule; configurable so early missions can disable it.
   */
  extraTurnOnStore?: boolean;
  /** Congklak: whether landing in an empty own-side pit captures the opposite pit. */
  captureEnabled?: boolean;
  /** Congklak: whether a seed landing in a non-empty pit continues sowing. */
  continuationEnabled?: boolean;
  /** Congklak: sweep remaining seeds to their owner's store when a row empties. */
  sweepOnEnd?: boolean;
  /** Benteng: turns after leaving base before a unit becomes capturable by anyone. */
  freshnessWindow?: number;
  /**
   * Congklak: the student must declare where the last seed will land before
   * they may sow. Turns "predict the landing pit" from a UI affordance into a
   * rule — which is what makes it searchable by the solver and verifiable in a
   * replay, rather than a claim the client makes about itself.
   */
  requirePrediction?: boolean;
}

export const DEFAULT_GAME_CONFIG: Required<
  Pick<GameConfig, 'extraTurnOnStore' | 'captureEnabled' | 'continuationEnabled' | 'sweepOnEnd'>
> = {
  extraTurnOnStore: true,
  captureEnabled: true,
  continuationEnabled: true,
  sweepOnEnd: true,
};

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

export interface Mission {
  id: string; // 'congklak.m07'
  game: GameId;
  rank: number; // 1-based position in the ladder
  contentVersion: number; // bumps on any gameplay change (PRD-CNT-004)

  /** Must sum to 1.0 ± 0.001, with one node ≥ 0.4 (PRD-LRN-002, design rule 1). */
  skillWeights: Partial<Record<SkillNodeId, number>>;

  /** Initial ELO rating; retuned from data (20-06). */
  eloDifficulty: number;

  goal: MissionGoal;
  setup: MissionSetup;
  constraints: MissionConstraints;
  config: GameConfig;
  /**
   * An authored winning line, player moves only.
   *
   * Optional, and required in practice only where exhaustive search is not
   * tractable — a Benteng defence mission is sixteen branches per turn with no
   * early exit to prune on. Validation replays it against the deterministic
   * opponent, so a mission cannot be published claiming to be winnable when it
   * is not, and a rules change that breaks the intended solution fails the
   * build rather than reaching a student.
   */
  referenceLine?: unknown[];

  /** Seed for deterministic AI. Part of the definition so play is reproducible. */
  seed: number;

  /** One sentence naming the mechanic that produces the evidence (PRD-LRN-002). */
  rationale: string;

  /** Localisation keys; the strings themselves are catalog content. */
  titleKey: string;
  briefKey: string;
  hintKeys: string[];
  /** Shown on failure. Must name what went wrong in game terms (design rule 2). */
  failureKeys: Partial<Record<string, string>>;
}

/** Compact view used by the selector; avoids shipping full definitions to rank them. */
export interface MissionSummary {
  id: string;
  gameId: GameId;
  contentVersion: number;
  rank: number;
  rating: number;
  primaryNode: SkillNodeId;
  skillWeights: Partial<Record<SkillNodeId, number>>;
}

/** The node carrying the highest weight. Ties break on node ID for determinism. */
export function primaryNodeOf(weights: Partial<Record<SkillNodeId, number>>): SkillNodeId | null {
  let best: SkillNodeId | null = null;
  let bestWeight = -1;
  const keys = Object.keys(weights).sort();
  for (let i = 0; i < keys.length; i++) {
    const node = keys[i] as SkillNodeId;
    const weight = weights[node] ?? 0;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = node;
    }
  }
  return best;
}
