/**
 * The class goal.
 *
 * The only R1 social mechanic where a stronger student gains from helping a
 * weaker one. Everything else on the board tab is a ranking, and a ranking is
 * zero-sum: helping a classmate can only cost you position. This is the
 * counterweight, and it is also what makes the "Guru Kecil" achievement mean
 * something rather than being a badge for being nice.
 *
 * **What is counted:** distinct (student, skill node) pairs that have reached
 * Proficient. Not validated attempts — attempts are what a strong student can
 * farm alone, by replaying missions they have already beaten, until the class
 * goal is met without anyone else's mastery moving at all. Counting nodes
 * instead means the cheapest way to move the number is for somebody who has not
 * reached Proficient to reach it, which is the behaviour the mechanic exists to
 * produce.
 *
 * **What the target is:** derived from class size, not set by anyone. A goal a
 * teacher has to configure is a goal most classes never get, and the shape of a
 * reachable target is a property of the arithmetic rather than a preference.
 */

import type { MasteryBand } from '../types/taxonomy';
import { bandRank } from '../types/taxonomy';

/**
 * Nodes per student the target assumes, on average.
 *
 * Three of seventeen. Deliberately low against what a student who finishes both
 * ladders reaches, because the requirement is that a class where several
 * students are struggling can still get there — which means the average has to
 * be carried, not met by everyone. One student reaching twelve covers four who
 * reach none.
 */
export const NODES_PER_STUDENT = 3;

/** Below this a class is too small for an average to mean anything. */
export const MIN_CLASS_TARGET = 6;

export interface ClassGoalInput {
  /** Active members, so a target does not count students who left. */
  memberCount: number;
  /** One entry per (student, node) pair that has any evidence at all. */
  bands: MasteryBand[];
}

export interface ClassGoal {
  /** Distinct (student, node) pairs at Proficient or above. */
  reached: number;
  target: number;
  /** 0–1, clamped. What the progress bar shows. */
  progress: number;
  achieved: boolean;
  /**
   * How many students have contributed at least one node.
   *
   * Shown alongside the total because the two together are the honest picture:
   * "40 of 90, from 11 of 30 students" says something a single number cannot,
   * and it is the sentence a teacher can act on.
   */
  contributors: number;
}

export function classGoalTarget(memberCount: number): number {
  if (memberCount <= 0) return MIN_CLASS_TARGET;
  return Math.max(MIN_CLASS_TARGET, memberCount * NODES_PER_STUDENT);
}

const PROFICIENT = bandRank('proficient');

export function isCounted(band: MasteryBand): boolean {
  return bandRank(band) >= PROFICIENT;
}

/**
 * Progress toward the class goal.
 *
 * `contributions` is per student so contributors can be counted without a
 * second query, and so the arithmetic is checkable against a roster.
 */
export function classGoal(
  memberCount: number,
  contributions: { userId: string; bands: MasteryBand[] }[],
): ClassGoal {
  let reached = 0;
  let contributors = 0;

  for (let i = 0; i < contributions.length; i++) {
    const student = contributions[i] as { userId: string; bands: MasteryBand[] };
    let mine = 0;
    for (let j = 0; j < student.bands.length; j++) {
      if (isCounted(student.bands[j] as MasteryBand)) mine++;
    }
    if (mine > 0) contributors++;
    reached += mine;
  }

  const target = classGoalTarget(memberCount);
  return {
    reached,
    target,
    // Clamped, because a class that overshoots has met the goal rather than
    // exceeded a quota — a bar past 100% invites a race nobody set.
    progress: target <= 0 ? 0 : Math.min(1, reached / target),
    achieved: reached >= target,
    contributors,
  };
}
