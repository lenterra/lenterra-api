/**
 * Recommendations, progress, and course checks.
 */

import type { CheckAnswer, CheckAnswerKey, GameId, SkillNodeId } from '@lenterra/core';
import { bandOf, gradeAgainstKey, isGameId } from '@lenterra/core';

import { invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireArray, requireInt, requireString, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { currentCatalog } from '../domain/catalog';
import { applyAndPersist, readMastery } from '../domain/mastery';
import { award, POINTS } from '../domain/ledger';
import { recommend } from '../domain/selection';

// ---------------------------------------------------------------------------
// v1.mission.recommend
// ---------------------------------------------------------------------------

export interface RecommendReq {
  limit?: number;
  gameId?: string;
}

export function missionRecommend(c: Ctx, req: RecommendReq) {
  const limit = req.limit === undefined ? 4 : requireInt(req.limit, 'limit', 1, 20);
  const gameId = optionalString(req.gameId, 'gameId', 32);
  if (gameId !== null && !isGameId(gameId)) throw invalidArgument('Unknown gameId');

  const catalog = currentCatalog(c);
  const result = recommend(
    c,
    c.userId,
    catalog.version,
    limit,
    gameId === null ? undefined : (gameId as GameId),
  );

  return {
    primary: result.recommendations.length > 0 ? result.recommendations[0] : null,
    alternatives: result.recommendations.slice(1),
    assignment: result.assignment,
  };
}

// ---------------------------------------------------------------------------
// v1.progress.get
// ---------------------------------------------------------------------------

export interface ProgressReq {
  include?: string[];
}

/**
 * Bands, never raw numbers.
 *
 * The student app must be structurally incapable of showing a mastery value
 * — a number invites comparison and gaming, and the number is a
 * probability estimate that no 14-year-old should be asked to interpret. The
 * teacher RPCs return raw values; this one does not.
 */
export function progressGet(c: Ctx, _req: ProgressReq) {
  const snapshot = readMastery(c, c.userId);

  const trendRows = c.nk.sqlQuery(Q.masteryTrend, [c.userId]) as {
    skill_node_id: SkillNodeId;
    direction: number;
  }[];
  const trends: Partial<Record<SkillNodeId, 'up' | 'flat' | 'down'>> = {};
  for (let i = 0; i < trendRows.length; i++) {
    const row = trendRows[i] as { skill_node_id: SkillNodeId; direction: number };
    const direction = Number(row.direction);
    trends[row.skill_node_id] = direction > 0 ? 'up' : direction < 0 ? 'down' : 'flat';
  }

  const mastery: { skillNodeId: string; band: string; evidenceCount: number; trend: string }[] = [];
  const nodes = Object.keys(snapshot.state).sort() as SkillNodeId[];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as SkillNodeId;
    const state = snapshot.state[node];
    if (!state) continue;
    mastery.push({
      skillNodeId: node,
      band: bandOf(state.value, state.evidenceCount),
      evidenceCount: state.evidenceCount,
      trend: trends[node] ?? 'flat',
    });
  }

  const courseRows = c.nk.sqlQuery(Q.courseProgress, [c.userId]) as {
    course_id: string;
    lessons_completed: number;
  }[];
  const courses: { courseId: string; lessonsCompleted: number }[] = [];
  for (let i = 0; i < courseRows.length; i++) {
    const row = courseRows[i] as { course_id: string; lessons_completed: number };
    courses.push({ courseId: row.course_id, lessonsCompleted: Number(row.lessons_completed) });
  }

  const certRows = c.nk.sqlQuery(Q.certificatesForUser, [c.userId]) as {
    id: string;
    definition_id: string;
    issued_ms: number;
  }[];
  const certificates: { id: string; definitionId: string; issuedAt: string }[] = [];
  for (let i = 0; i < certRows.length; i++) {
    const row = certRows[i] as { id: string; definition_id: string; issued_ms: number };
    certificates.push({
      id: row.id,
      definitionId: row.definition_id,
      issuedAt: new Date(Number(row.issued_ms)).toISOString(),
    });
  }

  // --- per-game progress ---------------------------------------------------
  const catalog = currentCatalog(c);

  const availableRows = c.nk.sqlQuery(Q.missionCountsByGame, [catalog.version]) as {
    game_id: string;
    n: number;
  }[];
  const available: Record<string, number> = {};
  for (let i = 0; i < availableRows.length; i++) {
    const row = availableRows[i] as { game_id: string; n: number };
    available[row.game_id] = Number(row.n);
  }

  const gameRows = c.nk.sqlQuery(Q.gameProgress, [c.userId]) as {
    game_id: string;
    missions_passed: number;
    attempts: number;
    highest_rank: number | null;
  }[];
  const games: {
    gameId: string;
    missionsCompleted: number;
    missionsAvailable: number;
    highestRank: number;
  }[] = [];
  for (let i = 0; i < gameRows.length; i++) {
    const row = gameRows[i] as {
      game_id: string;
      missions_passed: number;
      attempts: number;
      highest_rank: number | null;
    };
    games.push({
      gameId: row.game_id,
      // Distinct missions passed, not attempts made. A student who replays one
      // mission thirty times has not completed thirty, and a counter saying
      // otherwise is flattery that stops meaning anything.
      missionsCompleted: Number(row.missions_passed),
      missionsAvailable: available[row.game_id] ?? 0,
      highestRank: row.highest_rank === null ? 0 : Number(row.highest_rank),
    });
  }

  // --- activity ------------------------------------------------------------
  const activityRows = c.nk.sqlQuery(Q.weeklyActivity, [c.userId]) as {
    date: string;
    attempts: number;
    total_ms: number;
  }[];
  const weeklyActivity: { date: string; attempts: number; minutes: number }[] = [];
  for (let i = 0; i < activityRows.length; i++) {
    const row = activityRows[i] as { date: string; attempts: number; total_ms: number };
    weeklyActivity.push({
      date: row.date,
      attempts: Number(row.attempts),
      minutes: Math.round(Number(row.total_ms) / 60000),
    });
  }

  return { mastery, games, courses, certificates, weeklyActivity };
}

