/**
 * Benteng move application.
 *
 * Rule 3 — capture requires strictly lower freshness — is the whole game. It is
 * implemented as an explicit comparison rather than folded into movement,
 * because a rejected capture is not an error to swallow: it is diagnostic
 * evidence for `sec.access` and must be reportable with both numbers.
 */

import type { MoveEvent, MoveResult } from '../types';
import {
  activeUnits,
  baseOf,
  cloneState,
  freshnessOf,
  inBounds,
  isCapturable,
  manhattan,
  otherTeam,
  teamIndex,
  unitAt,
  unitById,
  type BentengState,
  type BentengUnit,
  type Team,
} from './state';

export interface BentengMove {
  kind: 'move';
  unitId: string;
  /** Destination, one orthogonal step from the unit's current square. */
  x: number;
  y: number;
}

/** A capture rejected for staleness, with both numbers so the UI can state them. */
export interface FreshnessRejection {
  moverFreshness: number;
  targetFreshness: number;
}

export function legalMoves(state: BentengState): BentengMove[] {
  if (state.finished) return [];

  const moves: BentengMove[] = [];
  const units = activeUnits(state, state.toMove);
  // Sorted by unit id so the ordering is identical on every platform.
  units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const steps = [
    { dx: 0, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
  ];

  for (let i = 0; i < units.length; i++) {
    const unit = units[i] as BentengUnit;
    for (let s = 0; s < steps.length; s++) {
      const step = steps[s] as { dx: number; dy: number };
      const x = unit.x + step.dx;
      const y = unit.y + step.dy;
      const move: BentengMove = { kind: 'move', unitId: unit.id, x, y };
      if (isLegal(state, move)) moves.push(move);
    }
  }
  return moves;
}

/**
 * Legality, including the freshness check.
 *
 * An attempted capture by a staler unit is **illegal**, not merely
 * unsuccessful. `applyMove` records the attempt before rejecting it, which is
 * what turns a repeated misconception into a measurable one.
 */
export function isLegal(state: BentengState, move: BentengMove): boolean {
  return legalityOf(state, move).legal;
}

export function legalityOf(
  state: BentengState,
  move: BentengMove,
): { legal: boolean; reason?: 'not_found' | 'not_yours' | 'out_of_bounds' | 'not_adjacent' | 'occupied_ally' | 'stale'; rejection?: FreshnessRejection } {
  if (state.finished) return { legal: false, reason: 'not_found' };

  const unit = unitById(state, move.unitId);
  if (!unit || unit.captured) return { legal: false, reason: 'not_found' };
  if (unit.team !== state.toMove) return { legal: false, reason: 'not_yours' };
  if (!inBounds(state, move.x, move.y)) return { legal: false, reason: 'out_of_bounds' };
  if (manhattan(unit, { x: move.x, y: move.y }) !== 1) return { legal: false, reason: 'not_adjacent' };

  const occupant = unitAt(state, move.x, move.y);
  if (occupant) {
    if (occupant.team === unit.team) return { legal: false, reason: 'occupied_ally' };

    const moverFreshness = freshnessOf(state, unit);
    const targetFreshness = freshnessOf(state, occupant);

    // Strictly fresher, by more than the mission's grace window. Equal
    // freshness does not permit a capture — a tie between two equally-aged
    // credentials should not resolve in the aggressor's favour, and making it
    // strict keeps the rule stateable in one sentence.
    //
    // The window is the same one `isCapturable` applies, and it has to be:
    // that function decides what the board marks as takeable and what the
    // exposure metric counts, so a legality rule that ignored it would mark a
    // unit safe and then let it be taken anyway. An early rank relaxes the
    // window so a student reads freshness numbers before they are punished for
    // misreading them, and a relaxation that did not actually protect anything
    // would be a brief making a promise the rules break.
    if (moverFreshness + state.freshnessWindow >= targetFreshness) {
      return { legal: false, reason: 'stale', rejection: { moverFreshness, targetFreshness } };
    }
  }

  return { legal: true };
}

export function applyMove(state: BentengState, move: BentengMove): MoveResult<BentengState> {
  const events: MoveEvent[] = [];
  const legality = legalityOf(state, move);

  if (!legality.legal) {
    // A stale capture attempt is recorded and the turn is *not* consumed. The
    // student learns the rule by being told the two numbers, not by losing a
    // turn to it.
    if (legality.reason === 'stale') {
      const next = cloneState(state);
      next.illegalCaptureAttempts++;
      return { state: next, events, turnEnded: false };
    }
    return { state, events, turnEnded: false };
  }

  const next = cloneState(state);
  const mover = unitById(next, move.unitId) as BentengUnit;
  const moverTeam = mover.team;

  // --- capture ------------------------------------------------------------
  const occupant = unitAt(next, move.x, move.y);
  if (occupant) {
    occupant.captured = true;
    next.prisoners.push({ unitId: occupant.id, heldBy: moverTeam });
    next.unitsLostBy[teamIndex(occupant.team)]++;
    const capturingBase = baseOf(next, moverTeam);
    if (capturingBase) {
      occupant.x = capturingBase.x;
      occupant.y = capturingBase.y;
    }
    events.push({
      kind: 'capture',
      index: gridIndex(next, mover.x, mover.y),
      target: gridIndex(next, move.x, move.y),
      side: moverTeam,
    });
    if (occupant.team === next.playerSide) next.turnsWithoutLoss = 0;
  }

  // --- move ---------------------------------------------------------------
  const fromIndex = gridIndex(next, mover.x, mover.y);
  mover.x = move.x;
  mover.y = move.y;
  events.push({
    kind: 'move',
    index: fromIndex,
    target: gridIndex(next, move.x, move.y),
    side: moverTeam,
  });

  // --- rescue (rule 5) ----------------------------------------------------
  // Reaching a prisoner's square frees it; the freed unit returns to its own
  // base at freshness 0. Checked before the refresh so a rescue at your own
  // base does both.
  for (let i = next.prisoners.length - 1; i >= 0; i--) {
    const prisoner = next.prisoners[i] as { unitId: string; heldBy: Team };
    const held = unitById(next, prisoner.unitId);
    if (!held || held.team !== moverTeam) continue;
    if (held.x !== mover.x || held.y !== mover.y) continue;

    const home = baseOf(next, moverTeam);
    held.captured = false;
    held.lastTouchedBaseOnTurn = next.turn;
    if (home) {
      held.x = home.x;
      held.y = home.y;
    }
    next.prisoners.splice(i, 1);
    next.unitsLostBy[teamIndex(moverTeam)] = Math.max(
      0,
      next.unitsLostBy[teamIndex(moverTeam)] - 1,
    );
    if (moverTeam === next.playerSide) next.rescuesPerformed++;
    events.push({ kind: 'move', target: gridIndex(next, held.x, held.y), side: moverTeam });
  }

  // --- refresh (rule 2) ---------------------------------------------------
  const ownBase = baseOf(next, moverTeam);
  if (ownBase && mover.x === ownBase.x && mover.y === ownBase.y) {
    mover.lastTouchedBaseOnTurn = next.turn;
    if (moverTeam === next.playerSide) next.refreshCount++;
    events.push({ kind: 'extraTurn', index: gridIndex(next, mover.x, mover.y), side: moverTeam });
  }

  // --- win by reaching the enemy base (rules 6, 7) -----------------------
  const enemyBase = baseOf(next, otherTeam(moverTeam));
  if (enemyBase && mover.x === enemyBase.x && mover.y === enemyBase.y) {
    next.outcome = moverTeam === next.playerSide ? 'won' : 'lost';
    next.finished = true;
    events.push({ kind: 'gameEnd', side: moverTeam });
    return { state: next, events, turnEnded: true };
  }

  advanceTurn(next, events);
  return { state: next, events, turnEnded: true };
}

/**
 * End of turn: accounting, then the loss conditions.
 *
 * Exposure is measured here rather than during the move because a unit's
 * exposure is a property of the position it *ends* in — that is what an
 * opponent gets to act on.
 */
export function advanceTurn(state: BentengState, events: MoveEvent[]): void {
  const previous = state.toMove;
  state.toMove = otherTeam(previous);

  // A full round has passed once play returns to the player.
  if (state.toMove === state.playerSide) {
    state.turn++;
    state.turnsWithoutLoss++;

    const playerUnits = activeUnits(state, state.playerSide);
    for (let i = 0; i < playerUnits.length; i++) {
      const unit = playerUnits[i] as BentengUnit;
      if (isCapturable(state, unit)) {
        const run = (state.exposureRun[unit.id] ?? 0) + 1;
        state.exposureRun[unit.id] = run;
        if (run > state.maxExposureTurns) state.maxExposureTurns = run;
      } else {
        state.exposureRun[unit.id] = 0;
      }
    }

    const home = baseOf(state, state.playerSide);
    if (home) {
      let defended = false;
      for (let i = 0; i < playerUnits.length; i++) {
        if (manhattan(playerUnits[i] as BentengUnit, home) <= 1) {
          defended = true;
          break;
        }
      }
      if (!defended) state.baseUndefendedTurns++;
    }

    let enemyOnBase = false;
    const enemies = activeUnits(state, otherTeam(state.playerSide));
    if (home) {
      for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i] as BentengUnit;
        if (enemy.x === home.x && enemy.y === home.y) enemyOnBase = true;
      }
    }
    state.baseHeldTurns = enemyOnBase ? 0 : state.baseHeldTurns + 1;
  }

  // Rule 7: all of a side's units captured.
  if (activeUnits(state, state.playerSide).length === 0) {
    state.outcome = 'lost';
    state.finished = true;
    events.push({ kind: 'gameEnd', side: otherTeam(state.playerSide) });
    return;
  }
  if (activeUnits(state, otherTeam(state.playerSide)).length === 0) {
    state.outcome = 'won';
    state.finished = true;
    events.push({ kind: 'gameEnd', side: state.playerSide });
    return;
  }

  // Rule 8: the turn limit. A draw rather than a loss, because the goal
  // evaluator decides what the mission required — a `defend_base` mission is
  // *won* by reaching the limit.
  if (state.turn >= state.turnLimit) {
    state.outcome = 'draw';
    state.finished = true;
    events.push({ kind: 'gameEnd' });
  }
}

/** Flat cell index, used only in events so the animation can address a square. */
export function gridIndex(state: BentengState, x: number, y: number): number {
  return y * state.width + x;
}

/** Longest current exposure run, for `maxExposureTurns` reporting. */
export function currentExposure(state: BentengState): number {
  return state.maxExposureTurns;
}
