/**
 * Congklak move application — the complete rule set (PRD-GAME-001).
 *
 * The demo implemented sowing, store-skipping, and the extra turn correctly.
 * Continuation, capture, game end, and sweep were absent, and each absence had
 * a pedagogical cost: without continuation the loop that makes Congklak
 * *Congklak* never happens (`algo.iteration`); without capture no move is
 * better than any other, so there is nothing to plan (`algo.lookahead`,
 * `algo.greedy`); without an end condition no game ever finishes
 * (`algo.state-eval`). All four are implemented here.
 *
 * Every rule is individually toggleable so early missions can teach one
 * mechanic at a time.
 */

import type { MoveEvent, MoveResult } from '../types';
import {
  cloneState,
  isStore,
  oppositePit,
  ownsPit,
  otherSide,
  rowOf,
  seedsInRow,
  sideIndex,
  storeOf,
  type CongklakState,
} from './state';

export type CongklakMove =
  | { kind: 'sow'; pit: number }
  /** Declare where the last seed will land, before sowing (mission m05). */
  | { kind: 'predict'; pit: number };

/** Guard against a pathological mission definition looping forever. */
export const MAX_CHAIN_LINKS = 200;

export function legalMoves(state: CongklakState): CongklakMove[] {
  if (state.finished) return [];

  const moves: CongklakMove[] = [];
  const { from, to } = rowOf(state, state.toMove);
  for (let i = from; i <= to; i++) {
    if ((state.pits[i] as number) > 0) moves.push({ kind: 'sow', pit: i });
  }
  return moves;
}

export function isLegal(state: CongklakState, move: CongklakMove): boolean {
  if (state.finished) return false;

  if (move.kind === 'predict') {
    // A prediction is legal only when none is pending and the named cell is a
    // real board position.
    return (
      state.pendingPrediction === null &&
      Number.isInteger(move.pit) &&
      move.pit >= 0 &&
      move.pit < state.pits.length
    );
  }

  if (!Number.isInteger(move.pit)) return false;
  if (!ownsPit(state, state.toMove, move.pit)) return false;
  return (state.pits[move.pit] as number) > 0;
}

/**
 * Sow one turn to completion, following continuation chains.
 *
 * Returns the new state plus the ordered event list the animation replays.
 * There is no timer here and no partial state: the logical result is final the
 * moment this returns.
 */
