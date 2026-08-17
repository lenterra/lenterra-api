/**
 * Staff operations.
 *
 * Content promotion and role elevation. Both are reachable only by the `staff`
 * role and both are audited, because they are the two operations that can
 * change what every student sees or who can read their data.
 */

import { invalidArgument, notFound } from '../lib/errors';
import { requireString, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { audit, requireStaff, type Role } from '../domain/profile';

export interface PublishReq {
  version: string;
  promote?: boolean;
  idempotencyKey: string;
}

/**
 * Publish or promote a catalog version.
 *
 * Rollback is `promote: true` on a previous version — one step, because the
 * moment rollback is needed is the moment nobody wants to read a runbook
 *. The database guarantees exactly one current version, so a
 * half-finished promotion is not a state that can exist.
 */
export function adminCatalogPublish(c: Ctx, req: PublishReq) {
  requireStaff(c);
  const version = requireString(req.version, 'version', 128);

  const existing = c.nk.sqlQuery(Q.catalogVersionExists, [version]);
  if (existing.length === 0) throw notFound('Unknown catalog version');

  const status = (existing[0] as { status: string }).status;

  if (status === 'draft') {
    c.nk.sqlExec(Q.catalogPublish, [version, c.userId]);
  }

  if (req.promote !== true) {
    audit(c, 'catalog.publish', 'catalog', version, {});
    return { version, status: 'published', previousCurrent: null };
  }

  const rows = c.nk.sqlQuery(Q.catalogPromote, [version, c.userId]);
  if (rows.length === 0) throw invalidArgument('Could not promote that version');

  const row = rows[0] as { version: string; previous: string | null };
  audit(c, 'catalog.promote', 'catalog', version, { previous: row.previous });

  return { version: row.version, status: 'current', previousCurrent: row.previous };
}

export interface RoleGrantReq {
  userId: string;
  role: Role;
  idempotencyKey: string;
}

/**
 * Grant a role.
 *
 * Never reachable from a student or teacher path, and always audited
 * (TRD-AUTH-010). This is the only way a teacher account comes into existence,
 * which is what stops a client from asserting one.
 */
export function adminRoleGrant(c: Ctx, req: RoleGrantReq) {
  requireStaff(c);
  const userId = requireString(req.userId, 'userId', 64);
  const role = requireString(req.role, 'role', 32) as Role;

  if (['student', 'teacher', 'school_admin', 'staff'].indexOf(role) < 0) {
    throw invalidArgument('Unknown role');
  }

  const result = c.nk.sqlExec(Q.setRole, [userId, role]);
  if (result.rowsAffected === 0) throw notFound('Account not found');

  audit(c, 'role.grant', 'user', userId, { role });
  return { userId, role };
}

/**
 * Housekeeping.
 *
 * Retention is a requirement, not a nicety (20-03): expired auth JTIs, stale
 * idempotency records, and old rate-limit buckets accumulate forever otherwise,
 * and the first two are indexed tables that a pilot term would grow without
 * bound.
 */
export function adminPurge(c: Ctx) {
  requireStaff(c);

  const jti = c.nk.sqlExec(Q.purgeJti, []);
  const idempotency = c.nk.sqlExec(Q.idempotencyPurge, []);
  const rateLimits = c.nk.sqlExec(Q.rateLimitPurge, []);
  const deleted = executeDueDeletions(c);

  audit(c, 'maintenance.purge', 'system', 'retention', { accountsDeleted: deleted });

  return {
    authJti: jti.rowsAffected,
    idempotency: idempotency.rowsAffected,
    rateLimits: rateLimits.rowsAffected,
    accountsDeleted: deleted,
  };
}

/**
 * Carry out deletions whose thirty-day window has elapsed (TRD-SEC-011).
 *
 * `nk.accountDeleteId` removes the Nakama account; every `lenterra_*` table
 * references `users(id)` with `ON DELETE CASCADE`, so the learning history,
 * points ledger, telemetry and friend edges go with it. That cascade is why
 * deletion is one call rather than a list of tables somebody has to remember
 * to extend when a table is added.
 *
 * The audit row is written *before* the account goes, and holds only the
 * request id — the record that a deletion happened has to survive the deletion
 * without preserving anything about who it was.
 */
function executeDueDeletions(c: Ctx): number {
  const due = c.nk.sqlQuery(Q.deletionDue, []) as { id: string; user_id: string }[];
  let count = 0;

  for (let i = 0; i < due.length; i++) {
    const row = due[i] as { id: string; user_id: string };
    // Subject is the request, not the user: the user id is about to stop
    // existing, and keeping it would defeat the deletion it records.
    audit(c, 'account.delete.execute', 'request', row.id, {});

    try {
      // `false` keeps the recorded ledger consistent rather than attempting a
      // wallet-style recall of anything the account contributed.
      c.nk.accountDeleteId(row.user_id, false);
      c.nk.sqlExec(Q.deletionMarkExecuted, [row.id]);
      count++;
    } catch (err) {
      // One failure must not stop the rest of the batch: the next run retries
      // it, and a stalled queue would silently miss the thirty-day promise.
      c.logger.error('deletion %s failed: %s', row.id, String(err));
    }
  }

  return count;
}
