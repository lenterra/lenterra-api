/**
 * The reference solver.
 *
 * Three checks in the content validation table need to actually play the game
 * (10-12):
 *
 *  - **Solvability.** Every published mission must have at least one winning
 *    line. A mission nobody can beat is not hard, it is broken, and a student
 *    who fails it six times has learned only that the product is unfair.
 *  - **Difficulty sanity.** The authored ELO must be within 200 of what play
 *    suggests, so the adaptive engine is not handed a number an author guessed.
 *  - **Greedy traps.** At least a third of the Congklak ladder must punish
 *    taking the fullest pit. That quota is the mechanism behind `algo.greedy`,
 *    the most valuable transfer concept in the game, and without a check it
 *    erodes silently as content is added.
 *
 * The search is only tractable because the opponent is deterministic: a fixed
 * `(state, tier, seed)` collapses the opponent's branching factor to one, so
 * the tree branches on player decisions alone.
 */

import type { AiTier, Mission } from '../types/mission';
import { createRng } from '../math';
import type { GameEngine } from '../rules/types';

export interface SolveOptions {
  /** Maximum player decisions to search. */
  maxDepth?: number;
  /** Abort after this many nodes, so a pathological mission cannot hang CI. */
  maxNodes?: number;
}

export interface SolveResult {
  solvable: boolean;
  /** The shortest winning line found, as moves in order. */
  line: unknown[];
  nodesVisited: number;
  /** True when the search hit its budget before proving unsolvable. */
  exhausted: boolean;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_NODES = 250_000;

/**
 * Breadth-first search for the shortest winning line.
 *
 * Breadth-first rather than depth-first because the shortest line is the one
 * worth showing an author: if a mission billed as a four-move puzzle is
 * winnable in one, the design is wrong even though the mission is "solvable".
 */
export function solve<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  options: SolveOptions = {},
): SolveResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const aiTier: AiTier = mission.constraints.aiTier ?? 'sedang';

  const start = engine.init(mission.setup, mission.config);
  const seen: Record<string, boolean> = {};
  let nodesVisited = 0;
  let exhausted = false;

  interface Node {
    state: S;
    line: M[];
  }

  let frontier: Node[] = [{ state: start, line: [] }];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: Node[] = [];

    for (let i = 0; i < frontier.length; i++) {
      const node = frontier[i] as Node;

      if (nodesVisited >= maxNodes) {
        exhausted = true;
        return { solvable: false, line: [], nodesVisited, exhausted };
      }

      const moves = engine.legalMoves(node.state);
      for (let m = 0; m < moves.length; m++) {
        nodesVisited++;

        let result = engine.applyMove(node.state, moves[m] as M);
        let state = result.state;
        const line = node.line.concat([moves[m] as M]);

        // Let the deterministic opponent reply until it is the student's turn
        // again. This is what keeps the tree small enough to search.
        let guard = 0;
        while (
          !engine.evaluateGoal(state, mission.goal).terminal &&
          engine.sideToMove(state) !== engine.playerSide(state) &&
          guard < 64
        ) {
          const reply = engine.aiMove(state, aiTier, mission.seed);
          if (!reply) break;
          state = engine.applyMove(state, reply).state;
          guard++;
        }

        const status = engine.evaluateGoal(state, mission.goal);
        if (status.achieved) {
          return { solvable: true, line: line as unknown[], nodesVisited, exhausted: false };
        }
        if (status.terminal) continue;

        // Transposition check. Distinct move orders reaching the same position
        // are the same subproblem, and on a 12-pit board they are common.
        const key = engine.hash(state);
        if (seen[key]) continue;
        seen[key] = true;

        next.push({ state, line });
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return { solvable: false, line: [], nodesVisited, exhausted };
}

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export interface DifficultyEstimate {
  /** Success rate of a naive player over the sampled playouts. */
  successRate: number;
  /** ELO implied by that rate against a 1000-rated student. */
  impliedElo: number;
  playouts: number;
  /** Mean number of *sow* choices the player faced. */
  meanBranching: number;
  /**
   * Whether the estimate says anything.
   *
   * Two ways it does not.
   *
   * Random play is a usable proxy for missions won by choosing well. It is a
   * terrible proxy for missions won by computing correctly: a mission with one
   * legal move is beaten by a random player every time and by a confused
   * student every time, which tells us nothing about its difficulty. Below two
   * average choices the number is noise.
   *
   * And a success rate of exactly 0 or 1 cannot be inverted into a rating. The
   * ELO curve is asymptotic there, so the number that comes back is whatever
   * the clamp happens to be — a property of the clamp, not of the mission. On a
   * grid game where a random walk essentially never traces a coherent path,
   * that is the common case, and reporting it as "play suggests ~1676" would
   * be inventing a measurement.
   */
  informative: boolean;
}

/**
 * Estimate difficulty by sampling.
 *
 * A naive player picks uniformly among legal moves. That is not how a student
 * plays, but it is a *stable* reference: the resulting rate orders missions
 * consistently, which is all the check needs — the real ratings are retuned
 * from pilot data anyway.
 */
export function estimateDifficulty<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  playouts = 400,
): DifficultyEstimate {
  const aiTier: AiTier = mission.constraints.aiTier ?? 'sedang';
  const maxMoves = mission.constraints.maxMoves ?? 60;
  let successes = 0;
  let choiceTotal = 0;
  let choicePoints = 0;

  for (let p = 0; p < playouts; p++) {
    // Seeded per playout, so the estimate is reproducible across machines and
    // a content check never flakes.
    const rng = createRng(mission.seed ^ (p * 2654435761));
    let state = engine.init(mission.setup, mission.config);

    for (let move = 0; move < maxMoves; move++) {
      const status = engine.evaluateGoal(state, mission.goal);
      if (status.terminal) break;

      if (engine.sideToMove(state) === engine.playerSide(state)) {
        const legal = engine.legalMoves(state);
        if (legal.length === 0) break;
        // Only sow decisions count toward branching. A prediction phase offers
        // one option per cell, which would inflate the figure without the
        // student facing any more real choice.
        if (isSowPhase(legal)) {
          choiceTotal += legal.length;
          choicePoints++;
        }
        state = engine.applyMove(state, legal[Math.floor(rng() * legal.length) % legal.length] as M).state;
      } else {
        const reply = engine.aiMove(state, aiTier, mission.seed);
        if (!reply) break;
        state = engine.applyMove(state, reply).state;
      }
    }

    if (engine.evaluateGoal(state, mission.goal).achieved) successes++;
  }

  const successRate = successes / playouts;
  const meanBranching = choicePoints === 0 ? 0 : choiceTotal / choicePoints;

  return {
    successRate,
    impliedElo: eloFromSuccessRate(successRate),
    playouts,
    meanBranching,
    informative: meanBranching >= 2 && successRate > 0 && successRate < 1,
  };
}

