/**
 * Achievements (PRD-RWD-011).
 *
 * The set is small and deliberately varied. Four of the nine are reachable
 * without competing against anyone — the requirement is at least three — and
 * one, *Guru Kecil*, cannot be earned by software at all: a teacher awards it
 * for helping a classmate. That is the only recognition in the product for
 * something the system cannot observe, and it exists so the dashboard has a
 * reason to be opened that is not surveillance.
 *
 * The rule is pure so it can be tested at its boundaries. Whether a student
 * *already holds* an achievement is a storage question, answered by the caller.
 */

import { bandOf } from '../types/taxonomy';
import type { GameId } from '../types/mission';

export const ACHIEVEMENTS = {
  firstMission: 'ach.langkah-pertama',
  bothGames: 'ach.penjelajah',
  goldenChain: 'ach.rantai-emas',
  fortressKeeper: 'ach.penjaga-benteng',
  notGreedy: 'ach.bukan-serakah',
  sevenDays: 'ach.tujuh-hari',
  firstMastery: 'ach.ahli-pertama',
  /** Teacher-awarded only. Never returned by `achievementsFrom`. */
  littleTeacher: 'ach.guru-kecil',
  reader: 'ach.pembaca',
} as const;

export const TEACHER_AWARDED: readonly string[] = [ACHIEVEMENTS.littleTeacher];

/** Ranks 15–18 are Tier 4, where the greedy move stops being the right one. */
export function isGreedyTrapRank(game: GameId, rank: number): boolean {
  return game === 'congklak' && rank >= 15 && rank <= 18;
}

/** The mission that tests holding a position rather than taking one. */
export const FORTRESS_MISSION_ID = 'benteng.m08';

export interface AchievementFacts {
  missionId: string;
  game: GameId;
  rank: number;
  success: boolean;
  /** Validated attempts by this student, including the one being processed. */
  totalValidatedAttempts: number;
  /** Distinct games with at least one validated attempt. */
  distinctGamesPlayed: number;
  /** Successes on this mission *before* this one. */
  priorSuccesses: number;
  chainMaxLength: number;
  unitsLost: number;
  streakDays: number;
  masteryAfter: { mastery: number; evidenceCount: number }[];
}

/**
 * Every achievement these facts earn.
 *
 * Failure earns nothing: an achievement is a claim about a demonstrated
 * ability, and the product has other ways to acknowledge effort.
 */
export function achievementsFrom(facts: AchievementFacts): string[] {
  if (!facts.success) return [];

  const earned: string[] = [];

  // The attempt being processed is included in the count, so 1 is the first.
  if (facts.totalValidatedAttempts <= 1) earned.push(ACHIEVEMENTS.firstMission);

  // Both games *played*, not both won: the point is to have tried the other
  // one, and gating on a win would make it a second difficulty prize.
  if (facts.distinctGamesPlayed >= 2) earned.push(ACHIEVEMENTS.bothGames);

  // A six-link continuation chain happens to a student who understood the
  // rule, not to one who played a lot.
  if (facts.chainMaxLength >= 6) earned.push(ACHIEVEMENTS.goldenChain);

  if (facts.missionId === FORTRESS_MISSION_ID && facts.unitsLost === 0) {
    earned.push(ACHIEVEMENTS.fortressKeeper);
  }

  // First time is the whole claim: a greedy trap only tests anything before
  // you have seen the answer.
  if (isGreedyTrapRank(facts.game, facts.rank) && facts.priorSuccesses === 0) {
    earned.push(ACHIEVEMENTS.notGreedy);
  }

  if (facts.streakDays >= 7) earned.push(ACHIEVEMENTS.sevenDays);

  for (let i = 0; i < facts.masteryAfter.length; i++) {
    const node = facts.masteryAfter[i] as { mastery: number; evidenceCount: number };
    if (bandOf(node.mastery, node.evidenceCount) === 'mastered') {
      earned.push(ACHIEVEMENTS.firstMastery);
      break;
    }
  }

  return earned;
}