export function applyMove(state: CongklakState, move: CongklakMove): MoveResult<CongklakState> {
  if (move.kind === 'predict') {
    const next = cloneState(state);
    next.pendingPrediction = move.pit;
    return {
      state: next,
      events: [{ kind: 'predict', index: move.pit, side: state.toMove }],
      turnEnded: false,
    };
  }

  const next = cloneState(state);
  const events: MoveEvent[] = [];
  const mover = next.toMove;
  const moverIdx = sideIndex(mover);
  const opponentStore = storeOf(next, otherSide(mover));
  const ownStore = storeOf(next, mover);
  const size = next.pits.length;

  let cursor = move.pit;
  let seeds = next.pits[cursor] as number;
  next.pits[cursor] = 0;
  events.push({ kind: 'sow', index: cursor, count: seeds, side: mover });

  let chainLinks = 0;
  let earnedExtraTurn = false;
  let landed = cursor;

  for (;;) {
    // --- distribute -------------------------------------------------------
    while (seeds > 0) {
      cursor = (cursor + 1) % size;
      if (cursor === opponentStore) {
        events.push({ kind: 'skip', index: cursor, side: mover });
        cursor = (cursor + 1) % size;
      }
      next.pits[cursor] = (next.pits[cursor] as number) + 1;
      seeds--;
    }
    landed = cursor;

    // --- resolve the landing cell ----------------------------------------

    // Own store: another turn. Checked first — a store is never "empty" in the
    // sense the capture rule means.
    if (landed === ownStore) {
      if (next.extraTurnOnStore) {
        earnedExtraTurn = true;
        next.extraTurnsBy[moverIdx]++;
        next.consecutiveExtraBy[moverIdx]++;
        events.push({ kind: 'extraTurn', index: landed, side: mover });
      }
      break;
    }

    const landedCount = next.pits[landed] as number;

    // Non-empty pit: continuation. `landedCount > 1` because the seed just
    // dropped is included — the pit held something before this seed arrived.
    if (next.continuationEnabled && landedCount > 1 && !isStore(next, landed)) {
      if (chainLinks >= MAX_CHAIN_LINKS) {
        // Unreachable with a well-formed mission; a runaway board would
        // otherwise hang the phone and the validator alike.
        events.push({ kind: 'chain', index: landed, count: chainLinks, side: mover });
        break;
      }
      seeds = landedCount;
      next.pits[landed] = 0;
      chainLinks++;
      events.push({ kind: 'chain', index: landed, count: seeds, side: mover });
      cursor = landed;
      continue;
    }

    // Empty pit on the mover's own side: capture (*menembak*).
    if (next.captureEnabled && landedCount === 1 && ownsPit(next, mover, landed)) {
      const across = oppositePit(next, landed);
      const captured = next.pits[across] as number;
      if (captured > 0) {
        next.pits[across] = 0;
        next.pits[landed] = 0;
        next.pits[ownStore] = (next.pits[ownStore] as number) + captured + 1;
        next.capturedBy[moverIdx] += captured + 1;
        events.push({
          kind: 'capture',
          index: landed,
          target: across,
          count: captured + 1,
          side: mover,
        });
      }
      break;
    }

    // Empty pit on the opponent's side, or capture disabled: the turn ends.
    break;
  }

  if (chainLinks > next.maxChainBy[moverIdx]) next.maxChainBy[moverIdx] = chainLinks;
  if (!earnedExtraTurn) next.consecutiveExtraBy[moverIdx] = 0;

  // --- prediction resolution (m05) ---------------------------------------
  if (next.pendingPrediction !== null) {
    if (next.pendingPrediction === landed && mover === next.playerSide) {
      next.correctPredictions++;
    }
    next.pendingPrediction = null;
  }

  // --- exposure accounting (m13) -----------------------------------------
  // Counted after the mover's turn resolves: an exposed pit is one the
  // opponent could capture into on their very next move.
  if (mover === next.playerSide && hasExposedPit(next, next.playerSide)) {
    next.exposureTurns++;
  }

  if (mover === next.playerSide) next.playerMoves++;
  next.turn++;

  // --- end condition ------------------------------------------------------
  const nextToMove = earnedExtraTurn ? mover : otherSide(mover);
  next.toMove = nextToMove;

  if (seedsInRow(next, nextToMove) === 0) {
    finishGame(next, events);
  }

  return { state: next, events, turnEnded: !earnedExtraTurn };
}

/**
 * The player to move has no seeds: the game ends and the opponent sweeps their
 * remaining row into their own store. Highest store total wins.
 */
export function finishGame(state: CongklakState, events: MoveEvent[]): void {
  if (state.finished) return;

  if (state.sweepOnEnd) {
    for (const side of [1, 2] as const) {
      const { from, to } = rowOf(state, side);
      const store = storeOf(state, side);
      let swept = 0;
      for (let i = from; i <= to; i++) {
        swept += state.pits[i] as number;
        state.pits[i] = 0;
      }
      if (swept > 0) {
        state.pits[store] = (state.pits[store] as number) + swept;
        events.push({ kind: 'sweep', index: store, count: swept, side });
      }
    }
  }

  state.finished = true;
  events.push({ kind: 'gameEnd', side: state.toMove });
}

/**
 * Does this side have a pit the opponent could capture into next move?
 *
 * A pit is exposed when it holds seeds and the pit across from it is empty and
 * belongs to the opponent — the setup the capture rule rewards. This is the
 * "unguarded asset" that earns Congklak its secondary `sec.risk` contribution
 * (10-04 m13); it is a secondary contribution only, and Congklak never claims
 * a primary security node.
 */
export function hasExposedPit(state: CongklakState, side: 1 | 2): boolean {
  if (!state.captureEnabled) return false;
  const { from, to } = rowOf(state, side);
  const opponent = otherSide(side);
  for (let i = from; i <= to; i++) {
    if ((state.pits[i] as number) === 0) continue;
    const across = oppositePit(state, i);
    if (!ownsPit(state, opponent, across)) continue;
    if ((state.pits[across] as number) === 0) return true;
  }
  return false;
}

/** Highest-seed pit among legal moves — the greedy choice, which usually loses. */
export function greedyPit(state: CongklakState): number | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;

  let best = -1;
  let bestCount = -1;
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i] as CongklakMove;
    if (move.kind !== 'sow') continue;
    const count = state.pits[move.pit] as number;
    // Ties break on the lower index so "the greedy move" is a single move.
    if (count > bestCount) {
      bestCount = count;
      best = move.pit;
    }
  }
  return best < 0 ? null : best;
}