/** Heuristic: a prediction phase offers moves that are not sows. */
function isSowPhase(legal: unknown[]): boolean {
  if (legal.length === 0) return false;
  const first = legal[0] as { kind?: string };
  return first?.kind !== 'predict';
}

/**
 * Invert the ELO expectation for a 1000-rated student.
 *
 * Clamped at the tails because a 0% or 100% sample says "outside the range I
 * can measure", not "infinitely hard" or "infinitely easy".
 */
export function eloFromSuccessRate(rate: number, referenceRating = 1000): number {
  const clamped = Math.min(0.98, Math.max(0.02, rate));
  return Math.round(referenceRating + 400 * Math.log(1 / clamped - 1) / Math.LN10);
}

// ---------------------------------------------------------------------------
// Greedy traps
// ---------------------------------------------------------------------------

export interface GreedyTrapResult {
  /** The greedy first move loses, and some other first move wins. */
  isTrap: boolean;
  greedyMoveWins: boolean;
  alternativeWins: boolean;
  reason: string;
}

/**
 * Is this mission constructed so the fullest pit is the wrong choice?
 *
 * The check is deliberately strict in both directions. A mission where the
 * greedy move also wins is not a trap, and a mission where *nothing* wins is
 * broken rather than instructive.
 */
export function checkGreedyTrap<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  options: SolveOptions = {},
): GreedyTrapResult {
  const start = engine.init(mission.setup, mission.config);
  const moves = engine.legalMoves(start);

  if (moves.length < 2) {
    return {
      isTrap: false,
      greedyMoveWins: false,
      alternativeWins: false,
      reason: 'fewer than two legal opening moves — nothing to choose between',
    };
  }

  let greedy: M | null = null;
  for (let i = 0; i < moves.length; i++) {
    if (engine.isGreedyMove(start, moves[i] as M)) greedy = moves[i] as M;
  }
  if (greedy === null) {
    return {
      isTrap: false,
      greedyMoveWins: false,
      alternativeWins: false,
      reason: 'no greedy move is identifiable for this game',
    };
  }

  let greedyWins = false;
  let alternativeWins = false;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i] as M;
    const wins = solveFrom(engine, mission, move, options);
    if (engine.movesEqual(move, greedy)) greedyWins = wins;
    else if (wins) alternativeWins = true;
  }

  return {
    isTrap: !greedyWins && alternativeWins,
    greedyMoveWins: greedyWins,
    alternativeWins,
    reason: !greedyWins && alternativeWins
      ? 'the fullest pit loses and another opening wins'
      : greedyWins
        ? 'the fullest pit also wins, so nothing is being taught about greed'
        : 'no opening wins — the mission is unsolvable, not a trap',
  };
}

