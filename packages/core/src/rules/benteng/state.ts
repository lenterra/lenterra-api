/**
 * Benteng board representation.
 *
 * The traditional yard game turns on one rule: **you may capture an opponent
 * only if you left your own base more recently than they left theirs.**
 * Touching your base refreshes your standing.
 *
 * That is not an analogy dressed up as security — it is structurally a
 * time-bounded credential. Being fresh is holding a valid token; being stale is
 * holding an expired one; returning to base is re-authentication; and a unit
 * standing deep in enemy territory on an old touch is a long-lived session on a
 * machine that should have re-authenticated an hour ago. All six `security`
 * skill nodes come out of this mechanic rather than out of theming (10-05).
 *
 * The digital adaptation is turn-based on a grid. The physical game is realtime
 * running, which the device floor, offline-first play, and replay determinism
 * all rule out. What is lost is athletic skill; what is kept — the reasoning
 * about freshness, exposure, and timing — is the part that teaches.
 */

export type Team = 1 | 2;

export interface Pos {
  x: number;
  y: number;
}

export interface BentengUnit {
  id: string;
  team: Team;
  x: number;
  y: number;
  /** The freshness clock. Freshness is `turn - lastTouchedBaseOnTurn`. */
  lastTouchedBaseOnTurn: number;
  captured: boolean;
}

export interface BentengBase {
  team: Team;
  x: number;
  y: number;
}

export interface BentengState {
  width: number;
  height: number;
  turn: number;
  toMove: Team;
  playerSide: Team;

  bases: BentengBase[];
  units: BentengUnit[];
  /** Captured units, held at the capturing team's base until rescued. */
  prisoners: { unitId: string; heldBy: Team }[];

  /** Exceeding this is a loss (rule 8). Every mission sets one. */
  turnLimit: number;
  /**
   * Turns after leaving base during which a unit is *not* yet capturable by a
   * staler opponent. 0 means the strict rule; missions may relax it for early
   * ranks so the concept lands before the pressure does.
   */
  freshnessWindow: number;

  // --- accumulated facts -------------------------------------------------
  /** Captures attempted with insufficient freshness. The `sec.access` signal. */
  illegalCaptureAttempts: number;
  /** Longest consecutive run of turns any player unit spent capturable. */
  maxExposureTurns: number;
  /** Current exposure run per unit id, for computing the maximum. */
  exposureRun: Record<string, number>;
  refreshCount: number;
  unitsLostBy: [number, number];
  rescuesPerformed: number;
  /** Turns the player's base had no unit within one step of it. */
  baseUndefendedTurns: number;
  /** Turns survived without losing a unit, for the `survive` goal. */
  turnsWithoutLoss: number;
  /** Turns the player's base has gone untouched by the opponent. */
  baseHeldTurns: number;

  outcome: 'playing' | 'won' | 'lost' | 'draw';
  finished: boolean;
}

export function otherTeam(team: Team): Team {
  return team === 1 ? 2 : 1;
}

export function teamIndex(team: Team): 0 | 1 {
  return team === 1 ? 0 : 1;
}

export function baseOf(state: BentengState, team: Team): BentengBase | null {
  for (let i = 0; i < state.bases.length; i++) {
    const base = state.bases[i] as BentengBase;
    if (base.team === team) return base;
  }
  return null;
}

/** Lower is stronger. A unit that has never touched base is maximally stale. */
export function freshnessOf(state: BentengState, unit: BentengUnit): number {
  return state.turn - unit.lastTouchedBaseOnTurn;
}

export function unitAt(state: BentengState, x: number, y: number): BentengUnit | null {
  for (let i = 0; i < state.units.length; i++) {
    const unit = state.units[i] as BentengUnit;
    if (!unit.captured && unit.x === x && unit.y === y) return unit;
  }
  return null;
}

export function unitById(state: BentengState, id: string): BentengUnit | null {
  for (let i = 0; i < state.units.length; i++) {
    const unit = state.units[i] as BentengUnit;
    if (unit.id === id) return unit;
  }
  return null;
}

export function activeUnits(state: BentengState, team: Team): BentengUnit[] {
  const out: BentengUnit[] = [];
  for (let i = 0; i < state.units.length; i++) {
    const unit = state.units[i] as BentengUnit;
    if (unit.team === team && !unit.captured) out.push(unit);
  }
  return out;
}

export function inBounds(state: BentengState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

/**
 * Could any enemy unit legally capture this one right now?
 *
 * This is the exposure signal. A win with nine exposed turns and a win with one
 * are not the same demonstration, which is why `maxExposureTurns` is tracked
 * rather than just the result (10-05 telemetry).
 */
export function isCapturable(state: BentengState, unit: BentengUnit): boolean {
  if (unit.captured) return false;
  const mine = freshnessOf(state, unit);
  const enemies = activeUnits(state, otherTeam(unit.team));

  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i] as BentengUnit;
    if (manhattan(enemy, unit) !== 1) continue; // one orthogonal step away
    if (freshnessOf(state, enemy) + state.freshnessWindow < mine) return true;
  }
  return false;
}

export function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function cloneState(state: BentengState): BentengState {
  const units: BentengUnit[] = [];
  for (let i = 0; i < state.units.length; i++) {
    const unit = state.units[i] as BentengUnit;
    units.push({
      id: unit.id,
      team: unit.team,
      x: unit.x,
      y: unit.y,
      lastTouchedBaseOnTurn: unit.lastTouchedBaseOnTurn,
      captured: unit.captured,
    });
  }

  const bases: BentengBase[] = [];
  for (let i = 0; i < state.bases.length; i++) {
    const base = state.bases[i] as BentengBase;
    bases.push({ team: base.team, x: base.x, y: base.y });
  }

  const prisoners: { unitId: string; heldBy: Team }[] = [];
  for (let i = 0; i < state.prisoners.length; i++) {
    const p = state.prisoners[i] as { unitId: string; heldBy: Team };
    prisoners.push({ unitId: p.unitId, heldBy: p.heldBy });
  }

  const exposureRun: Record<string, number> = {};
  const keys = Object.keys(state.exposureRun).sort();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    exposureRun[key] = state.exposureRun[key] as number;
  }

  return {
    width: state.width,
    height: state.height,
    turn: state.turn,
    toMove: state.toMove,
    playerSide: state.playerSide,
    bases,
    units,
    prisoners,
    turnLimit: state.turnLimit,
    freshnessWindow: state.freshnessWindow,
    illegalCaptureAttempts: state.illegalCaptureAttempts,
    maxExposureTurns: state.maxExposureTurns,
    exposureRun,
    refreshCount: state.refreshCount,
    unitsLostBy: [state.unitsLostBy[0], state.unitsLostBy[1]],
    rescuesPerformed: state.rescuesPerformed,
    baseUndefendedTurns: state.baseUndefendedTurns,
    turnsWithoutLoss: state.turnsWithoutLoss,
    baseHeldTurns: state.baseHeldTurns,
    outcome: state.outcome,
    finished: state.finished,
  };
}
