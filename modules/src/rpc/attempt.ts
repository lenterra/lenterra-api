/**
 * `v1.attempt.submit` — the most important RPC in the system.
 *
 * Everything the client claims about an attempt is re-derived here: the
 * outcome, the metrics, the mastery change, and the points. `claimedOutcome` is
 * compared, never trusted.
 *
 * The response carries mastery changes, points, streak, achievements, and the
 * next recommendation together on purpose. The client needs all of it to render
 * the result panel, and a second round trip on a 3G connection is a visible
 * stall at the emotional peak of the session.
 */

import type { AttemptOutcome, Mission, Replay, SkillNodeId } from '@lenterra/core';
import {
  detectStruggle,
  missionK,
  primaryNodeOf,
  studentK,
  supportOptionsFor,
  updateRatings,
} from '@lenterra/core';

import { invalidArgument } from '../lib/errors';
import { requireBool, requireInt, requireString, toIso, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { currentCatalog, loadMission } from '../domain/catalog';
import { applyAndPersist, readMastery, ENGINE_VERSION } from '../domain/mastery';
import { award, creditStreak, pointsForAttempt, type PointsAward } from '../domain/ledger';
import { parseReplay, validate } from '../domain/validation';
import { evaluateForAttempt } from '../domain/achievements';
import { issueEarned } from '../domain/certificates';
import { emit } from '../domain/telemetry';
import { notify, NOTIFICATION_CODE } from '../domain/notify';
import { recommend, ratingFor, studentRatings } from '../domain/selection';

export interface AttemptPayload {
  missionId: string;
  missionContentVersion: number;
  catalogVersion: string;
  gameId: string;
  replay: unknown;
  claimedOutcome: AttemptOutcome;
  durationMs: number;
  clientStartedAt: string;
  deviceSeq: number;
  hintShown: boolean;
  hintUsed: boolean;
  playedOffline: boolean;
  twoPlayer: boolean;
  coreVersion: string;
}

export interface AttemptSubmitReq {
  idempotencyKey: string;
  attempt: AttemptPayload;
  clientVersion?: string;
}

export interface AttemptSubmitRes {
  attemptId: string;
  validation: 'validated' | 'rejected';
  rejectionReason?: string;
  outcome: AttemptOutcome;
  masteryChanges: { skillNodeId: string; before: number; after: number; band: string; bandChanged: boolean }[];
  pointsAwarded: PointsAward[];
  streak: { currentDays: number; creditedToday: boolean };
  achievements: string[];
  certificatesIssued: string[];
  nextRecommendation: unknown;
  struggleDetected: { skillNodeId: string; supportOptions: string[] } | null;
}

export function parseAttempt(value: unknown): AttemptPayload {
  if (value === null || typeof value !== 'object') throw invalidArgument('attempt is required');
  const raw = value as Record<string, unknown>;

  const outcome = raw['claimedOutcome'];
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'abandoned') {
    throw invalidArgument('attempt.claimedOutcome is invalid');
  }

  return {
    missionId: requireString(raw['missionId'], 'attempt.missionId', 128),
    missionContentVersion: requireInt(raw['missionContentVersion'], 'attempt.missionContentVersion', 1),
    catalogVersion: requireString(raw['catalogVersion'], 'attempt.catalogVersion', 128),
    gameId: requireString(raw['gameId'], 'attempt.gameId', 64),
    replay: raw['replay'],
    claimedOutcome: outcome,
    // Two hours is far beyond any 2–5 minute mission; the bound exists so a
    // corrupt value cannot poison the median-minutes figure a teacher reads.
    durationMs: requireInt(raw['durationMs'], 'attempt.durationMs', 0, 7_200_000),
    clientStartedAt: requireString(raw['clientStartedAt'], 'attempt.clientStartedAt', 64),
    deviceSeq: requireInt(raw['deviceSeq'], 'attempt.deviceSeq', 0),
    hintShown: requireBool(raw['hintShown'], 'attempt.hintShown'),
    hintUsed: requireBool(raw['hintUsed'], 'attempt.hintUsed'),
    playedOffline: requireBool(raw['playedOffline'], 'attempt.playedOffline'),
    twoPlayer: requireBool(raw['twoPlayer'], 'attempt.twoPlayer'),
    coreVersion: requireString(raw['coreVersion'], 'attempt.coreVersion', 32),
  };
}

/**
 * Record and score one attempt.
 *
 * Shared by `v1.attempt.submit` and by each item of a `v1.sync.push` batch, so
 * an attempt played offline and one played online travel exactly the same path.
 */