// ---------------------------------------------------------------------------
// v1.check.submit
// ---------------------------------------------------------------------------

export interface CheckSubmitReq {
  idempotencyKey: string;
  checkId: string;
  courseId: string;
  lessonId: string;
  catalogVersion: string;
  answers: { itemId: string; answer: unknown }[];
  playedOffline?: boolean;
}

/**
 * Grade a course check server-side.
 *
 * The client's provisional grade is never persisted. The device
 * grades against a digest so an offline student sees a result and an
 * explanation immediately; this is the grade that counts, computed from the
 * answer key in a catalog part `v1.catalog.pull` refuses to serve.
 *
 * The scoring itself comes from the core, so the provisional and authoritative
 * grades agree whenever the client is honest — a second implementation here
 * would eventually disagree, and the student would watch a correct answer turn
 * wrong on sync with nothing to explain it.
 */
export function checkSubmit(c: Ctx, req: CheckSubmitReq) {
  const idempotencyKey = requireString(req.idempotencyKey, 'idempotencyKey', 128);
  const checkId = requireString(req.checkId, 'checkId', 128);
  const courseId = requireString(req.courseId, 'courseId', 128);
  const lessonId = requireString(req.lessonId, 'lessonId', 128);
  const catalogVersion = requireString(req.catalogVersion, 'catalogVersion', 128);
  const answers = requireArray<CheckAnswer>(req.answers, 'answers', 100);

  const existing = c.nk.sqlQuery(Q.checkByKey, [idempotencyKey]);
  if (existing.length > 0) {
    const row = existing[0] as { score: number; passed: boolean; attempt_number: number };
    return {
      score: Number(row.score),
      passed: row.passed,
      attemptNumber: Number(row.attempt_number),
      itemResults: [],
      masteryChanges: [],
      pointsAwarded: [],
    };
  }

  const definition = loadCheck(c, catalogVersion, checkId);
  const graded = gradeAgainstKey(definition, answers);
  const score = graded.score;
  const passed = graded.passed;
  const itemResults = graded.items;

  const numberRows = c.nk.sqlQuery(Q.checkAttemptNumber, [c.userId, checkId]);
  const attemptNumber = numberRows.length > 0 ? Number((numberRows[0] as { n: number }).n) : 1;

  const checkResultId = c.nk.uuidv4();
  c.nk.sqlExec(Q.checkInsert, [
    checkResultId,
    c.userId,
    checkId,
    courseId,
    lessonId,
    catalogVersion,
    JSON.stringify(answers),
    score,
    passed,
    attemptNumber,
    req.playedOffline === true,
    idempotencyKey,
  ]);

  const snapshot = readMastery(c, c.userId);
  const masteryChanges = applyAndPersist(c, snapshot, {
    userId: c.userId,
    skillWeights: definition.skillWeights,
    outcome: passed ? 'success' : 'failure',
    hintShown: false,
    hintUsed: false,
    // A course check is independent evidence and counts toward the
    // multi-source requirement — the transfer signal M-L05 looks for.
    source: 'check',
    sourceKey: checkId,
    sourceType: 'check',
    sourceId: checkResultId,
  });

  const pointsAwarded = [];
  if (passed) {
    const granted = award(
      c,
      c.userId,
      POINTS.checkPassed,
      'check.passed',
      'check',
      checkResultId,
      `check.passed:${checkResultId}`,
    );
    if (granted) pointsAwarded.push(granted);
    c.nk.sqlExec(Q.lessonComplete, [c.userId, courseId, lessonId]);
  }

  return { score, passed, attemptNumber, itemResults, masteryChanges, pointsAwarded };
}

/**
 * Load a check's answer key from the catalog.
 *
 * Checks live in the `checks.*` catalog parts, which the client is never served
 * — the manifest lists them but `v1.catalog.pull` refuses them.
 */
function loadCheck(c: Ctx, catalogVersion: string, checkId: string): CheckAnswerKey {
  const rows = c.nk.sqlQuery(Q.catalogPull, [catalogVersion, ['checks.answers']]) as {
    body: Record<string, CheckAnswerKey>;
  }[];
  if (rows.length === 0) throw notFound('Check definitions are not published');

  const body = (rows[0] as { body: Record<string, CheckAnswerKey> }).body ?? {};
  const definition = body[checkId];
  if (!definition) throw notFound('Unknown check');
  return definition;
}
