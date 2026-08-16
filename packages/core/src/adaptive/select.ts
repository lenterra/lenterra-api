/**
 * Mission selection (20-06 "Mission selection", PRD-ADPT-003).
 *
 * Deterministic by construction (TRD-ADPT-004). That is not a nicety: the
 * client runs this same function offline from cached parameters, and the
 * server runs it as the authority. If selection had any randomness, a
 * divergence between the two would be unreadable — you could never tell a bug
 * from a coin flip.
 */

import type { GameId, MissionSummary } from '../types/mission';
import type { SkillNodeId } from '../types/taxonomy';
import { expectedScore, DEFAULT_RATING } from './elo';

export type RecommendationReason =
  | 'gap'
  | 'unevidenced'
  | 'reinforce'
  | 'placement'
  | 'recovery';

export interface MasteryView {
  value: number;
  evidenceCount: number;
  /** Epoch milliseconds, or null when there is no evidence. */
  lastEvidenceAt: number | null;
}

export interface SelectionInput {
  studentRatings: Partial<Record<GameId, number>>;
  mastery: Partial<Record<SkillNodeId, MasteryView>>;
  /** Unlocked missions from the catalog. */
  candidates: MissionSummary[];
  /** Last 10 mission IDs, most recent first. */
  recentMissionIds: string[];
  /** Dominant node of the last 5 attempts, most recent first. */
  recentSkillNodeIds: SkillNodeId[];
  consecutiveFailures: number;
  /** Epoch milliseconds. Passed in rather than read, to keep this pure. */
  now: number;
  /** True until the placement sequence is completed or skipped. */
  inPlacement?: boolean;
}

export interface Recommendation {
  missionId: string;
  contentVersion: number;
  gameId: GameId;
  reason: RecommendationReason;
  primarySkillNodeId: SkillNodeId;
  /** 0–1. Returned so a client/server divergence is detectable (PRD-ADPT-004). */
  predictedSuccess: number;
  displayReasonKey: string;
  /** Internal ranking score. Not shown to anyone; useful in telemetry. */
  score: number;
}

/** The productive band: hard enough to be worth doing, easy enough to finish. */
export const TARGET_SUCCESS = 0.675; // midpoint of the 0.60–0.75 band
export const RECOVERY_TARGET_SUCCESS = 0.85;
export const RECOVERY_MIN_PREDICTED = 0.8;
export const RECOVERY_TRIGGER_FAILURES = 3;
export const DECAY_ATTENTION_DAYS = 21;

const DAY_MS = 86_400_000;

/** Mission IDs are '<game>.<slug>', so the game is derivable without a lookup. */
export function gameOfMissionId(missionId: string): string {
  const dot = missionId.indexOf('.');
  return dot < 0 ? missionId : missionId.slice(0, dot);
}

/**
 * Pedagogical value of a candidate, keyed on its primary node.
 *
 * The 0.70–0.84 case scores highest because one success there changes the
 * band — the single most motivating thing that can happen in a session. An
 * already-mastered node scores 0.10 rather than 0 so it stays available as
 * variety when nothing better exists.
 */
export function gapScore(mission: MissionSummary, input: SelectionInput): number {
  const view = input.mastery[mission.primaryNode];

  if (!view || view.evidenceCount === 0) return 0.85; // no evidence at all

  const decaying =
    view.lastEvidenceAt !== null &&
    input.now - view.lastEvidenceAt >= DECAY_ATTENTION_DAYS * DAY_MS;

  const value = view.value;
  if (value >= 0.85) return decaying ? 0.6 : 0.1; // mastered
  if (value >= 0.7) return 1.0; // one success changes the band
  if (value >= 0.4) return decaying ? 0.7 : 0.7; // developing
  return decaying ? 0.6 : 0.55; // emerging
}

/**
 * Anti-drilling (PRD-ADPT-003).
 *
 * Without this, the mathematically optimal policy is to drill the weakest node
 * until the student quits — defensible as arithmetic and ruinous as pedagogy.
 */
export function varietyPenalty(mission: MissionSummary, input: SelectionInput): number {
  let penalty = 0;

  if (input.recentMissionIds.slice(0, 3).indexOf(mission.id) >= 0) penalty += 0.5;

  const lastTwoNodes = input.recentSkillNodeIds.slice(0, 2);
  if (
    lastTwoNodes.length === 2 &&
    lastTwoNodes[0] === mission.primaryNode &&
    lastTwoNodes[1] === mission.primaryNode
  ) {
    penalty += 0.3;
  }

  if (input.recentMissionIds.length > 0 && sameGameStreak(input) >= 5) {
    const lastGame = gameOfMissionId(input.recentMissionIds[0] as string);
    if (mission.gameId === lastGame) penalty += 0.2;
  }

  return penalty;
}

