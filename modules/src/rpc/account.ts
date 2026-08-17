/**
 * Account deletion and moderation reports.
 *
 * Two promises the product makes in its privacy notice and its safety rules
 * that previously had no mechanism behind them: `lenterra_moderation_report`
 * shipped with nothing writing to it, and there was no deletion path at all.
 *
 * A written commitment with no code behind it is worse than no commitment,
 * because it is read as one.
 */

import { forbidden, invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireString, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { audit, requireStaff } from '../domain/profile';
import { emit } from '../domain/telemetry';

// ---------------------------------------------------------------------------
// v1.account.delete.request
// ---------------------------------------------------------------------------

export interface DeleteReq {
  confirm?: unknown;
  idempotencyKey?: string;
}

export interface DeleteRes {
  scheduledFor: string;
  /** How long the student has to change their mind. */
  cancellableUntil: string;
}

/**
 * Schedule this account for deletion.
 *
 * Scheduled rather than immediate, for two reasons pulling the same way: a
 * child on a borrowed phone can tap the wrong thing, and thirty days is the
 * window the privacy notice already commits to. The delay is the promise, not
 * a convenience.
 *
 * `confirm` must be exactly `true`. A missing field must never read as
 * agreement on an operation that ends a student's history.
 */
export function accountDeleteRequest(c: Ctx, req: DeleteReq): DeleteRes {
  if (req.confirm !== true) {
    throw invalidArgument('Deletion must be explicitly confirmed');
  }

  const rows = c.nk.sqlQuery(Q.deletionRequest, [c.nk.uuidv4(), c.userId, c.userId]) as {
    id: string;
    scheduled_ms: number;
  }[];

  if (rows.length === 0) {
    // The only way the upsert returns nothing is a request already executed.
    throw forbidden('This account is already being deleted');
  }

  const row = rows[0] as { id: string; scheduled_ms: number };
  const scheduled = new Date(Number(row.scheduled_ms)).toISOString();

  // By request id, with nothing personal in it — the audit trail has to
  // survive the deletion it records.
  audit(c, 'account.delete.request', 'user', c.userId, { requestId: row.id });
  emit(c, 'account.deletion_requested', { requestId: row.id });

  return { scheduledFor: scheduled, cancellableUntil: scheduled };
}

/** Change of mind, inside the window. */
export function accountDeleteCancel(c: Ctx): { cancelled: boolean } {
  const rows = c.nk.sqlExec(Q.deletionCancel, [c.userId]);
  const cancelled = rows.rowsAffected > 0;
  if (cancelled) audit(c, 'account.delete.cancel', 'user', c.userId, {});
  return { cancelled };
}

// ---------------------------------------------------------------------------
// v1.moderation.report
// ---------------------------------------------------------------------------

const REASONS = ['bullying', 'inappropriate_name', 'impersonation', 'other'];

export interface ReportReq {
  subjectUserId: string;
  reason: string;
  /** Where it happened. An enum, never free text. */
  surface?: string;
}

/**
 * Report another student.
 *
 * The reason is an enum and there is no free-text field, which is deliberate:
 * a free-text box on a product used by children is a channel for exactly the
 * content the reporting exists to stop, and it would be the only unmoderated
 * text path in the system (TRD-SEC-015).
 */
export function moderationReport(c: Ctx, req: ReportReq): { reported: boolean } {
  const subject = requireString(req.subjectUserId, 'subjectUserId', 64);
  const reason = requireString(req.reason, 'reason', 32);
  const surface = optionalString(req.surface, 'surface', 32);

  if (REASONS.indexOf(reason) < 0) throw invalidArgument('Unknown reason');
  if (subject === c.userId) throw invalidArgument('Cannot report yourself');

  // Bounded to the same school, like every other path between two students.
  const same = c.nk.sqlQuery(Q.sameSchool, [c.userId, subject]);
  if (same.length === 0 || (same[0] as { same: boolean }).same !== true) {
    // Deliberately indistinguishable from success. A distinguishable response
    // turns this into a probe for whether an account exists.
    return { reported: true };
  }

  c.nk.sqlExec(Q.moderationReport, [
    c.nk.uuidv4(),
    c.userId,
    subject,
    reason,
    JSON.stringify({ surface: surface ?? 'unknown' }),
  ]);

  emit(c, 'moderation.reported', { reason, surface: surface ?? 'unknown' });
  return { reported: true };
}

// ---------------------------------------------------------------------------
// Staff surfaces
// ---------------------------------------------------------------------------

export function moderationQueue(c: Ctx) {
  requireStaff(c);

  const rows = c.nk.sqlQuery(Q.moderationOpen, []) as {
    id: string;
    reason: string;
    created_ms: number;
  }[];

  const overdue = c.nk.sqlQuery(Q.moderationOverdue, []);
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { id: string; reason: string; created_ms: number };
    items.push({
      id: row.id,
      reason: row.reason,
      createdAt: new Date(Number(row.created_ms)).toISOString(),
    });
  }

  return {
    items,
    // Surfaced rather than merely logged: the 72-hour commitment is only real
    // if somebody is shown when it has been missed (TRD-SEC-016).
    overdue: overdue.length > 0 ? Number((overdue[0] as { n: number }).n) : 0,
  };
}

export interface ResolveReq {
  reportId: string;
  action: string;
}

export function moderationResolve(c: Ctx, req: ResolveReq): { resolved: boolean } {
  requireStaff(c);

  const reportId = requireString(req.reportId, 'reportId', 64);
  const action = requireString(req.action, 'action', 16);
  if (action !== 'actioned' && action !== 'dismissed') {
    throw invalidArgument('action must be actioned or dismissed');
  }

  const rows = c.nk.sqlQuery(Q.moderationResolve, [reportId, action, c.userId]) as {
    subject_user_id: string;
  }[];
  if (rows.length === 0) throw notFound('No open report with that id');

  audit(c, `moderation.${action}`, 'report', reportId, {});
  return { resolved: true };
}
