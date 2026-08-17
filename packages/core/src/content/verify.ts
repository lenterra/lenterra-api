/**
 * Verifying a mission by replaying an authored solution.
 *
 * The solver in `solver.ts` searches for a winning line. That works for
 * Congklak because the deterministic opponent collapses its branching to one
 * and the player has about five moves per turn. It does not work for every
 * Benteng mission: four units with four directions each is sixteen branches per
 * turn, and a `defend_base` goal is only satisfied at full depth, so there is
 * no early exit to prune with. Ten turns of that is 16^10.
 *
 * The answer is not a bigger budget. It is that an author who writes a mission
 * already knows how it is won — so they write that down, and validation
 * *replays* it. This is cheaper, and it is better content practice: the
 * reference line is reviewable, it documents the intended solution for whoever
 * reviews the mission, and it fails loudly the day a rules change breaks it.
 *
 * A mission may carry both. Where search is tractable it still runs, because a
 * reference line proves the mission is winnable and the search proves something
 * else — that the *obvious* move is not always the winning one.
 */

import type { GameEngine } from '../rules/types';
import type { Mission } from '../types/mission';

export interface LineVerification {
  achieved: boolean;
  /** Where it went wrong, when it did. */
  failedAtMove: number | null;
  reason: string | null;
  /** Player moves in the line. The AI's replies are not counted. */
  playerMoves: number;
}

/**
 * Replay an authored line and report whether it wins.
 *
 * The opponent is played by the engine's own deterministic AI, exactly as it
 * would be during play and during server-side replay validation — so a line
 * that verifies here is a line a student can actually follow.
 */
export function verifyLine<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  line: unknown[],
): LineVerification {
  let state = engine.init(mission.setup, mission.config);
  const tier = mission.constraints.aiTier ?? 'sedang';
  const seed = mission.seed;
  const playerSide = engine.playerSide(state);

  let playerMoves = 0;

  for (let i = 0; i < line.length; i++) {
    // Let the opponent take every turn that is theirs before the next
    // authored move, so the line only has to describe the player's decisions.
    let guard = 0;
    while (engine.sideToMove(state) !== playerSide && !engine.evaluateGoal(state, mission.goal).terminal) {
      const reply = engine.aiMove(state, tier, seed);
      if (reply === null) break;
      state = engine.applyMove(state, reply).state;
      if (++guard > 64) {
        return {
          achieved: false,
          failedAtMove: i,
          reason: 'the opponent never yielded the turn',
          playerMoves,
        };
      }
    }

    const status = engine.evaluateGoal(state, mission.goal);
    if (status.achieved) break;
    if (status.terminal) {
      return {
        achieved: false,
        failedAtMove: i,
        reason: 'the mission ended before the line did',
        playerMoves,
      };
    }

    const move = engine.parseMove(line[i]);
    if (move === null) {
      return { achieved: false, failedAtMove: i, reason: 'not a valid move', playerMoves };
    }
    if (!engine.isLegal(state, move)) {
      return { achieved: false, failedAtMove: i, reason: 'move is not legal here', playerMoves };
    }

    state = engine.applyMove(state, move).state;
    playerMoves++;
  }

  // Let the opponent finish any turn it is owed, so a defensive goal that is
  // satisfied by surviving the final turn is evaluated after that turn.
  let guard = 0;
  while (
    engine.sideToMove(state) !== playerSide &&
    !engine.evaluateGoal(state, mission.goal).terminal &&
    guard++ < 64
  ) {
    const reply = engine.aiMove(state, tier, seed);
    if (reply === null) break;
    state = engine.applyMove(state, reply).state;
  }

  const final = engine.evaluateGoal(state, mission.goal);
  return {
    achieved: final.achieved,
    failedAtMove: final.achieved ? null : line.length,
    reason: final.achieved ? null : 'the line ran out without achieving the goal',
    playerMoves,
  };
}

/**
 * Find a line by playing the engine's own move ranking.
 *
 * An authoring aid, not a validator. It answers "is there an obvious line that
 * works?" cheaply, so an author can start from it — and when it *does* find a
 * win on a mission that is meant to be hard, that is itself a finding: the
 * mission does not require the thinking it claims to.
 */
export function greedyLine<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  maxPlayerMoves = 24,
): { line: M[]; achieved: boolean } {
  let state = engine.init(mission.setup, mission.config);
  const tier = mission.constraints.aiTier ?? 'sedang';
  const playerSide = engine.playerSide(state);
  const line: M[] = [];

  for (let i = 0; i < maxPlayerMoves; i++) {
    let guard = 0;
    while (
      engine.sideToMove(state) !== playerSide &&
      !engine.evaluateGoal(state, mission.goal).terminal &&
      guard++ < 64
    ) {
      const reply = engine.aiMove(state, tier, mission.seed);
      if (reply === null) break;
      state = engine.applyMove(state, reply).state;
    }

    const status = engine.evaluateGoal(state, mission.goal);
    if (status.achieved) return { line, achieved: true };
    if (status.terminal) return { line, achieved: false };

    const moves = engine.legalMoves(state);
    if (moves.length === 0) return { line, achieved: false };

    // Best by the engine's own ranking, ties broken by order so the result is
    // deterministic and reproducible from the mission file alone.
    let best = moves[0] as M;
    let bestRank = engine.rankMove(state, best) ?? 0;
    for (let m = 1; m < moves.length; m++) {
      const candidate = moves[m] as M;
      const rank = engine.rankMove(state, candidate) ?? Number.MAX_SAFE_INTEGER;
      if (rank < bestRank) {
        best = candidate;
        bestRank = rank;
      }
    }

    state = engine.applyMove(state, best).state;
    line.push(best);
  }

  return { line, achieved: engine.evaluateGoal(state, mission.goal).achieved };
}
