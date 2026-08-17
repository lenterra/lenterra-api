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

import { conflict, forbidden, invalidArgument, notFound, unauthenticated } from '../lib/errors';
import { optionalString, requireString, type Ctx } from '../lib/ctx';
import { assertionSecrets, verifyAssertion } from '../lib/assertion';
import { Q } from '../db/queries';
import { audit, requireStaff } from '../domain/profile';
import { emit } from '../domain/telemetry';

// ---------------------------------------------------------------------------
// v1.account.upgrade
// ---------------------------------------------------------------------------

export interface UpgradeReq {
  /** Minted by the verifier for the address the student just proved control of. */
  assertion: string;
  idempotencyKey?: string;
}

export interface UpgradeRes {
  walletAddress: string;
  strategy: string;
  /** True when the account's Nakama custom id was re-keyed to the address. */
  rekeyed: boolean;
}

/**
 * Attach a wallet to a code-created account (TRD-AUTH-005).
 *
 * An account created from a class code or a staff invite has no password and no
 * email, which is what makes it reachable by a child with neither — and also
 * what makes it fragile: lose the device and the only recovery is a teacher
 * approving a reclaim. This is how somebody stops being in that position, using
 * a wallet they already control rather than an inbox this system would have to
 * read.
 *
 * It is entirely optional. Nothing in the product requires it, certificates
 * included, and no screen pushes a student toward it.
 *
 * **The account is never forked.** The caller is already signed in, so there is
 * nothing to merge — the same Nakama user id keeps its progress, points, and
 * mastery by construction, and the only thing that changes is what they can sign
 * in with next time. Creating a second account and copying rows between them
 * would be the outcome PRD-ONB-004 exists to prevent.
 */
export function accountUpgrade(c: Ctx, req: UpgradeReq): UpgradeRes {
  const assertion = requireString(req.assertion, 'assertion', 4096);

  const secrets = assertionSecrets(c.ctx);
  if (secrets.length === 0) {
    c.logger.error('ASSERTION_HMAC_SECRET is not configured; refusing upgrades');
    throw unauthenticated('Sign-in could not be verified');
  }

  // No expected subject: the whole point is that the caller is proving control
  // of an address the account does not have yet. The assertion still has to be
  // signed, current, and un-replayed, and the subject it names is the address
  // that gets claimed — never one the client passed alongside it.
  const verified = verifyAssertion(c.nk, secrets, assertion, null, Math.floor(c.now / 1000));
  if (!verified.ok) {
    c.logger.warn('upgrade rejected reason=%s user=%s', verified.reason, c.userId);
    throw unauthenticated('Sign-in could not be verified');
  }

  const address = verified.claims.sub.toLowerCase();
  if (address.indexOf('0x') !== 0) {
    // A code assertion names an opaque id, not an address. Accepting one here
    // would let a caller "upgrade" to the identity they already have and record
    // it as though a wallet existed.
    throw invalidArgument('That sign-in does not carry a wallet address');
  }
  // `email` and `google` are no longer issued but are still accepted, so an
  // assertion already in flight from an older client completes rather than
  // failing at the last step. What all three have in common is the only thing
  // that matters here: each is proof of control over the address named.
  if (
    verified.strategy !== 'wallet' &&
    verified.strategy !== 'email' &&
    verified.strategy !== 'google'
  ) {
    throw invalidArgument('That sign-in cannot be used to attach a wallet');
  }

  const burned = c.nk.sqlExec(Q.burnJti, [verified.claims.jti, verified.claims.exp]);
  if (burned.rowsAffected === 0) throw unauthenticated('Sign-in could not be verified');

  const rows = c.nk.sqlQuery(Q.profileIdentity, [c.userId]) as {
    auth_strategy: string;
    wallet_address: string | null;
  }[];
  if (rows.length === 0) throw notFound('No profile for this account');
  const current = rows[0] as { auth_strategy: string; wallet_address: string | null };

  if (current.wallet_address !== null && current.wallet_address !== address) {
    // Two addresses on one account has no meaning: the certificates are already
    // at the first one. Refusing is the outcome TRD-AUTH-005 asks for.
    throw conflict('already_upgraded', 'This account already has a wallet');
  }

  const held = c.nk.sqlQuery(Q.profileByWallet, [address]) as { user_id: string }[];
  if (held.length > 0 && (held[0] as { user_id: string }).user_id !== c.userId) {
    throw conflict(
      'address_in_use',
      'That sign-in already belongs to another account. Sign in with it instead.',
    );
  }

  let rekeyed = false;
  if (current.wallet_address === null) {
    const claimed = c.nk.sqlQuery(Q.profileClaimWallet, [c.userId, address, verified.strategy]);
    if (claimed.length === 0) throw conflict('already_upgraded', 'This account already has a wallet');

    // Re-key rather than link: Nakama allows one custom id per user, and the
    // opaque class-code id is not something a student can reproduce from an
    // email login. Unlink first — linking to an occupied slot fails.
    c.nk.unlinkCustom(c.userId);
    c.nk.linkCustom(c.userId, address);
    rekeyed = true;
  } else {
    c.nk.sqlQuery(Q.profileSetStrategy, [c.userId, verified.strategy, address]);
  }

  audit(c, 'account.upgrade', 'user', c.userId, { strategy: verified.strategy, rekeyed });
  emit(c, 'account.upgraded', { from: current.auth_strategy, to: verified.strategy });

  return { walletAddress: address, strategy: verified.strategy, rekeyed };
}

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
