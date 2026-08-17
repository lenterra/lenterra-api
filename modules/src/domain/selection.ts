/**
 * Recommendation assembly.
 *
 * The ranking itself is @lenterra/core's `selectMissions`, which the client
 * also runs offline. This module gathers the inputs it needs from the database
 * — and nothing more, so that a divergence between the client's offline pick
 * and the server's is always a difference in *inputs*, which is diagnosable,
 * rather than a difference in logic, which is not.
 */

import type { GameId, MissionSummary, Recommendation, SkillNodeId } from '@lenterra/core';
import { DEFAULT_RATING, primaryNodeOf, selectMissions } from '@lenterra/core';

import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { missionSummaries } from './catalog';
import { readMastery } from './mastery';

export interface Assignment {
  id: string;
  kind: 'mission' | 'lesson';
  targetId: string;
  note?: string;
}

export function studentRatings(c: Ctx, userId: string): Partial<Record<GameId, number>> {
  const rows = c.nk.sqlQuery(Q.studentRating, [userId]) as {
    game_id: GameId;
    rating: number;
  }[];
  const out: Partial<Record<GameId, number>> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { game_id: GameId; rating: number };
    out[row.game_id] = Number(row.rating);
  }
  return out;
}

export function matchesPlayed(c: Ctx, userId: string, gameId: GameId): number {
  const rows = c.nk.sqlQuery(Q.studentRating, [userId]) as {
    game_id: GameId;
    matches: number;
  }[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { game_id: GameId; matches: number };
    if (row.game_id === gameId) return Number(row.matches);
  }
  return 0;
}

export interface RecommendationContext {
  recommendations: Recommendation[];
  assignment: Assignment | null;
}

export function recommend(
  c: Ctx,
  userId: string,
  catalogVersion: string,
  limit: number,
  gameId?: GameId,
): RecommendationContext {
  let candidates = missionSummaries(c, catalogVersion);
  if (gameId) {
    const filtered: MissionSummary[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const mission = candidates[i] as MissionSummary;
      if (mission.gameId === gameId) filtered.push(mission);
    }
    candidates = filtered;
  }

  const snapshot = readMastery(c, userId);
  const mastery: Partial<
    Record<SkillNodeId, { value: number; evidenceCount: number; lastEvidenceAt: number | null }>
  > = {};
  const nodes = Object.keys(snapshot.state) as SkillNodeId[];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as SkillNodeId;
    const state = snapshot.state[node];
    if (!state) continue;
    mastery[node] = {
      value: state.value,
      evidenceCount: state.evidenceCount,
      lastEvidenceAt: snapshot.lastEvidenceAt[node] ?? null,
    };
  }

  const recentRows = c.nk.sqlQuery(Q.recentMissionIds, [userId]) as { mission_id: string }[];
  const recentMissionIds: string[] = [];
  for (let i = 0; i < recentRows.length; i++) {
    recentMissionIds.push((recentRows[i] as { mission_id: string }).mission_id);
  }

  const attemptRows = c.nk.sqlQuery(Q.recentAttempts, [userId, 5]) as {
    mission_id: string;
    outcome: string;
  }[];

  const byId: Record<string, MissionSummary> = {};
  const allMissions = missionSummaries(c, catalogVersion);
  for (let i = 0; i < allMissions.length; i++) {
    const mission = allMissions[i] as MissionSummary;
    byId[mission.id] = mission;
  }

  const recentSkillNodeIds: SkillNodeId[] = [];
  let consecutiveFailures = 0;
  let stillCounting = true;

  for (let i = 0; i < attemptRows.length; i++) {
    const row = attemptRows[i] as { mission_id: string; outcome: string };
    const mission = byId[row.mission_id];
    if (mission) {
      const node = primaryNodeOf(mission.skillWeights);
      if (node) recentSkillNodeIds.push(node);
    }
    if (stillCounting) {
      if (row.outcome === 'failure') consecutiveFailures++;
      else stillCounting = false;
    }
  }

  const recommendations = selectMissions(
    {
      studentRatings: studentRatings(c, userId),
      mastery,
      candidates,
      recentMissionIds,
      recentSkillNodeIds,
      consecutiveFailures,
      now: c.now,
      inPlacement: recentMissionIds.length === 0,
    },
    limit,
  );

  return { recommendations, assignment: currentAssignment(c, userId) };
}

/**
 * A teacher's assignment takes precedence over the engine's pick in the UI
 *. The engine is a recommendation; a teacher is a decision.
 */
export function currentAssignment(c: Ctx, userId: string): Assignment | null {
  const rows = c.nk.sqlQuery(Q.assignmentsForUser, [userId]) as {
    id: string;
    kind: 'mission' | 'lesson';
    target_id: string;
    note: string | null;
  }[];
  if (rows.length === 0) return null;

  const row = rows[0] as { id: string; kind: 'mission' | 'lesson'; target_id: string; note: string | null };
  return row.note
    ? { id: row.id, kind: row.kind, targetId: row.target_id, note: row.note }
    : { id: row.id, kind: row.kind, targetId: row.target_id };
}

export function ratingFor(ratings: Partial<Record<GameId, number>>, gameId: GameId): number {
  return ratings[gameId] ?? DEFAULT_RATING;
}
