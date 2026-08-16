/**
 * Deterministic Benteng opponent (PRD-GAME-015).
 *
 * Tiers, per the spec: *mudah* advances toward the base and refreshes when
 * stale; *sedang* adds opportunistic capture and retreat; *sulit* runs a 2-ply
 * search with threat evaluation.
 *
 * The same determinism contract as Congklak: a pure function of state, tier,
 * and mission seed, because the server re-executes the replay.
 */

import type { AiTier } from '../../types/mission';
import { createRng } from '../../math';
import { applyMove, legalMoves, type BentengMove } from './moves';
import {
  activeUnits,
  baseOf,
  freshnessOf,
  isCapturable,
  manhattan,
  otherTeam,
  teamIndex,
  unitById,
  type BentengState,
  type BentengUnit,
  type Team,
} from './state';

function fingerprint(state: BentengState): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < state.units.length; i++) {
    const unit = state.units[i] as BentengUnit;
    h ^= unit.x & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= unit.y & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= unit.lastTouchedBaseOnTurn & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= unit.captured ? 1 : 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= state.turn;
  return Math.imul(h, 0x01000193) >>> 0;
}

/**
 * Position value from `team`'s point of view.
 *
 * Progress toward the enemy base is the objective; freshness is weighted
 * because a stale unit is a unit that cannot act on an opportunity; exposure is
 * penalised so the opponent does not obligingly walk into capture range. That
 * last term is what makes even *sedang* teach something — a student who leaves
 * a stale unit forward gets punished for it.
 */
export function evaluate(state: BentengState, team: Team): number {
  if (state.finished) {
    if (state.outcome === 'draw') return 0;
    const playerWon = state.outcome === 'won';
    const winner: Team = playerWon ? state.playerSide : otherTeam(state.playerSide);
    return winner === team ? 100000 : -100000;
  }

  const enemyBase = baseOf(state, otherTeam(team));
  const ownBase = baseOf(state, team);
  const mine = activeUnits(state, team);
  const theirs = activeUnits(state, otherTeam(team));

  let score = (mine.length - theirs.length) * 200;

  for (let i = 0; i < mine.length; i++) {
    const unit = mine[i] as BentengUnit;
    if (enemyBase) score -= manhattan(unit, enemyBase) * 8;
    score -= freshnessOf(state, unit) * 3;
    if (isCapturable(state, unit)) score -= 60;
  }

  for (let i = 0; i < theirs.length; i++) {
    const unit = theirs[i] as BentengUnit;
    if (ownBase) score += manhattan(unit, ownBase) * 6;
    if (isCapturable(state, unit)) score += 40;
  }

  score -= state.unitsLostBy[teamIndex(team)] * 150;
  return score;
}

function search(state: BentengState, team: Team, depth: number): number {
  if (depth <= 0 || state.finished) return evaluate(state, team);

  const moves = legalMoves(state);
  if (moves.length === 0) return evaluate(state, team);

  const maximising = state.toMove === team;
  let best = maximising ? -Infinity : Infinity;

  for (let i = 0; i < moves.length; i++) {
    const result = applyMove(state, moves[i] as BentengMove);
    const value = search(result.state, team, depth - 1);
    if (maximising ? value > best : value < best) best = value;
  }
  return best;
}

/** Stable ordering so ties resolve identically everywhere. */
function compareMoves(a: BentengMove, b: BentengMove): number {
  if (a.unitId !== b.unitId) return a.unitId < b.unitId ? -1 : 1;
  if (a.y !== b.y) return a.y - b.y;
  return a.x - b.x;
}

export function aiMove(state: BentengState, tier: AiTier, seed: number): BentengMove | null {
  const moves = legalMoves(state).slice().sort(compareMoves);
  if (moves.length === 0) return null;

  const team = state.toMove;

  if (tier === 'mudah') {
    // Advance toward the enemy base, but go home when badly stale. Simple
    // enough that a student can read the opponent's intent, which is the
    // point at rank 1–3.
    const enemyBase = baseOf(state, otherTeam(team));
    const ownBase = baseOf(state, team);

    let best: BentengMove | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i] as BentengMove;
      const unit = unitById(state, move.unitId);
      if (!unit) continue;

      const stale = freshnessOf(state, unit) >= 6;
      const target = stale ? ownBase : enemyBase;
      if (!target) continue;

      const before = manhattan(unit, target);
      const after = manhattan({ x: move.x, y: move.y }, target);
      let score = (before - after) * 10;

      // A little seeded jitter so *mudah* is not perfectly predictable to a
      // student while staying perfectly reproducible for the validator.
      const rng = createRng((seed ^ fingerprint(state) ^ (i * 2654435761)) >>> 0);
      score += rng();

      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return best ?? (moves[0] as BentengMove);
  }

  const depth = tier === 'sulit' ? 3 : 1;

  let best: BentengMove | null = null;
  let bestValue = -Infinity;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i] as BentengMove;
    const result = applyMove(state, move);
    const value = depth <= 1 ? evaluate(result.state, team) : search(result.state, team, depth - 1);
    if (value > bestValue) {
      bestValue = value;
      best = move;
    }
  }

  return best ?? (moves[0] as BentengMove);
}

/** Rank of a move under the engine's own evaluation, 0 = best. */
export function rankMove(state: BentengState, move: BentengMove): number | null {
  const moves = legalMoves(state).slice().sort(compareMoves);
  if (moves.length === 0) return null;

  const team = state.toMove;
  const scored: { move: BentengMove; value: number }[] = [];

  for (let i = 0; i < moves.length; i++) {
    const candidate = moves[i] as BentengMove;
    scored.push({ move: candidate, value: evaluate(applyMove(state, candidate).state, team) });
  }

  scored.sort((a, b) => (b.value !== a.value ? b.value - a.value : compareMoves(a.move, b.move)));

  for (let i = 0; i < scored.length; i++) {
    const entry = scored[i] as { move: BentengMove };
    if (
      entry.move.unitId === move.unitId &&
      entry.move.x === move.x &&
      entry.move.y === move.y
    ) {
      return i;
    }
  }
  return null;
}