export function submitAttempt(
  c: Ctx,
  payload: AttemptPayload,
  idempotencyKey: string,
  clientVersion: string,
): AttemptSubmitRes {
  // A replayed submission returns what it returned the first time. The wrapper
  // handles this for the direct RPC; sync batches reach here directly.
  const existing = c.nk.sqlQuery(Q.attemptByKey, [idempotencyKey]);
  if (existing.length > 0) {
    const row = existing[0] as {
      id: string;
      validation_status: 'validated' | 'rejected';
      outcome: AttemptOutcome;
      rejection_reason: string | null;
    };
    return emptyResult(c, row.id, row.validation_status, row.outcome, row.rejection_reason);
  }

  const mission: Mission = loadMission(
    c,
    payload.missionId,
    payload.missionContentVersion,
    payload.catalogVersion,
  );

  const replay = parseReplay(payload.replay);
  const attemptId = c.nk.uuidv4();

  if (!replay) {
    return recordRejected(c, attemptId, payload, idempotencyKey, clientVersion, 'malformed_replay');
  }

  const outcome = validate(c, mission, replay);

  if (!outcome.result.valid) {
    // Recorded, not discarded. Rejections are the signal that distinguishes a
    // client bug from a version skew from cheating; throwing them away leaves
    // metric M-S01 blind.
    return recordRejected(
      c,
      attemptId,
      payload,
      idempotencyKey,
      clientVersion,
      outcome.rejectionReason ?? 'unknown',
    );
  }

  const actualOutcome = outcome.result.outcome;
  const metrics = outcome.result.derivedMetrics;

  c.nk.sqlExec(Q.attemptInsert, [
    attemptId,
    c.userId,
    payload.missionId,
    payload.missionContentVersion,
    payload.catalogVersion,
    payload.gameId,
    actualOutcome,
    payload.durationMs,
    metrics.moveCount,
    payload.hintShown,
    payload.hintUsed,
    payload.playedOffline,
    payload.twoPlayer,
    JSON.stringify(replay),
    JSON.stringify({
      greedyMoveTaken: metrics.greedyMoveTaken,
      optimalMoveRank: metrics.optimalMoveRank,
      captureCount: metrics.captureCount,
      chainMaxLength: metrics.chainMaxLength,
      extraTurnCount: metrics.extraTurnCount,
      maxExposureTurns: metrics.maxExposureTurns,
      illegalCaptureAttempts: metrics.illegalCaptureAttempts,
      suspicious: outcome.result.suspicious,
      suspicionReasons: outcome.result.suspicionReasons,
    }),
    payload.clientStartedAt,
    payload.deviceSeq,
    'validated',
    null,
    idempotencyKey,
    clientVersion,
    payload.coreVersion,
  ]);

  // --- mastery -----------------------------------------------------------
  const snapshot = readMastery(c, c.userId);
  const priorSuccessRows = c.nk.sqlQuery(Q.attemptCountForMission, [c.userId, payload.missionId]);
  const priorSuccesses =
    priorSuccessRows.length > 0 ? Number((priorSuccessRows[0] as { n: number }).n) : 0;

  const masteryChanges = applyAndPersist(c, snapshot, {
    userId: c.userId,
    skillWeights: mission.skillWeights,
    outcome: actualOutcome,
    hintShown: payload.hintShown,
    hintUsed: payload.hintUsed,
    // A repeat of an already-passed mission is weaker evidence than the first
    // success on it.
    source: priorSuccesses > 0 ? 'repeat' : 'game',
    sourceKey: payload.missionId,
    sourceType: 'attempt',
    sourceId: attemptId,
  });

  let bandChanged = false;
  for (let i = 0; i < masteryChanges.length; i++) {
    if ((masteryChanges[i] as { bandChanged: boolean }).bandChanged) bandChanged = true;
  }

  // --- ratings -----------------------------------------------------------
  const gameId = mission.game;
  const ratings = studentRatings(c, c.userId);
  const matches = matchCount(c, c.userId, gameId);
  const missionAttempts = missionAttemptCount(c, mission.id, mission.contentVersion);

  const updated = updateRatings(
    ratingFor(ratings, gameId),
    mission.eloDifficulty,
    actualOutcome === 'success',
    studentK(matches),
    missionK(missionAttempts),
  );
  c.nk.sqlExec(Q.studentRatingUpsert, [c.userId, gameId, updated.student]);
  c.nk.sqlExec(Q.missionRatingUpsert, [
    mission.id,
    mission.contentVersion,
    updated.mission,
    actualOutcome === 'success' ? 1 : 0,
  ]);

  // --- points and streak --------------------------------------------------
  const pointsAwarded: PointsAward[] = [];
  const candidates = pointsForAttempt(actualOutcome, priorSuccesses, bandChanged);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as PointsAward;
    const granted = award(
      c,
      c.userId,
      candidate.delta,
      candidate.reason,
      'attempt',
      attemptId,
      `${candidate.reason}:${attemptId}`,
    );
    if (granted) pointsAwarded.push(granted);
  }

  const streak =
    actualOutcome === 'success'
      ? creditStreak(c, c.userId)
      : { currentDays: 0, creditedToday: false };

  // --- struggle -----------------------------------------------------------
  const struggle = evaluateStruggle(c, mission);

  // --- achievements and certificates --------------------------------------
  // Both run after mastery is persisted, so neither can be granted on evidence
  // the server has not already accepted and written.
  // Re-read rather than reuse the pre-attempt snapshot: both checks below ask
  // about the state this attempt produced, and `evidenceCount` is what
  // separates "0.9 from one lucky mission" from a band worth certifying.
  const after = readMastery(c, c.userId);

  const masteryAfter: { skillNodeId: string; mastery: number; evidenceCount: number }[] = [];
  for (let i = 0; i < masteryChanges.length; i++) {
    const change = masteryChanges[i] as { skillNodeId: SkillNodeId; after: number };
    const state = after.state[change.skillNodeId];
    masteryAfter.push({
      skillNodeId: change.skillNodeId,
      mastery: change.after,
      evidenceCount: state ? state.evidenceCount : 0,
    });
  }

  const achievements = evaluateForAttempt(c, {
    mission,
    success: actualOutcome === 'success',
    priorSuccesses,
    chainMaxLength: metrics.chainMaxLength,
    unitsLost: metrics.unitsLost,
    streakDays: streak.currentDays,
    masteryAfter,
  });

  const certificatesIssued = issueEarned(c, after, ENGINE_VERSION);

  // --- telemetry ----------------------------------------------------------
  emit(c, 'attempt.validated', {
    missionId: payload.missionId,
    rank: mission.rank,
    gameId: payload.gameId,
    outcome: actualOutcome,
    durationMs: payload.durationMs,
    hintUsed: payload.hintUsed,
    playedOffline: payload.playedOffline,
    twoPlayer: payload.twoPlayer,
    optimalMoveRank: metrics.optimalMoveRank,
    greedyMoveTaken: metrics.greedyMoveTaken,
    coreVersion: payload.coreVersion,
  });

  for (let i = 0; i < masteryChanges.length; i++) {
    const change = masteryChanges[i] as {
      skillNodeId: string;
      before: number;
      after: number;
      band: string;
      bandChanged: boolean;
      weight: number;
    };
    emit(c, 'mastery.updated', {
      skillNodeId: change.skillNodeId,
      before: change.before,
      after: change.after,
      band: change.band,
      bandChanged: change.bandChanged,
      weight: change.weight,
    });
  }

  for (let i = 0; i < achievements.length; i++) {
    const id = achievements[i] as string;
    emit(c, 'achievement.earned', { achievementId: id });
    // In-app only in R1. Push needs store presence and a consent conversation
    // about minors the pilot does not need to have (PRD-APP-060, OQ-05).
    notify(c, c.userId, {
      code: NOTIFICATION_CODE.achievement,
      subjectKey: 'notification.achievement',
      params: { achievementId: id },
    });
  }
  for (let i = 0; i < certificatesIssued.length; i++) {
    const id = certificatesIssued[i] as string;
    emit(c, 'certificate.issued', { definitionId: id });
    notify(c, c.userId, {
      code: NOTIFICATION_CODE.certificate,
      subjectKey: 'notification.certificate',
      params: { definitionId: id },
    });
  }

  // A streak is only worth announcing at a milestone. Telling a student
  // "2 days!" every second day is how a notification becomes noise.
  if (streak.currentDays > 0 && streak.currentDays % 7 === 0) {
    notify(c, c.userId, {
      code: NOTIFICATION_CODE.streakKept,
      subjectKey: 'notification.streakMilestone',
      params: { days: streak.currentDays },
    });
  }
  if (struggle) {
    emit(c, 'struggle.detected', {
      skillNodeId: struggle.skillNodeId,
      supportOffered: struggle.supportOptions.length,
    });
  }

  // --- next step ----------------------------------------------------------
  const next = recommend(c, c.userId, payload.catalogVersion, 1);

  return {
    attemptId,
    validation: 'validated',
    outcome: actualOutcome,
    masteryChanges,
    pointsAwarded,
    streak,
    achievements,
    certificatesIssued,
    nextRecommendation: next.recommendations.length > 0 ? next.recommendations[0] : null,
    struggleDetected: struggle,
  };
}

