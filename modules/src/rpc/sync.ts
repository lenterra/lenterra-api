/**
 * `v1.sync.push` — draining an offline outbox.
 *
 * **Partial success is the normal case.** One rejected attempt in a batch of
 * twenty does not fail the batch: each item reports its own status and the
 * client clears exactly the applied and duplicate ones. Failing the whole batch
 * would mean one bad item blocks a week of a student's work forever, which is
 * the failure mode offline-first exists to avoid.
 */

import { bandOf } from '@lenterra/core';

import { toLenterraError } from '../lib/errors';
import { requireArray, requireString, toIso, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { balance } from '../domain/ledger';
import { parseAttempt, submitAttempt } from './attempt';
import { checkSubmit, type CheckSubmitReq } from './learning';

export const MAX_BATCH_ITEMS = 50;

export interface SyncItem {
  kind: 'attempt' | 'check' | 'lesson' | 'event';
  idempotencyKey: string;
  deviceSeq: number;
  payload: unknown;
}

export interface SyncPushReq {
  batchId: string;
  items: SyncItem[];
  clientVersion?: string;
}

export interface SyncResult {
  idempotencyKey: string;
  status: 'applied' | 'duplicate' | 'rejected';
  error?: { code: string; message: string };
  data?: unknown;
}

export interface SyncPushRes {
  results: SyncResult[];
  summary: { points: number; streakDays: number; rank: number | null };
  serverTime: string;
}

export function syncPush(c: Ctx, req: SyncPushReq): SyncPushRes {
  requireString(req.batchId, 'batchId', 128);
  const items = requireArray<SyncItem>(req.items, 'items', MAX_BATCH_ITEMS);
  const clientVersion = req.clientVersion ?? 'unknown';

  // Ordered by deviceSeq so a student's own history applies in the order they
  // lived it. Mastery is path-dependent — the same attempts in a different
  // order produce a different number.
  const ordered = items.slice().sort((a, b) => Number(a.deviceSeq) - Number(b.deviceSeq));
  const results: SyncResult[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i] as SyncItem;
    let key = '';
    try {
      key = requireString(item.idempotencyKey, 'items[].idempotencyKey', 128);
      results.push(applyItem(c, item, key, clientVersion));
    } catch (thrown) {
      // One item's failure never stops the others. The client keeps a rejected
      // item out of its outbox only if the error is terminal, which is what
      // the code tells it.
      const err = toLenterraError(thrown);
      c.logger.warn('sync item rejected user=%s kind=%s code=%s', c.userId, item.kind, err.code);
      results.push({
        idempotencyKey: key || `unknown-${i}`,
        status: 'rejected',
        error: { code: err.code, message: err.message },
      });
    }
  }

  const streakRows = c.nk.sqlQuery(Q.streakRead, [c.userId]);
  const streakDays =
    streakRows.length === 0 ? 0 : Number((streakRows[0] as { current_days: number }).current_days);

  return {
    results,
    summary: { points: balance(c, c.userId), streakDays, rank: null },
    serverTime: toIso(c.now),
  };
}

function applyItem(c: Ctx, item: SyncItem, key: string, clientVersion: string): SyncResult {
  switch (item.kind) {
    case 'attempt': {
      const existing = c.nk.sqlQuery(Q.attemptByKey, [key]);
      const payload = parseAttempt(item.payload);
      const data = submitAttempt(c, payload, key, clientVersion);
      return {
        idempotencyKey: key,
        status: existing.length > 0 ? 'duplicate' : 'applied',
        data,
      };
    }

    case 'check': {
      const existing = c.nk.sqlQuery(Q.checkByKey, [key]);
      const payload = item.payload as Omit<CheckSubmitReq, 'idempotencyKey'>;
      const data = checkSubmit(c, { ...payload, idempotencyKey: key });
      return {
        idempotencyKey: key,
        status: existing.length > 0 ? 'duplicate' : 'applied',
        data,
      };
    }

    case 'lesson': {
      const payload = item.payload as { courseId?: unknown; lessonId?: unknown };
      const courseId = requireString(payload.courseId, 'payload.courseId', 128);
      const lessonId = requireString(payload.lessonId, 'payload.lessonId', 128);
      const result = c.nk.sqlExec(Q.lessonComplete, [c.userId, courseId, lessonId]);
      return {
        idempotencyKey: key,
        status: result.rowsAffected > 0 ? 'applied' : 'duplicate',
      };
    }

    case 'event': {
      const payload = item.payload as {
        name?: unknown;
        occurredAt?: unknown;
        props?: Record<string, unknown>;
      };
      const name = requireString(payload.name, 'payload.name', 64);

      // The device clock is corrected against server time rather than trusted.
      // An offline batch can carry timestamps hours out, and an event stream
      // ordered by a wrong clock is worse than no event stream.
      const occurredAt = correctTimestamp(payload.occurredAt, c.now);

      c.nk.sqlExec(Q.eventInsert, [
        c.userId,
        name,
        JSON.stringify(payload.props ?? {}),
        occurredAt,
        item.deviceSeq,
        clientVersion,
      ]);
      return { idempotencyKey: key, status: 'applied' };
    }

    default:
      return {
        idempotencyKey: key,
        status: 'rejected',
        error: { code: 'INVALID_ARGUMENT', message: 'Unknown sync item kind' },
      };
  }
}

/**
 * Clamp a client timestamp into a plausible range.
 *
 * A future timestamp is impossible and is pulled back to now; a timestamp more
 * than 90 days old is beyond any realistic offline window and is treated the
 * same way, because the alternative is a metrics series with points in 1970.
 */
function correctTimestamp(value: unknown, now: number): string {
  if (typeof value !== 'string') return toIso(now);
  const parsed = Date.parse(value);
  if (!isFinite(parsed)) return toIso(now);
  if (parsed > now) return toIso(now);
  if (now - parsed > 90 * 86400000) return toIso(now);
  return toIso(parsed);
}

// ---------------------------------------------------------------------------
// v1.sync.pull
// ---------------------------------------------------------------------------

export interface SyncPullReq {
  cursor?: string | null;
  limit?: number;
}

export function syncPull(c: Ctx, _req: SyncPullReq) {
  const snapshot = c.nk.sqlQuery(Q.masteryForUser, [c.userId]) as {
    skill_node_id: string;
    mastery: number;
    evidence_count: number;
  }[];

  const mastery: { skillNodeId: string; band: string; evidenceCount: number }[] = [];
  for (let i = 0; i < snapshot.length; i++) {
    const row = snapshot[i] as { skill_node_id: string; mastery: number; evidence_count: number };
    mastery.push({
      skillNodeId: row.skill_node_id,
      band: bandOf(Number(row.mastery), Number(row.evidence_count)),
      evidenceCount: Number(row.evidence_count),
    });
  }

  const assignmentRows = c.nk.sqlQuery(Q.assignmentsForUser, [c.userId]) as {
    id: string;
    kind: string;
    target_id: string;
    note: string | null;
  }[];
  const assignments = [];
  for (let i = 0; i < assignmentRows.length; i++) {
    const row = assignmentRows[i] as { id: string; kind: string; target_id: string; note: string | null };
    assignments.push({
      id: row.id,
      kind: row.kind,
      targetId: row.target_id,
      note: row.note ?? undefined,
      withdrawn: false,
    });
  }

  return {
    cursor: String(c.now),
    hasMore: false,
    changes: {
      mastery,
      points: { balance: balance(c, c.userId), recent: [] },
      assignments,
    },
  };
}
