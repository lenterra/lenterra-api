/**
 * Points history, redemption, certificates, leaderboards, and friend search.
 *
 * Leaderboards rank **points**, which reflect effort and engagement. They never
 * rank mastery: ranking children by inferred ability is a different and more
 * harmful product (10-03).
 */

import {
  bandOf,
  checkCertificate,
  classGoal,
  isCounted,
  type MasteryBand,
  type NodeEvidence,
  type SkillNodeId,
} from '@lenterra/core';

import { conflict, forbidden, invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireInt, requireString, toIso, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { balance } from '../domain/ledger';
import { loadProfile } from '../domain/profile';
import { readMastery } from '../domain/mastery';
import { CERTIFICATES, type CertificateEvidence } from '../domain/certificates';

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

export interface PointsHistoryReq {
  cursor?: string;
  limit?: number;
}

/**
 * The student-readable ledger.
 *
 * A balance that changes without a visible reason is read as cheating, and a
 * student who cannot audit their own points has no reason to believe any other
 * number the product shows them.
 */
export function pointsHistory(c: Ctx, req: PointsHistoryReq) {
  const limit = req.limit === undefined ? 50 : requireInt(req.limit, 'limit', 1, 100);
  const cursor = optionalString(req.cursor, 'cursor', 64);

  const rows = c.nk.sqlQuery(Q.pointsHistory, [c.userId, cursor, limit + 1]) as {
    delta: number;
    reason: string;
    at_ms: number;
  }[];

  const entries: { delta: number; reasonKey: string; at: string }[] = [];
  const take = Math.min(rows.length, limit);
  for (let i = 0; i < take; i++) {
    const row = rows[i] as { delta: number; reason: string; at_ms: number };
    entries.push({
      delta: Number(row.delta),
      reasonKey: `points.reason.${row.reason}`,
      at: toIso(Number(row.at_ms)),
    });
  }

  const nextCursor =
    rows.length > limit && take > 0
      ? toIso(Number((rows[take - 1] as { at_ms: number }).at_ms))
      : null;

  return { balance: balance(c, c.userId), entries, cursor: nextCursor };
}

export interface RedeemReq {
  itemId: string;
  idempotencyKey: string;
}

export function rewardRedeem(c: Ctx, req: RedeemReq) {
  const itemId = requireString(req.itemId, 'itemId', 128);
  const idempotencyKey = requireString(req.idempotencyKey, 'idempotencyKey', 128);

  if (c.nk.sqlQuery(Q.redemptionExists, [c.userId, itemId]).length > 0) {
    throw conflict('already_owned', 'You already have that');
  }

  const item = catalogItem(c, itemId);
  const current = balance(c, c.userId);
  if (current < item.cost) {
    throw conflict('insufficient_points', 'Not enough points yet');
  }

  // The debit is a ledger row like any other, so the balance stays derivable
  // and a redemption can be reversed with a compensating entry rather than an
  // edit.
  const ledgerId = c.nk.uuidv4();
  const debited = c.nk.sqlExec(Q.pointsAward, [
    ledgerId,
    c.userId,
    -item.cost,
    'reward.redeem',
    'redemption',
    null,
    idempotencyKey,
  ]);
  if (debited.rowsAffected === 0) {
    throw conflict('already_owned', 'That redemption was already processed');
  }

  c.nk.sqlExec(Q.redemptionInsert, [c.nk.uuidv4(), c.userId, itemId, item.cost, ledgerId]);

  return { itemId, newBalance: balance(c, c.userId) };
}

function catalogItem(c: Ctx, itemId: string): { cost: number } {
  const rows = c.nk.sqlQuery(Q.currentCatalog, []);
  if (rows.length === 0) throw notFound('No catalog published');
  const version = (rows[0] as { version: string }).version;

  const parts = c.nk.sqlQuery(Q.catalogPull, [version, ['rewards.catalog']]) as {
    body: Record<string, { cost: number }>;
  }[];
  if (parts.length === 0) throw notFound('No reward catalogue published');

  const body = (parts[0] as { body: Record<string, { cost: number }> }).body ?? {};
  const item = body[itemId];
  if (!item || typeof item.cost !== 'number') throw notFound('Unknown reward');
  return item;
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export function certificateList(c: Ctx) {
  const rows = c.nk.sqlQuery(Q.certificatesForUser, [c.userId]) as {
    id: string;
    definition_id: string;
    issued_ms: number;
    evidence: CertificateEvidence | null;
    onchain_status: string;
    public_verifiable: boolean;
  }[];

  const earned = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (typeof rows)[number];
    const evidence = row.evidence;

    // Read from the stored snapshot rather than recomputed. A certificate has
    // to keep saying what it said when it was issued, even after mastery has
    // moved on (PRD-RWD-013) — recomputing would quietly restate the claim.
    const nodes: string[] = [];
    if (evidence) {
      for (let n = 0; n < evidence.nodes.length; n++) {
        nodes.push((evidence.nodes[n] as { skillNodeId: string }).skillNodeId);
      }
    }

    earned.push({
      id: row.id,
      definitionId: row.definition_id,
      issuedAt: toIso(Number(row.issued_ms)),
      evidenceSummary: {
        nodes,
        attempts: evidence ? evidence.totalValidatedAttempts : 0,
        periodDays: evidence ? daysBetween(evidence.earliestEvidenceMs, evidence.latestEvidenceMs) : 0,
      },
      // Meaningful off-chain from the day it is issued. On-chain anchoring is
      // an R3 addition, not a precondition (ADR-009).
      verifiable: true,
      publicVerifiable: row.public_verifiable,
    });
  }

  // --- what is left to earn ------------------------------------------------
  // An empty certificates tab that says only "none yet" tells a student
  // nothing about how to change that (PRD-APP-055). This is the same predicate
  // that issues them, read for its refusals instead of its verdict.
  const held: Record<string, boolean> = {};
  for (let i = 0; i < earned.length; i++) {
    held[(earned[i] as { definitionId: string }).definitionId] = true;
  }

  const snapshot = readMastery(c, c.userId);
  const progress = [];

  for (let i = 0; i < CERTIFICATES.length; i++) {
    const definition = CERTIFICATES[i] as (typeof CERTIFICATES)[number];
    if (held[definition.id]) continue;

    const evidence: Partial<Record<SkillNodeId, NodeEvidence>> = {};
    for (let n = 0; n < definition.requiredNodes.length; n++) {
      const node = definition.requiredNodes[n] as SkillNodeId;
      const state = snapshot.state[node];
      if (!state) continue;
      evidence[node] = {
        mastery: state.value,
        evidenceCount: state.evidenceCount,
        distinctSources: state.distinctSources,
        // Not queried here: the day spread costs a query per certificate and
        // this is a "what is left" list, not the issuing decision. Assuming it
        // holds means the list never blames a student for a condition they
        // cannot see, and issuance still checks it for real.
        distinctDays: definition.minDistinctDays,
      };
    }

    const check = checkCertificate(definition, evidence);
    const remaining = [];
    for (let b = 0; b < check.blockedBy.length; b++) {
      const blocker = check.blockedBy[b] as { skillNodeId: string; reason: string };
      remaining.push({ skillNodeId: blocker.skillNodeId, reason: blocker.reason });
    }

    progress.push({
      definitionId: definition.id,
      requiredNodes: definition.requiredNodes,
      nodesRemaining: remaining.length,
      remaining,
    });
  }

  return { earned, progress };
}

function daysBetween(fromMs: number, toMs: number): number {
  if (fromMs <= 0 || toMs <= 0) return 0;
  return Math.max(1, Math.round((toMs - fromMs) / 86_400_000));
}

export interface CertificateVisibilityReq {
  certificateId: string;
  publicVerifiable: boolean;
  idempotencyKey: string;
}

/** Whether a certificate is publicly checkable is the student's decision. */
export function certificateVisibility(c: Ctx, req: CertificateVisibilityReq) {
  const certificateId = requireString(req.certificateId, 'certificateId', 64);
  if (typeof req.publicVerifiable !== 'boolean') {
    throw invalidArgument('publicVerifiable must be a boolean');
  }

  const result = c.nk.sqlExec(Q.certificateVisibility, [
    certificateId,
    c.userId,
    req.publicVerifiable,
  ]);
  if (result.rowsAffected === 0) throw notFound('Certificate not found');

  return { certificateId, publicVerifiable: req.publicVerifiable };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardReq {
  scope?: 'class' | 'school';
  period?: 'week' | 'all';
  limit?: number;
}

export function leaderboardList(c: Ctx, req: LeaderboardReq) {
  const scope = req.scope === 'school' ? 'school' : 'class';
  const period = req.period === 'all' ? 'all' : 'week';
  const limit = req.limit === undefined ? 20 : requireInt(req.limit, 'limit', 1, 100);

  const classRows = c.nk.sqlQuery(Q.classOfUser, [c.userId]);
  if (classRows.length === 0) {
    return { scope, period, generatedAt: toIso(c.now), entries: [], self: null, cursor: null };
  }

  const klass = classRows[0] as { id: string; leaderboard_enabled: boolean };
  // A teacher can switch the class board off, and when they have, the API says
  // no rather than returning an empty board that looks like nobody has played.
  if (scope === 'class' && !klass.leaderboard_enabled) {
    throw forbidden('The class leaderboard is turned off');
  }

  const boardId = scope === 'class' ? `class:${klass.id}:${period}` : `school:${period}`;

  let records: nkruntime.LeaderboardRecordList;
  try {
    records = c.nk.leaderboardRecordsList(boardId, [], limit);
  } catch (_e) {
    // A board that has never been written to does not exist yet. That is an
    // empty leaderboard, not an error.
    return { scope, period, generatedAt: toIso(c.now), entries: [], self: null, cursor: null };
  }

  const entries = [];
  const list = records.records ?? [];
  for (let i = 0; i < list.length; i++) {
    const record = list[i] as nkruntime.LeaderboardRecord;
    entries.push({
      rank: Number(record.rank),
      userId: record.ownerId,
      displayName: record.username ?? 'Siswa',
      points: Number(record.score),
      isSelf: record.ownerId === c.userId,
    });
  }

  return {
    scope,
    period,
    // What the client displays when it is showing a cached board offline.
    generatedAt: toIso(c.now),
    entries,
    self: null,
    cursor: records.nextCursor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Friend search
// ---------------------------------------------------------------------------

export interface FriendSearchReq {
  friendCode: string;
}

/**
 * Same-school matches only.
 *
 * A code from another school returns `null` rather than "wrong school", because
 * a distinguishable response confirms the code exists and turns this into an
 * enumeration oracle over other schools' children (PRD-SOC-010).
 */
export function friendSearchByCode(c: Ctx, req: FriendSearchReq) {
  const friendCode = requireString(req.friendCode, 'friendCode', 16).toUpperCase();

  const profile = loadProfile(c);
  if (!profile.schoolId) return null;

  const rows = c.nk.sqlQuery(Q.friendByCode, [friendCode, c.userId]);
  if (rows.length === 0) return null;

  const row = rows[0] as { user_id: string; display_name: string };
  return { userId: row.user_id, displayName: row.display_name, sameSchool: true };
}

// ---------------------------------------------------------------------------
// v1.class.goal
// ---------------------------------------------------------------------------

export interface ClassGoalRes {
  /** Null when the student is in no class — most of the tab is still useful. */
  classId: string | null;
  className: string | null;
  reached: number;
  target: number;
  progress: number;
  achieved: boolean;
  contributors: number;
  memberCount: number;
  /**
   * What the student themselves has contributed.
   *
   * Present so the bar can answer "and what did I add", which is the question
   * that turns a class total into something a student can act on. It is a count
   * of their own nodes, never a ranking against classmates.
   */
  mine: number;
}

/**
 * Progress toward the class goal (PRD-SOC-009).
 *
 * Deliberately not gated on `leaderboard_enabled`. A teacher who switches the
 * ranking off is switching off competition, and this is the mechanic that is
 * meant to survive that — it is the one place where a stronger student gains
 * from a weaker one improving.
 */
export function classGoalGet(c: Ctx): ClassGoalRes {
  const empty: ClassGoalRes = {
    classId: null,
    className: null,
    reached: 0,
    target: 0,
    progress: 0,
    achieved: false,
    contributors: 0,
    memberCount: 0,
    mine: 0,
  };

  const classRows = c.nk.sqlQuery(Q.classOfUser, [c.userId]);
  if (classRows.length === 0) return empty;

  const klass = classRows[0] as { id: string; name: string };

  const countRows = c.nk.sqlQuery(Q.classMemberCount, [klass.id]);
  const memberCount = countRows.length > 0 ? Number((countRows[0] as { n: number }).n) : 0;

  const rows = c.nk.sqlQuery(Q.classMastery, [klass.id]) as {
    user_id: string;
    skill_node_id: string;
    mastery: number;
    evidence_count: number;
  }[];

  // Grouped per student so contributors can be counted without a second query,
  // and so the arithmetic stays checkable against a roster.
  const byStudent: Record<string, MasteryBand[]> = {};
  let mine = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as {
      user_id: string;
      skill_node_id: string;
      mastery: number;
      evidence_count: number;
    };
    const band = bandOf(Number(row.mastery), Number(row.evidence_count));
    const bands = byStudent[row.user_id] ?? [];
    bands.push(band);
    byStudent[row.user_id] = bands;
    if (row.user_id === c.userId && isCounted(band)) mine++;
  }

  const contributions: { userId: string; bands: MasteryBand[] }[] = [];
  const userIds = Object.keys(byStudent).sort();
  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i] as string;
    contributions.push({ userId, bands: byStudent[userId] as MasteryBand[] });
  }

  const goal = classGoal(memberCount, contributions);

  return {
    classId: klass.id,
    className: klass.name,
    reached: goal.reached,
    target: goal.target,
    progress: goal.progress,
    achieved: goal.achieved,
    contributors: goal.contributors,
    memberCount,
    mine,
  };
}