function evaluateStruggle(
  c: Ctx,
  mission: Mission,
): { skillNodeId: string; supportOptions: string[] } | null {
  const rows = c.nk.sqlQuery(Q.recentAttempts, [c.userId, 3]) as {
    id: string;
    mission_id: string;
    outcome: AttemptOutcome;
    at_ms: number;
  }[];

  const node = primaryNodeOf(mission.skillWeights);
  if (!node) return null;

  const summaries = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { id: string; mission_id: string; outcome: AttemptOutcome; at_ms: number };
    summaries.push({
      id: row.id,
      missionId: row.mission_id,
      // The engine compares primary nodes; for the recent window the mission
      // that produced each attempt is what matters, and the current mission's
      // node stands in for the ones sharing it.
      primaryNode: row.mission_id === mission.id ? node : (('other:' + row.mission_id) as SkillNodeId),
      outcome: row.outcome,
      at: Number(row.at_ms),
    });
  }

  const detected = detectStruggle(summaries);
  if (!detected) {
    // Mastery rising on a node closes any open struggle — this is what metric
    // M-L04 measures.
    c.nk.sqlExec(Q.struggleResolve, [c.userId, node]);
    return null;
  }

  const open = c.nk.sqlQuery(Q.struggleOpen, [c.userId, detected.skillNodeId]);
  const options = supportOptionsFor(true, true);

  if (open.length === 0) {
    c.nk.sqlExec(Q.struggleInsert, [
      c.nk.uuidv4(),
      c.userId,
      detected.skillNodeId,
      detected.attemptIds,
      options,
    ]);
  }

  return { skillNodeId: detected.skillNodeId, supportOptions: options };
}

