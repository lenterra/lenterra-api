/**
 * Points, streaks, and achievements.
 *
 * The balance is always `SUM(delta)` over the ledger; no mutable counter exists
 * anywhere. A student who sees their balance change without a
 * visible reason reads it as the system cheating, and a counter that drifts
 * from its reasons is unrepairable — a ledger can always be re-summed.
 */

import type { Ctx } from '../lib/ctx';
import { utcDate } from '../lib/ctx';
import { Q } from '../db/queries';

/**
 * The points table (10-09).
 *
 * First completion is worth several repeats on purpose: points should reward
 * learning something, not grinding something already learned.
 */
export const POINTS = {
  missionFirst: 10,
  missionRepeat: 2,
  missionNewBand: 15,
  lessonComplete: 5,
  checkPassed: 8,
  streakDay: 3,
  certificate: 50,
} as const;

export interface PointsAward {
  delta: number;
  reason: string;
}

/**
 * Award points idempotently.
 *
 * The key is derived from the source, so replaying a sync batch cannot award
 * twice even if the caller forgets — which, over a term of offline retries, it
 * eventually would.
 */
export function award(
  c: Ctx,
  userId: string,
  delta: number,
  reason: string,
  sourceType: string,
  sourceId: string | null,
  key: string,
): PointsAward | null {
  if (delta === 0) return null;
  const rows = c.nk.sqlExec(Q.pointsAward, [
    c.nk.uuidv4(),
    userId,
    delta,
    reason,
    sourceType,
    sourceId,
    key,
  ]);
  // rowsAffected === 0 means this award already happened.
  if (rows.rowsAffected === 0) return null;
  return { delta, reason };
}

export function balance(c: Ctx, userId: string): number {
  const rows = c.nk.sqlQuery(Q.pointsBalance, [userId]);
  return rows.length === 0 ? 0 : Number((rows[0] as { balance: number }).balance);
}

export interface StreakState {
  currentDays: number;
  creditedToday: boolean;
}

/**
 * Credit a day toward the streak.
 *
 * The day boundary is UTC and the comparison is done in SQL, so two devices in
 * different timezones cannot both credit "today". A streak that can be farmed
 * by changing the device clock is not a streak.
 */
export function creditStreak(c: Ctx, userId: string): StreakState {
  const today = utcDate(c.now);
  const before = c.nk.sqlQuery(Q.streakRead, [userId]);
  const alreadyToday =
    before.length > 0 && (before[0] as { last_credit_date: string | null }).last_credit_date === today;

  const rows = c.nk.sqlQuery(Q.streakUpsert, [userId, today]);
  const current = rows.length > 0 ? Number((rows[0] as { current_days: number }).current_days) : 1;

  if (!alreadyToday) {
    award(c, userId, POINTS.streakDay, 'streak.day', 'streak', null, `streak:${userId}:${today}`);
  }

  return { currentDays: current, creditedToday: true };
}

export function grantAchievement(
  c: Ctx,
  userId: string,
  achievementId: string,
  awardedBy?: string,
): boolean {
  const rows = c.nk.sqlExec(Q.achievementAward, [userId, achievementId, awardedBy ?? null]);
  return rows.rowsAffected > 0;
}

export function achievementsOf(c: Ctx, userId: string): string[] {
  const rows = c.nk.sqlQuery(Q.achievementsForUser, [userId]) as { achievement_id: string }[];
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) out.push((rows[i] as { achievement_id: string }).achievement_id);
  return out;
}

/**
 * Anti-farming: how much a repeat of an already-passed mission is worth.
 *
 * Not zero. A student replaying a mission they enjoy should not be punished for
 * it — but the reward has to be small enough that grinding is a worse strategy
 * than progressing.
 */
export function pointsForAttempt(
  outcome: string,
  priorSuccesses: number,
  bandChanged: boolean,
): PointsAward[] {
  if (outcome !== 'success') return [];

  const awards: PointsAward[] = [];
  if (priorSuccesses === 0) {
    awards.push({ delta: POINTS.missionFirst, reason: 'mission.first' });
  } else {
    awards.push({ delta: POINTS.missionRepeat, reason: 'mission.repeat' });
  }
  if (bandChanged) awards.push({ delta: POINTS.missionNewBand, reason: 'mastery.band' });
  return awards;
}