/** How many of the most recent missions in a row came from the same game. */
export function sameGameStreak(input: SelectionInput): number {
  if (input.recentMissionIds.length === 0) return 0;
  const game = gameOfMissionId(input.recentMissionIds[0] as string);
  let streak = 0;
  for (let i = 0; i < input.recentMissionIds.length; i++) {
    if (gameOfMissionId(input.recentMissionIds[i] as string) !== game) break;
    streak++;
  }
  return streak;
}

function reasonFor(mission: MissionSummary, input: SelectionInput): RecommendationReason {
  if (input.inPlacement) return 'placement';
  if (input.consecutiveFailures >= RECOVERY_TRIGGER_FAILURES) return 'recovery';

  const view = input.mastery[mission.primaryNode];
  if (!view || view.evidenceCount === 0) return 'unevidenced';
  if (view.value >= 0.85) return 'reinforce';
  if (
    view.lastEvidenceAt !== null &&
    input.now - view.lastEvidenceAt >= DECAY_ATTENTION_DAYS * DAY_MS
  ) {
    return 'reinforce';
  }
  return 'gap';
}

const REASON_KEYS: Record<RecommendationReason, string> = {
  gap: 'reco.reason.gap',
  unevidenced: 'reco.reason.unevidenced',
  reinforce: 'reco.reason.reinforce',
  placement: 'reco.reason.placement',
  recovery: 'reco.reason.recovery',
};

interface Scored {
  mission: MissionSummary;
  score: number;
  predicted: number;
  reason: RecommendationReason;
}

/**
 * Rank candidates and return the best `limit`.
 *
 * Weights: 0.5 difficulty fit, 0.4 pedagogical gap, 0.1 flat base. The base
 * term keeps every candidate above zero before penalties, so a heavily
 * penalised-but-only mission still surfaces rather than leaving a student with
 * nothing to play.
 */
export function selectMissions(input: SelectionInput, limit: number): Recommendation[] {
  if (limit <= 0 || input.candidates.length === 0) return [];

  const recovery = input.consecutiveFailures >= RECOVERY_TRIGGER_FAILURES;
  const targetSuccess = recovery ? RECOVERY_TARGET_SUCCESS : TARGET_SUCCESS;

  const scored: Scored[] = [];
  for (let i = 0; i < input.candidates.length; i++) {
    const mission = input.candidates[i] as MissionSummary;
    const rating = input.studentRatings[mission.gameId] ?? DEFAULT_RATING;
    const predicted = expectedScore(rating, mission.rating);

    // Distance from the target band, normalised so a 0.5 gap scores zero.
    const fit = 1 - Math.abs(predicted - targetSuccess) / 0.5;
    const gap = gapScore(mission, input);
    const penalty = varietyPenalty(mission, input);

    scored.push({
      mission,
      score: 0.5 * fit + 0.4 * gap + 0.1 - penalty,
      predicted,
      reason: reasonFor(mission, input),
    });
  }

  // Recovery must actually recover. TRD-ADPT's recovery test requires the next
  // recommendation to predict ≥0.80 success after three failures, so when any
  // candidate clears that bar the others are removed rather than merely
  // out-scored — a near-miss with a great gap score would otherwise win.
  let pool = scored;
  if (recovery) {
    const easy = scored.filter((s) => s.predicted >= RECOVERY_MIN_PREDICTED);
    if (easy.length > 0) {
      pool = easy;
    } else {
      // Nothing is easy enough. Take the easiest available rather than
      // handing a struggling student a fourth mission they will also fail.
      let best = scored[0] as Scored;
      for (let i = 1; i < scored.length; i++) {
        if ((scored[i] as Scored).predicted > best.predicted) best = scored[i] as Scored;
      }
      pool = [best];
    }
  }

  const ranked = pool
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Ties break on mission ID so the ordering is stable across platforms
      // and across runs (TRD-ADPT-004).
      return a.mission.id < b.mission.id ? -1 : a.mission.id > b.mission.id ? 1 : 0;
    });

  // Every candidate scored ≤ 0 — heavy penalties on a small catalog. Fall back
  // to the highest scorer so the student is never told there is nothing to do.
  const chosen =
    ranked.length > 0
      ? ranked.slice(0, limit)
      : pool
          .slice()
          .sort((a, b) =>
            b.score !== a.score
              ? b.score - a.score
              : a.mission.id < b.mission.id
                ? -1
                : a.mission.id > b.mission.id
                  ? 1
                  : 0,
          )
          .slice(0, limit);

  const out: Recommendation[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i] as Scored;
    out.push({
      missionId: s.mission.id,
      contentVersion: s.mission.contentVersion,
      gameId: s.mission.gameId,
      reason: s.reason,
      primarySkillNodeId: s.mission.primaryNode,
      predictedSuccess: s.predicted,
      displayReasonKey: REASON_KEYS[s.reason],
      score: s.score,
    });
  }
  return out;
}
