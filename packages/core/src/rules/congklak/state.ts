/**
 * Congklak board representation.
 *
 * The demo's shape is preserved exactly — a flat array where index 0 and the
 * midpoint are the two stores (*lumbung*) — because it is correct and because
 * preserving it means the characterisation tests written against the existing
 * implementation stay meaningful through the extraction (30-01).
 *
 * For the default 5-pit board (12 cells):
 *
 *          A5  A4  A3  A2  A1        ← player 2's row, indices 5…1
 *     H2                     H1      ← stores: index 0 (P2), index 6 (P1)
 *          B1  B2  B3  B4  B5        ← player 1's row, indices 7…11
 *
 * Sowing runs counter-clockwise as `(i + 1) % size`, and a player skips the
 * opponent's store — the same arithmetic the demo used.
 */

export interface CongklakState {
  /** 2·pitsPerSide + 2 cells. Two are stores; the rest hold seeds. */
  pits: number[];
  toMove: 1 | 2;
  /** Which side the student controls; the other is the opponent or AI. */
  playerSide: 1 | 2;
  /** Completed player turns since the attempt began. */
  turn: number;

  // --- accumulated facts the goal evaluator needs -------------------------
  /** Seeds captured by each side via the capture rule. */
  capturedBy: [number, number];
  /** Extra turns earned by each side. */
  extraTurnsBy: [number, number];
  /** Longest continuation chain achieved by each side, in links. */
  maxChainBy: [number, number];
  /** Consecutive extra turns most recently earned by each side. */
  consecutiveExtraBy: [number, number];
  /** Turns on which the player left a capturable pit exposed (m13). */
  exposureTurns: number;
  /** Sow moves made by the student. Drives the `within` move budget. */
  playerMoves: number;
  /**
   * Worst rank any student move scored against the engine's own ordering,
   * 0 = always played the best move. Set by the engine wrapper, which is where
   * both the rules and the evaluator are in scope. Drives `best_move`.
   */
  worstMoveRank: number;
  /** Correct landing-pit predictions by the player (m05). */
  correctPredictions: number;
  /** A prediction awaiting its sow, or null. */
  pendingPrediction: number | null;
  /** Set once no further play can change the result. */
  finished: boolean;

  // --- config, resolved at init ------------------------------------------
  extraTurnOnStore: boolean;
  captureEnabled: boolean;
  continuationEnabled: boolean;
  sweepOnEnd: boolean;
}

export const DEFAULT_PITS_PER_SIDE = 5;
export const DEFAULT_SEEDS_PER_PIT = 7;

export function pitsPerSide(state: CongklakState): number {
  return (state.pits.length - 2) / 2;
}

/** Store index for a side. Player 2 owns index 0; player 1 owns the midpoint. */
export function storeOf(state: CongklakState, side: 1 | 2): number {
  return side === 2 ? 0 : pitsPerSide(state) + 1;
}

export function isStore(state: CongklakState, index: number): boolean {
  return index === 0 || index === pitsPerSide(state) + 1;
}

/** Inclusive range of a side's playable pits. */
export function rowOf(state: CongklakState, side: 1 | 2): { from: number; to: number } {
  const n = pitsPerSide(state);
  return side === 2 ? { from: 1, to: n } : { from: n + 2, to: 2 * n + 1 };
}

export function ownsPit(state: CongklakState, side: 1 | 2, index: number): boolean {
  const row = rowOf(state, side);
  return index >= row.from && index <= row.to;
}

/**
 * The pit directly across the board.
 *
 * With the store at index 0 and the midpoint, the geometry collapses to
 * `size - index`: on a 12-cell board B1(7) faces A5(5), B5(11) faces A1(1).
 * Stores have no opposite.
 */
export function oppositePit(state: CongklakState, index: number): number {
  return state.pits.length - index;
}

export function seedsInRow(state: CongklakState, side: 1 | 2): number {
  const { from, to } = rowOf(state, side);
  let total = 0;
  for (let i = from; i <= to; i++) total += state.pits[i] as number;
  return total;
}

export function scoreOf(state: CongklakState, side: 1 | 2): number {
  return state.pits[storeOf(state, side)] as number;
}

export function otherSide(side: 1 | 2): 1 | 2 {
  return side === 1 ? 2 : 1;
}

/** Index into the paired accumulators above. */
export function sideIndex(side: 1 | 2): 0 | 1 {
  return side === 1 ? 0 : 1;
}

export function cloneState(state: CongklakState): CongklakState {
  return {
    pits: state.pits.slice(),
    toMove: state.toMove,
    playerSide: state.playerSide,
    turn: state.turn,
    capturedBy: [state.capturedBy[0], state.capturedBy[1]],
    extraTurnsBy: [state.extraTurnsBy[0], state.extraTurnsBy[1]],
    maxChainBy: [state.maxChainBy[0], state.maxChainBy[1]],
    consecutiveExtraBy: [state.consecutiveExtraBy[0], state.consecutiveExtraBy[1]],
    exposureTurns: state.exposureTurns,
    playerMoves: state.playerMoves,
    worstMoveRank: state.worstMoveRank,
    correctPredictions: state.correctPredictions,
    pendingPrediction: state.pendingPrediction,
    finished: state.finished,
    extraTurnOnStore: state.extraTurnOnStore,
    captureEnabled: state.captureEnabled,
    continuationEnabled: state.continuationEnabled,
    sweepOnEnd: state.sweepOnEnd,
  };
}

/** A standard starting board, used by fixtures and by missions that omit one. */
export function standardBoard(
  perSide: number = DEFAULT_PITS_PER_SIDE,
  seeds: number = DEFAULT_SEEDS_PER_PIT,
): number[] {
  const size = 2 * perSide + 2;
  const pits: number[] = [];
  for (let i = 0; i < size; i++) {
    pits.push(i === 0 || i === perSide + 1 ? 0 : seeds);
  }
  return pits;
}
