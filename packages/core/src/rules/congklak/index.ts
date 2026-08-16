/**
 * The Congklak engine — the `GameEngine` implementation the app and the server
 * both consume.
 *
 * This wrapper is where the rules and the evaluator are both in scope, so it
 * is where `worstMoveRank` is recorded: `moves.ts` must not depend on `ai.ts`,
 * or the two would import each other.
 */

import type { GameConfig, MissionGoal, MissionSetup, AiTier, GoalStatus } from '../../types/mission';
import { DEFAULT_GAME_CONFIG } from '../../types/mission';
import { canonicalJson, sha256 } from '../../hash';
import type { GameEngine, MoveResult } from '../types';
import { aiMove, rankMove } from './ai';
import { applyMove as applyRules, greedyPit, isLegal, legalMoves, type CongklakMove } from './moves';
import { evaluateGoal } from './outcome';
import { cloneState, standardBoard, type CongklakState } from './state';

export const CONGKLAK_ENGINE_VERSION = '1.0.0';

function initState(setup: MissionSetup, config: GameConfig): CongklakState {
  const pits =
    setup.game === 'congklak' && setup.pits.length >= 6 ? setup.pits.slice() : standardBoard();

  if (pits.length % 2 !== 0 || pits.length < 6) {
    throw new Error('congklak: board must have an even number of cells, at least 6');
  }

  const playerSide = setup.game === 'congklak' ? setup.playerSide : 1;
  const toMove = setup.game === 'congklak' ? setup.toMove : 1;

  return {
    pits,
    toMove,
    playerSide,
    turn: 0,
    capturedBy: [0, 0],
    extraTurnsBy: [0, 0],
    maxChainBy: [0, 0],
    consecutiveExtraBy: [0, 0],
    exposureTurns: 0,
    playerMoves: 0,
    worstMoveRank: 0,
    correctPredictions: 0,
    pendingPrediction: null,
    finished: false,
    extraTurnOnStore: config.extraTurnOnStore ?? DEFAULT_GAME_CONFIG.extraTurnOnStore,
    requirePrediction: config.requirePrediction === true,
    captureEnabled: config.captureEnabled ?? DEFAULT_GAME_CONFIG.captureEnabled,
    continuationEnabled: config.continuationEnabled ?? DEFAULT_GAME_CONFIG.continuationEnabled,
    sweepOnEnd: config.sweepOnEnd ?? DEFAULT_GAME_CONFIG.sweepOnEnd,
  };
}

/**
 * Canonical fingerprint.
 *
 * Only fields that affect play or the outcome are hashed. Including everything
 * would make the hash brittle — adding a telemetry counter to the state would
 * invalidate every replay in every offline queue.
 */
function hashState(state: CongklakState): string {
  return sha256(
    canonicalJson({
      pits: state.pits,
      pendingPrediction: state.pendingPrediction,
      toMove: state.toMove,
      playerSide: state.playerSide,
      turn: state.turn,
      capturedBy: state.capturedBy,
      extraTurnsBy: state.extraTurnsBy,
      maxChainBy: state.maxChainBy,
      correctPredictions: state.correctPredictions,
      exposureTurns: state.exposureTurns,
      playerMoves: state.playerMoves,
      finished: state.finished,
    }),
  );
}

function parseMove(value: unknown): CongklakMove | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as { kind?: unknown; pit?: unknown };
  if (typeof raw.pit !== 'number' || !Number.isInteger(raw.pit)) return null;
  if (raw.kind === 'predict') return { kind: 'predict', pit: raw.pit };
  // Absent `kind` means a sow: the common case, and worth accepting so a
  // replay stays compact.
  if (raw.kind === 'sow' || raw.kind === undefined) return { kind: 'sow', pit: raw.pit };
  return null;
}

export const congklakEngine: GameEngine<CongklakState, CongklakMove> = {
  gameId: 'congklak',
  version: CONGKLAK_ENGINE_VERSION,

  init(setup, config) {
    return initState(setup, config);
  },

  legalMoves,
  isLegal,

  applyMove(state, move): MoveResult<CongklakState> {
    // Rank the student's decision before the board changes — afterwards the
    // alternatives no longer exist.
    let rank: number | null = null;
    if (move.kind === 'sow' && state.toMove === state.playerSide) {
      rank = rankMove(state, move);
    }

    const result = applyRules(state, move);

    if (rank !== null && rank > result.state.worstMoveRank) {
      const annotated = cloneState(result.state);
      annotated.worstMoveRank = rank;
      return { state: annotated, events: result.events, turnEnded: result.turnEnded };
    }
    return result;
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
    return a.kind === b.kind && a.pit === b.pit;
  },

  rankMove(state, move) {
    return rankMove(state, move);
  },

  isGreedyMove(state, move) {
    if (move.kind !== 'sow') return false;
    return greedyPit(state) === move.pit;
  },
};

export * from './state';
export * from './moves';
export * from './outcome';
export * from './ai';
