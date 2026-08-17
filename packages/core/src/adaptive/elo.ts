/**
 * ELO difficulty matching (20-06).
 *
 * BKT says what a student knows. ELO says how hard a mission will *feel* —
 * which is a different question, because a mission's difficulty comes from its
 * construction as much as from the skills it touches.
 */

import { clamp } from '../math';

export const DEFAULT_RATING = 1000;

/** Probability the student succeeds, on the standard 400-point logistic scale. */
export function expectedScore(studentRating: number, missionRating: number): number {
  return 1 / (1 + Math.pow(10, (missionRating - studentRating) / 400));
}

export interface RatingUpdate {
  student: number;
  mission: number;
}

/**
 * Mission ratings move *opposite* to student ratings: a mission everyone beats
 * is easier than its rating claims.
 */
export function updateRatings(
  student: number,
  mission: number,
  success: boolean,
  kStudent: number,
  kMission: number,
): RatingUpdate {
  const expected = expectedScore(student, mission);
  const actual = success ? 1 : 0;
  return {
    student: student + kStudent * (actual - expected),
    mission: mission - kMission * (actual - expected),
  };
}

/**
 * Missions move slowly on purpose. If mission ratings drifted as fast as
 * student ratings, the difficulty scale itself would wander and cross-cohort
 * comparison would stop meaning anything.
 */
export function studentK(matchesPlayed: number): number {
  return matchesPlayed < 10 ? 40 : 20;
}

export function missionK(attempts: number): number {
  return attempts < 50 ? 8 : 2;
}

// ---------------------------------------------------------------------------
// Cold start
// ---------------------------------------------------------------------------

export const PLACEMENT_K = 60;
export const RATING_FLOOR = 700;
export const RATING_CEILING = 1600;

/**
 * Seed a rating from the three-mission placement sequence.
 *
 * K = 60 because three observations must move the estimate meaningfully.
 * Mission K = 0 because placement results must not distort the difficulty
 * scale — a cohort of new students would otherwise drag every early mission's
 * rating down within a week of a pilot starting.
 */
export function seedRatingFromPlacement(
  results: { missionRating: number; success: boolean }[],
): number {
  let rating = DEFAULT_RATING;
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as { missionRating: number; success: boolean };
    rating = updateRatings(rating, r.missionRating, r.success, PLACEMENT_K, 0).student;
  }
  return clamp(rating, RATING_FLOOR, RATING_CEILING);
}

/**
 * Difficulty spread for a student who skipped placement.
 *
 * One below, one at, and one above the assumed rating, rather than converging
 * on a guess that has no evidence behind it.
 */
export function skippedPlacementTargets(assumed: number = DEFAULT_RATING): number[] {
  return [assumed - 150, assumed, assumed + 150];
}
