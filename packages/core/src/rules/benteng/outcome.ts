/**
 * Goal evaluation for Benteng.
 */

import type { GoalStatus, MissionGoal } from '../../types/mission';
import { clamp01 } from '../../math';
import { activeUnits, otherTeam, teamIndex, type BentengState } from './state';

export function evaluateGoal(state: BentengState, goal: MissionGoal): GoalStatus {
  const player = state.playerSide;

  switch (goal.kind) {
    case 'reach_base':
      return {
        achieved: state.outcome === 'won',
        terminal: state.finished,
        progress: state.outcome === 'won' ? 1 : 0,
      };

    case 'capture_units': {
      const captured = state.unitsLostBy[teamIndex(otherTeam(player))];
      return status(captured >= goal.count, state.finished, captured / Math.max(1, goal.count));
    }

    case 'survive': {
      const survived = state.turnsWithoutLoss;
      return status(survived >= goal.turns, state.finished, survived / Math.max(1, goal.turns));
    }

    case 'defend_base': {
      const held = state.baseHeldTurns;
      // A lost game can never satisfy a defence goal, even if the counter ran.
      const achieved = held >= goal.turns && state.outcome !== 'lost';
      return {
        achieved,
        terminal: achieved || state.finished,
        progress: clamp01(held / Math.max(1, goal.turns)),
      };
    }

    case 'no_exposure': {
      const clean = state.maxExposureTurns === 0;
      return { achieved: clean, terminal: !clean || state.finished, progress: clean ? 1 : 0 };
    }

    case 'outscore': {
      // Benteng has no score; "outscoring" means winning the game.
      return {
        achieved: state.outcome === 'won',
        terminal: state.finished,
        progress: state.outcome === 'won' ? 1 : 0,
      };
    }

    case 'within': {
      const inner = evaluateGoal(state, goal.goal);
      if (inner.achieved) return inner;
      return {
        achieved: false,
        terminal: state.turn >= goal.moves || inner.terminal || state.finished,
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
        if (sub.terminal && !sub.achieved) terminal = true;
        total += sub.progress;
      }
      return {
        achieved,
        terminal: terminal || achieved || state.finished,
        progress: goal.goals.length === 0 ? 1 : clamp01(total / goal.goals.length),
      };
    }

    // Congklak goals on a Benteng board: not evaluable. Reported as unmet
    // rather than thrown — a malformed mission should fail content validation
    // (10-12), not crash a student's session.
    default:
      return { achieved: false, terminal: state.finished, progress: 0 };
  }
}

/** Player units still on the board — used by hints and the AI's evaluation. */
export function playerStrength(state: BentengState): number {
  return activeUnits(state, state.playerSide).length;
}

function status(achieved: boolean, finished: boolean, progress: number): GoalStatus {
  return { achieved, terminal: achieved || finished, progress: clamp01(progress) };
}
