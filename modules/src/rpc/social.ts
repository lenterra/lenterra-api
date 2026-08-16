/**
 * Points history, redemption, certificates, leaderboards, and friend search.
 *
 * Leaderboards rank **points**, which reflect effort and engagement. They never
 * rank mastery: ranking children by inferred ability is a different and more
 * harmful product (10-03).
 */

import { conflict, forbidden, invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireInt, requireString, toIso, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { balance } from '../domain/ledger';
import { loadProfile } from '../domain/profile';

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
    evidence: { nodes?: string[]; attempts?: number; periodDays?: number };
    onchain_status: string;
    public_verifiable: boolean;
  }[];

  const earned = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (typeof rows)[number];
    const evidence = row.evidence ?? {};
    earned.push({
      id: row.id,
      definitionId: row.definition_id,
      issuedAt: toIso(Number(row.issued_ms)),
      evidenceSummary: {
        nodes: evidence.nodes ?? [],
        attempts: evidence.attempts ?? 0,
        periodDays: evidence.periodDays ?? 0,
      },
      // A certificate is meaningful off-chain from the day it is issued.
      // On-chain anchoring is an R3 addition, not a precondition (ADR-009).
      verifiable: true,
      publicVerifiable: row.public_verifiable,
    });
  }

  return { earned, progress: [] };
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