/** Solvability conditioned on a fixed first move. */
function solveFrom<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  first: M,
  options: SolveOptions,
): boolean {
  const start = engine.init(mission.setup, mission.config);
  if (!engine.isLegal(start, first)) return false;

  // A shallow probe: this runs once per opening move, and the question is only
  // whether *a* win exists, not how short it is.
  const forced = engine.applyMove(start, first).state;
  const probe: Mission = { ...mission, setup: mission.setup };

  const result = solveFromState(engine, probe, forced, options);
  return result.solvable;
}

function solveFromState<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  from: S,
  options: SolveOptions,
): SolveResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const aiTier: AiTier = mission.constraints.aiTier ?? 'sedang';

  const seen: Record<string, boolean> = {};
  let nodesVisited = 0;
  let frontier: S[] = [from];

  // The opening position may already be decided.
  const initial = engine.evaluateGoal(from, mission.goal);
  if (initial.achieved) return { solvable: true, line: [], nodesVisited, exhausted: false };
  if (initial.terminal) return { solvable: false, line: [], nodesVisited, exhausted: false };

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: S[] = [];

    for (let i = 0; i < frontier.length; i++) {
      let node = frontier[i] as S;

      let guard = 0;
      while (
        !engine.evaluateGoal(node, mission.goal).terminal &&
        engine.sideToMove(node) !== engine.playerSide(node) &&
        guard < 64
      ) {
        const reply = engine.aiMove(node, aiTier, mission.seed);
        if (!reply) break;
        node = engine.applyMove(node, reply).state;
        guard++;
      }

      const status = engine.evaluateGoal(node, mission.goal);
      if (status.achieved) return { solvable: true, line: [], nodesVisited, exhausted: false };
      if (status.terminal) continue;

      const moves = engine.legalMoves(node);
      for (let m = 0; m < moves.length; m++) {
        if (nodesVisited >= maxNodes) {
          return { solvable: false, line: [], nodesVisited, exhausted: true };
        }
        nodesVisited++;

        const state = engine.applyMove(node, moves[m] as M).state;
        const key = engine.hash(state);
        if (seen[key]) continue;
        seen[key] = true;
        next.push(state);
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return { solvable: false, line: [], nodesVisited, exhausted: false };
}
