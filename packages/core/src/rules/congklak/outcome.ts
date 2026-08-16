/**
 * Goal evaluation for Congklak.
 *
 * Replaces the demo's single hardcoded condition — `newBoard[6] >= 2`, one
 * check serving as the win condition for every game card on the screen. Here a
 * mission declares its goal as data, and the same evaluator handles all twenty
 * missions in the ladder.
 *
 * `achieved` and `terminal` are separate on purpose. A goal can be met while
 * play continues (collect 6 seeds, then keep going), and play can end without
 * the goal being met. Only the pair distinguishes success from failure from
 * abandonment (20-07).
 */

import type { GoalStatus, MissionGoal } from '../../types/mission';
import { clamp01 } from '../../math';
import { otherSide, scoreOf, seedsInRow, sideIndex, type CongklakState } from './state';

export function evaluateGoal(state: CongklakState, goal: MissionGoal): GoalStatus {
  const player = state.playerSide;
  const p = sideIndex(player);

  switch (goal.kind) {
    case 'collect': {
      const have = scoreOf(state, player);
      return status(have >= goal.count, state.finished, have / Math.max(1, goal.count));
    }

    case 'outscore': {
      const margin = goal.margin ?? 1;
      const mine = scoreOf(state, player);
      const theirs = scoreOf(state, otherSide(player));
      // Only decidable when the game is over: a lead mid-game is not a win.
      return {
        achieved: state.finished && mine - theirs >= margin,
        terminal: state.finished,
        progress: clamp01((mine + 1) / Math.max(1, mine + theirs + 1)),
      };
    }

    case 'capture': {
      const have = state.capturedBy[p];
      return status(have >= goal.count, state.finished, have / Math.max(1, goal.count));
    }

    case 'chain': {
      const have = state.maxChainBy[p];
      return status(have >= goal.count, state.finished, have / Math.max(1, goal.count));
    }

    case 'extra_turns': {
      const have = goal.consecutive ? state.consecutiveExtraBy[p] : state.extraTurnsBy[p];
      return status(have >= goal.count, state.finished, have / Math.max(1, goal.count));
    }

    case 'clear_row': {
      const remaining = seedsInRow(state, player);
      return status(remaining === 0, state.finished || remaining === 0, remaining === 0 ? 1 : 0);
    }

    case 'predict_landing': {
      const have = state.correctPredictions;
      return status(have >= goal.count, state.finished, have / Math.max(1, goal.count));
    }

    case 'no_exposure': {
      // Achieved for as long as it holds; the moment it is broken it is
      // terminal, because a student who exposed a pit cannot un-expose it.
      const clean = state.exposureTurns === 0;
      return { achieved: clean, terminal: !clean || state.finished, progress: clean ? 1 : 0 };
    }

    case 'best_move': {
      const maxRank = goal.maxRank ?? 0;
      const ok = state.worstMoveRank <= maxRank;
      return { achieved: ok, terminal: !ok || state.finished, progress: ok ? 1 : 0 };
    }

    case 'within': {
      const inner = evaluateGoal(state, goal.goal);
      if (inner.achieved) return inner;
      // The budget is spent and the goal is not met: terminal failure.
      const spent = state.playerMoves >= goal.moves;
      return {
        achieved: false,
        terminal: spent || inner.terminal || state.finished,
        progress: inner.progress,
      };
    }

    case 'all': {
      let achieved = true;
      let terminal = false;
      let total = 0;
      for (let i = 0; i < goal.goals.length; i++) {
        const sub = evaluateGoal(state, goal.goals[i] as MissionGoal);
        if (!sub.achieved) achieved = false;
        // One sub-goal permanently failed makes the whole thing decided.
        if (sub.terminal && !sub.achieved) terminal = true;
        total += sub.progress;
      }
      return {
        achieved,
        terminal: terminal || achieved || state.finished,
        progress: goal.goals.length === 0 ? 1 : clamp01(total / goal.goals.length),
      };
    }

    // Benteng goals are not evaluable on a Congklak board. Reported as
    // non-terminal rather than thrown: a malformed mission definition should
    // fail content validation (10-12), not crash a student's session.
    case 'reach_base':
    case 'capture_units':
    case 'survive':
    case 'defend_base':
      return { achieved: false, terminal: state.finished, progress: 0 };

    default:
      return { achieved: false, terminal: state.finished, progress: 0 };
  }
}

function status(achieved: boolean, finished: boolean, progress: number): GoalStatus {
  return {
    achieved,
    // Achieving the goal ends the mission — a student who has done what was
    // asked should not have to keep playing to find out they succeeded.
    terminal: achieved || finished,
    progress: clamp01(progress),
  };
}