function recordRejected(
  c: Ctx,
  attemptId: string,
  payload: AttemptPayload,
  idempotencyKey: string,
  clientVersion: string,
  reason: string,
): AttemptSubmitRes {
  c.nk.sqlExec(Q.attemptInsert, [
    attemptId,
    c.userId,
    payload.missionId,
    payload.missionContentVersion,
    payload.catalogVersion,
    payload.gameId,
    // Stored as its claim, flagged rejected. The claim is evidence about the
    // client, which is the point of keeping it.
    payload.claimedOutcome,
    payload.durationMs,
    0,
    payload.hintShown,
    payload.hintUsed,
    payload.playedOffline,
    payload.twoPlayer,
    JSON.stringify(payload.replay ?? {}),
    JSON.stringify({}),
    payload.clientStartedAt,
    payload.deviceSeq,
    'rejected',
    reason,
    idempotencyKey,
    clientVersion,
    payload.coreVersion,
  ]);

  c.logger.warn(
    'attempt rejected user=%s mission=%s reason=%s core=%s',
    c.userId,
    payload.missionId,
    reason,
    payload.coreVersion,
  );

  return {
    attemptId,
    validation: 'rejected',
    rejectionReason: reason,
    outcome: payload.claimedOutcome,
    masteryChanges: [],
    pointsAwarded: [],
    streak: { currentDays: 0, creditedToday: false },
    achievements: [],
    certificatesIssued: [],
    nextRecommendation: null,
    struggleDetected: null,
  };
}

function emptyResult(
  _c: Ctx,
  attemptId: string,
  status: 'validated' | 'rejected',
  outcome: AttemptOutcome,
  reason: string | null,
): AttemptSubmitRes {
  const result: AttemptSubmitRes = {
    attemptId,
    validation: status,
    outcome,
    masteryChanges: [],
    pointsAwarded: [],
    streak: { currentDays: 0, creditedToday: false },
    achievements: [],
    certificatesIssued: [],
    nextRecommendation: null,
    struggleDetected: null,
  };
  if (reason) result.rejectionReason = reason;
  return result;
}

function matchCount(c: Ctx, userId: string, gameId: string): number {
  const rows = c.nk.sqlQuery(Q.studentRating, [userId]) as { game_id: string; matches: number }[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { game_id: string; matches: number };
    if (row.game_id === gameId) return Number(row.matches);
  }
  return 0;
}

function missionAttemptCount(c: Ctx, missionId: string, contentVersion: number): number {
  const rows = c.nk.sqlQuery(Q.missionRatings, []) as {
    mission_id: string;
    content_version: number;
    attempts: number;
  }[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { mission_id: string; content_version: number; attempts: number };
    if (row.mission_id === missionId && Number(row.content_version) === contentVersion) {
      return Number(row.attempts);
    }
  }
  return 0;
}

export function attemptSubmit(c: Ctx, req: AttemptSubmitReq): AttemptSubmitRes {
  const idempotencyKey = requireString(req.idempotencyKey, 'idempotencyKey', 128);
  const payload = parseAttempt(req.attempt);
  const clientVersion = req.clientVersion ? requireString(req.clientVersion, 'clientVersion', 32) : 'unknown';
  return submitAttempt(c, payload, idempotencyKey, clientVersion);
}

export { toIso };
