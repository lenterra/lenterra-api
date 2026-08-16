/**
 * Deterministic Congklak opponent, three tiers (PRD-GAME-003).
 *
 * Determinism is not a nicety here. The server re-executes every replay, and a
 * non-deterministic opponent would make every offline attempt unverifiable —
 * the validator would see a different AI move than the one recorded and reject
 * honest play. So `aiMove` is a pure function of `(state, tier, seed)` and the
 * seed lives in the mission definition.
 *
 * `mudah` still needs to look unpredictable to a student while being perfectly
 * predictable to the validator. That is what the seeded PRNG mixed with a
 * position fingerprint gives: the same board in the same mission always draws
 * the same "random" move, and a different board draws a different one.
 */

import type { AiTier } from '../../types/mission';
import { createRng } from '../../math';
import { applyMove, legalMoves, type CongklakMove } from './moves';
import {
  otherSide,
  scoreOf,
  seedsInRow,
  sideIndex,
  type CongklakState,
} from './state';

/** Search depth per tier. `sulit` is 3-ply; anything deeper blows the frame budget. */
const DEPTH: Record<AiTier, number> = { mudah: 0, sedang: 1, sulit: 3 };

/**
 * Cheap positional fingerprint, used only to vary the PRNG per position.
 *
 * Not a security hash — collisions cost nothing beyond two positions drawing
 * the same "random" pick. FNV-1a keeps it to a few operations per pit, which
 * matters because `mudah` runs this on every AI turn on a 2 GB phone.
 */
function positionFingerprint(state: CongklakState): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < state.pits.length; i++) {
    h ^= (state.pits[i] as number) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= state.toMove;
  h = Math.imul(h, 0x01000193) >>> 0;
  return h >>> 0;
}

/**
 * Position value from `side`'s point of view.
 *
 * Store difference dominates because that is what wins. Row material is
 * weighted lightly — seeds in your row are potential, not points — and
 * exposure is penalised so `sedang` and `sulit` avoid leaving pits open,
 * which is what makes them feel like opponents rather than move generators.
 */
export function evaluate(state: CongklakState, side: 1 | 2): number {
  const opponent = otherSide(side);
  const storeDiff = scoreOf(state, side) - scoreOf(state, opponent);
  const rowDiff = seedsInRow(state, side) - seedsInRow(state, opponent);
  const captured = state.capturedBy[sideIndex(side)] - state.capturedBy[sideIndex(opponent)];

  if (state.finished) {
    // A finished game is worth its result, scaled well above any positional
    // consideration so the search never trades a win for material.
    return storeDiff * 1000;
  }

  return storeDiff * 10 + rowDiff * 1 + captured * 2;
}

/** Negamax with a fixed depth. No pruning: the branching factor is 5–7. */
function search(state: CongklakState, side: 1 | 2, depth: number): number {
  if (depth <= 0 || state.finished) return evaluate(state, side);

  const moves = legalMoves(state);
  if (moves.length === 0) return evaluate(state, side);

  let best = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const result = applyMove(state, moves[i] as CongklakMove);
    // Congklak's extra-turn rule means the mover may not change. Negating only
    // when the turn actually passed is what keeps the search honest about
    // chains of extra turns — the thing that makes a strong player strong.
    const value = result.turnEnded
      ? -search(result.state, otherSide(state.toMove), depth - 1)
      : search(result.state, state.toMove, depth - 1);
    const fromSide = state.toMove === side ? value : -value;
    if (fromSide > best) best = fromSide;
  }
  return best;
}

/**
 * Choose a move. Returns null when there is nothing legal to play.
 *
 * Ties always break on the lowest pit index, so two runs on two platforms
 * cannot pick differently (TRD-ENG-002).
 */
export function aiMove(state: CongklakState, tier: AiTier, seed: number): CongklakMove | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;

  if (tier === 'mudah') {
    const rng = createRng((seed ^ positionFingerprint(state)) >>> 0);
    const index = Math.floor(rng() * moves.length) % moves.length;
    return moves[index] as CongklakMove;
  }

  const depth = DEPTH[tier];
  const side = state.toMove;

  let best: CongklakMove | null = null;
  let bestValue = -Infinity;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i] as CongklakMove;
    const result = applyMove(state, move);
    const value =
      depth <= 1
        ? evaluate(result.state, side)
        : result.turnEnded
          ? -search(result.state, otherSide(side), depth - 1)
          : search(result.state, side, depth - 1);

    if (value > bestValue) {
      bestValue = value;
      best = move;
    }
  }

  return best;
}

/**
 * Rank the student's move against the engine's ordering, 0 = best.
 *
 * This is `optimalMoveRank` (TRD-ENG-005), and it is the most valuable field
 * in the telemetry set: averaged over attempts it measures decision quality
 * independently of whether the student won, which a mission-completion count
 * cannot do. It also turns the demo's caption — "Anda Baru Saja Menjalankan
 * Gerakan Terbaik Ke 2 Dari 7" (games.tsx) — from a hardcoded string into a
 * real evaluation.
 */
export function rankMove(state: CongklakState, move: CongklakMove): number | null {
  if (move.kind !== 'sow') return null;

  const moves = legalMoves(state);
  if (moves.length === 0) return null;

  const side = state.toMove;
  const scored: { pit: number; value: number }[] = [];

  for (let i = 0; i < moves.length; i++) {
    const candidate = moves[i] as CongklakMove;
    if (candidate.kind !== 'sow') continue;
    const result = applyMove(state, candidate);
    scored.push({ pit: candidate.pit, value: evaluate(result.state, side) });
  }

  scored.sort((a, b) => (b.value !== a.value ? b.value - a.value : a.pit - b.pit));

  for (let i = 0; i < scored.length; i++) {
    if ((scored[i] as { pit: number }).pit === move.pit) return i;
  }
  return null;
}

/**
 * Number of legal moves — the denominator in "the 2nd best of 7 possible
 * moves" the result panel shows.
 */
export function legalMoveCount(state: CongklakState): number {
  return legalMoves(state).length;
}
