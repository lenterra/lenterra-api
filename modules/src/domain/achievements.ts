/**
 * Awarding achievements.
 *
 * The rule lives in `@lenterra/core` where it is testable at its boundaries;
 * this is the part that cannot be pure — reading the counts the rule needs and
 * writing the grants.
 *
 * Everything here runs *after* an attempt has been validated and its mastery
 * persisted, so an achievement can never be granted on evidence the server has
 * not already accepted.
 */

import type { GameId, Mission } from '@lenterra/core';
import { ACHIEVEMENTS, achievementsFrom } from '@lenterra/core';

import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { grantAchievement } from './ledger';

export { ACHIEVEMENTS };

export interface AttemptFacts {
  mission: Mission;
  success: boolean;
  priorSuccesses: number;
  chainMaxLength: number;
  unitsLost: number;
  streakDays: number;
  masteryAfter: { mastery: number; evidenceCount: number }[];
}

/**
 * Grant everything this attempt earned.
 *
 * Returns only what was *newly* granted: the insert is a no-op on a repeat, so
 * a student is never told twice about the same thing.
 */
export function evaluateForAttempt(c: Ctx, facts: AttemptFacts): string[] {
  if (!facts.success) return [];

  const totalRows = c.nk.sqlQuery(Q.validatedAttemptTotal, [c.userId]);
  const gameRows = c.nk.sqlQuery(Q.gamesPlayed, [c.userId]) as { game_id: string }[];

  const candidates = achievementsFrom({
    missionId: facts.mission.id,
    game: facts.mission.game as GameId,
    rank: facts.mission.rank,
    success: true,
    totalValidatedAttempts:
      totalRows.length > 0 ? Number((totalRows[0] as { n: number }).n) : 0,
    distinctGamesPlayed: gameRows.length,
    priorSuccesses: facts.priorSuccesses,
    chainMaxLength: facts.chainMaxLength,
    unitsLost: facts.unitsLost,
    streakDays: facts.streakDays,
    masteryAfter: facts.masteryAfter,
  });

  const earned: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i] as string;
    if (grantAchievement(c, c.userId, id)) earned.push(id);
  }
  return earned;
}

/** Pembaca — a whole course finished. Called from the course path. */
export function evaluateForCourse(c: Ctx, courseComplete: boolean): string[] {
  if (!courseComplete) return [];
  return grantAchievement(c, c.userId, ACHIEVEMENTS.reader) ? [ACHIEVEMENTS.reader] : [];
}
