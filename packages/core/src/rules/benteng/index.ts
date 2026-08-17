/**
 * The Benteng engine.
 */

import type { AiTier, GameConfig, GoalStatus, MissionGoal, MissionSetup } from '../../types/mission';
import { canonicalJson, sha256 } from '../../hash';
import type { GameEngine, MoveResult } from '../types';
import { aiMove, rankMove } from './ai';
import { applyMove as applyRules, isLegal, legalMoves, type BentengMove } from './moves';
import { evaluateGoal } from './outcome';
import {
  freshnessOf,
  teamIndex,
  unitById,
  type BentengBase,
  type BentengState,
  type BentengUnit,
} from './state';

export const BENTENG_ENGINE_VERSION = '1.0.0';

export const DEFAULT_TURN_LIMIT = 20;

function initState(setup: MissionSetup, config: GameConfig): BentengState {
  if (setup.game !== 'benteng') {
    throw new Error('benteng: mission setup is not a benteng setup');
  }

  const bases: BentengBase[] = [];
  for (let i = 0; i < setup.bases.length; i++) {
    const base = setup.bases[i] as { side: 1 | 2; x: number; y: number };
    bases.push({ team: base.side, x: base.x, y: base.y });
  }

  const units: BentengUnit[] = [];
  for (let i = 0; i < setup.units.length; i++) {
    const unit = setup.units[i] as { id: string; side: 1 | 2; x: number; y: number };
    units.push({
      id: unit.id,
      team: unit.side,
      x: unit.x,
      y: unit.y,
      // Every unit starts at its base, so every unit starts fresh.
      lastTouchedBaseOnTurn: 0,
      captured: false,
    });
  }

  return {
    width: setup.width,
    height: setup.height,
    turn: 0,
    toMove: setup.toMove,
    playerSide: 1,
    bases,
    units,
    prisoners: [],
    turnLimit: DEFAULT_TURN_LIMIT,
    freshnessWindow: config.freshnessWindow ?? 0,
    illegalCaptureAttempts: 0,
    maxExposureTurns: 0,
    exposureRun: {},
    refreshCount: 0,
    unitsLostBy: [0, 0],
    rescuesPerformed: 0,
    baseUndefendedTurns: 0,
    turnsWithoutLoss: 0,
    baseHeldTurns: 0,
    outcome: 'playing',
    finished: false,
  };
}

/**
 * Canonical fingerprint. Units are sorted by id so a state rebuilt by
 * re-execution hashes identically to the one the client produced.
 */
function hashState(state: BentengState): string {
  const units = state.units
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((u) => ({
      id: u.id,
      team: u.team,
      x: u.x,
      y: u.y,
      fresh: u.lastTouchedBaseOnTurn,
      captured: u.captured,
    }));

  return sha256(
    canonicalJson({
      turn: state.turn,
      toMove: state.toMove,
      units,
      prisoners: state.prisoners
        .slice()
        .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
      illegalCaptureAttempts: state.illegalCaptureAttempts,
      maxExposureTurns: state.maxExposureTurns,
      rescuesPerformed: state.rescuesPerformed,
      outcome: state.outcome,
      finished: state.finished,
    }),
  );
}

function parseMove(value: unknown): BentengMove | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as { unitId?: unknown; x?: unknown; y?: unknown };
  if (typeof raw.unitId !== 'string') return null;
  if (typeof raw.x !== 'number' || !Number.isInteger(raw.x)) return null;
  if (typeof raw.y !== 'number' || !Number.isInteger(raw.y)) return null;
  return { kind: 'move', unitId: raw.unitId, x: raw.x, y: raw.y };
}

export const bentengEngine: GameEngine<BentengState, BentengMove> = {
  gameId: 'benteng',
  version: BENTENG_ENGINE_VERSION,

  init(setup, config) {
    return initState(setup, config);
  },

  legalMoves,
  isLegal,

  applyMove(state, move): MoveResult<BentengState> {
    return applyRules(state, move);
  },

  evaluateGoal(state, goal: MissionGoal): GoalStatus {
    return evaluateGoal(state, goal);
  },

  aiMove(state, tier: AiTier, seed: number) {
    return aiMove(state, tier, seed);
  },

  hash: hashState,

  sideToMove(state) {
    return state.toMove;
  },

  playerSide(state) {
    return state.playerSide;
  },

  parseMove,

  movesEqual(a, b) {
    return a.unitId === b.unitId && a.x === b.x && a.y === b.y;
  },

  rankMove(state, move) {
    return rankMove(state, move);
  },

  /** Benteng has no "fullest pit"; the greedy analogue does not apply. */
  isGreedyMove() {
    return false;
  },

  /**
   * Counters that live on the position rather than in the event stream.
   *
   * Exposure is a run length over turns and losses are a running total; both
   * are already maintained by `applyMove`, and recomputing them from events in
   * the validator would be a second implementation of the same rule.
   */
  stateMetrics(state: BentengState) {
    return {
      maxExposureTurns: state.maxExposureTurns,
      illegalCaptureAttempts: state.illegalCaptureAttempts,
      unitsLost: state.unitsLostBy[teamIndex(state.playerSide)],
    };
  },
};

/**
 * Freshness readout for the UI (PRD-GAME-013).
 *
 * Exposed from the core so the number the student sees is the number the rule
 * uses — a second implementation in the component is how a UI ends up showing
 * "3" for a unit the engine treats as 4.
 */
export function unitFreshness(state: BentengState, unitId: string): number | null {
  const unit = unitById(state, unitId);
  return unit ? freshnessOf(state, unit) : null;
}

export * from './state';
export * from './moves';
export * from './outcome';
export * from './ai';
