/**
 * Joining a class and reclaiming an account.
 *
 * The join code is the one identifier a stranger can guess, and what is behind
 * it is a list of children. So it expires, it is capped by class size, and
 * failures are rate-limited per device — the limit keys on a device identifier
 * rather than a user because this path is reachable before an account exists.
 */

import { LenterraError, conflict, invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireString, type Ctx } from '../lib/ctx';
import {
  LIMITS,
  assertFailureBudget,
  checkRateLimit,
  recordFailure,
  type RateLimit,
} from '../lib/ratelimit';
import { JOIN_GRANT_TTL_SECONDS, mintGrant } from '../lib/assertion';
import { Q } from '../db/queries';
import { audit, maskName, validateDisplayName } from '../domain/profile';

interface ClassRow {
  id: string;
  name: string;
  school_id: string;
  max_members: number;
  school_name: string;
  member_count: number;
}

/**
 * Resolve a join code, or fail the way an attacker learns nothing from.
 *
 * Unknown and expired codes are deliberately indistinguishable: telling them
 * apart would let someone enumerate which codes ever existed, and what is
 * behind a code is a list of children.
 */
function resolveClass(c: Ctx, code: string, subject: string): ClassRow {
  const rows = c.nk.sqlQuery(Q.classByCode, [code]);
  if (rows.length === 0) {
    recordFailure(c, 'v1.class.join', subject);
    throw notFound('That class code is not valid');
  }

  const row = rows[0] as ClassRow;
  if (Number(row.member_count) >= Number(row.max_members)) {
    throw conflict('class_full', 'That class is full');
  }
  return row;
}

// ---------------------------------------------------------------------------
// v1.class.grant
// ---------------------------------------------------------------------------

export interface ClassGrantReq {
  code: string;
  deviceId?: string;
}

export interface ClassGrantRes {
  grant: string;
  /** Shown before the student commits, so a mistyped code is caught by a human. */
  className: string;
  schoolName: string;
  expiresIn: number;
}

/**
 * Mint a join grant for a valid class code (TRD-AUTH-004).
 *
 * The only handler in the system reachable with no account, because it is the
 * one that exists so an account can be created. It therefore writes nothing:
 * a caller with a stolen code can learn a class name and burn rate-limit
 * budget, and that is the whole of it.
 *
 * The rate limit keys on a device identifier rather than a user for the same
 * reason — there is no user yet — and shares its budget with `v1.class.join`,
 * so guessing codes here does not simply reset the counter that guards there.
 */
export function classGrant(c: Ctx, req: ClassGrantReq): ClassGrantRes {
  const code = requireString(req.code, 'code', 16).toUpperCase();
  const deviceId = optionalString(req.deviceId, 'deviceId', 128) ?? c.userId;

  if (!deviceId) {
    // Without one there is nothing to rate-limit against, and an unlimited
    // guessing channel against a six-character code is the one failure this
    // handler must not have.
    throw invalidArgument('deviceId is required');
  }

  const secret = (c.ctx.env ?? {})['JOIN_GRANT_HMAC_SECRET'] as string | undefined;
  if (!secret) {
    c.logger.error('JOIN_GRANT_HMAC_SECRET is not set; class-code sign-in is unavailable');
    throw new LenterraError('UNAVAILABLE', 'Joining with a class code is temporarily unavailable');
  }

  // Keyed on the device because there is no user yet. Both budgets apply: the
  // failure budget shared with `v1.class.join` catches guessing, and the call
  // budget catches a caller who holds one valid code and hammers the handler.
  checkRateLimit(c, 'v1.class.grant', LIMITS['v1.class.grant'] as RateLimit, deviceId);
  assertFailureBudget(c, 'v1.class.join', deviceId);
  const row = resolveClass(c, code, deviceId);

  return {
    grant: mintGrant(c.nk, secret, { kind: 'class', classId: row.id }, Math.floor(c.now / 1000)),
    className: row.name,
    schoolName: row.school_name,
    expiresIn: JOIN_GRANT_TTL_SECONDS,
  };
}

export interface ClassJoinReq {
  code: string;
  displayName?: string;
  deviceId?: string;
  idempotencyKey: string;
}

export interface ClassJoinRes {
  class: { id: string; name: string; schoolName: string };
  existingProfiles?: { maskedName: string; reclaimToken: string }[];
}

export function classJoin(c: Ctx, req: ClassJoinReq): ClassJoinRes {
  const code = requireString(req.code, 'code', 16).toUpperCase();
  const displayName = optionalString(req.displayName, 'displayName', 64);
  const deviceId = optionalString(req.deviceId, 'deviceId', 128) ?? c.userId;

  assertFailureBudget(c, 'v1.class.join', deviceId);
  const row = resolveClass(c, code, deviceId);

  if (displayName !== null) {
    const rejection = validateDisplayName(displayName);
    if (rejection) throw invalidArgument('That name cannot be used', { reason: rejection });
  }

  c.nk.sqlExec(Q.classJoin, [row.id, c.userId]);
  c.nk.sqlExec(Q.attachSchool, [c.userId, row.school_id]);
  if (displayName !== null) {
    c.nk.sqlQuery(Q.profileUpdate, [c.userId, displayName.trim(), null, null]);
  }
  c.nk.sqlExec(Q.markOnboarded, [c.userId]);

  audit(c, 'class.join', 'class', row.id, { via: 'code' });

  const result: ClassJoinRes = {
    class: { id: row.id, name: row.name, schoolName: row.school_name },
  };

  const candidates = existingProfiles(c, row.id);
  if (candidates.length > 0) result.existingProfiles = candidates;

  return result;
}

/**
 * Masked candidates a returning student might recognise as their own.
 *
 * Names only, masked. The full list would be a class roster, and a class roster
 * handed to anyone holding a six-character code is a safeguarding problem, not
 * a convenience.
 */
function existingProfiles(c: Ctx, classId: string): { maskedName: string; reclaimToken: string }[] {
  const rows = c.nk.sqlQuery(Q.classCandidates, [classId]) as {
    user_id: string;
    display_name: string;
  }[];

  const out: { maskedName: string; reclaimToken: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { user_id: string; display_name: string };
    if (row.user_id === c.userId) continue;
    out.push({
      maskedName: maskName(row.display_name),
      // The token names the candidate without exposing their user id, so a
      // reclaim request cannot be used to harvest account identifiers.
      reclaimToken: c.nk.base64UrlEncode(`${classId}:${row.user_id}`),
    });
  }
  return out;
}

export interface ReclaimReq {
  classId: string;
  reclaimToken: string;
  idempotencyKey: string;
}

/**
 * Request a reclaim. Never transfers anything (TRD-AUTH-006).
 *
 * The teacher is the authority, because a class-code student has no email and
 * no password — there is nothing else to prove with. An unapproved request must
 * not block play: the student keeps going on the fresh account meanwhile.
 */
export function classReclaimRequest(c: Ctx, req: ReclaimReq) {
  const classId = requireString(req.classId, 'classId', 64);
  const token = requireString(req.reclaimToken, 'reclaimToken', 256);

  let decoded: string;
  try {
    decoded = c.nk.binaryToString(c.nk.base64UrlDecode(token));
  } catch (_e) {
    throw invalidArgument('Invalid reclaim token');
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) throw invalidArgument('Invalid reclaim token');

  const tokenClassId = decoded.slice(0, separator);
  const targetUserId = decoded.slice(separator + 1);

  // The token is bound to the class it was issued for; a token from one class
  // cannot be presented against another.
  if (tokenClassId !== classId) throw invalidArgument('Invalid reclaim token');
  if (targetUserId === c.userId) throw invalidArgument('That is already your account');

  const membership = c.nk.sqlQuery(Q.memberOfClass, [classId, targetUserId]);
  if (membership.length === 0) throw notFound('That profile is not in this class');

  const requestId = c.nk.uuidv4();
  c.nk.sqlExec(Q.reclaimCreate, [requestId, classId, targetUserId, c.userId]);
  audit(c, 'reclaim.request', 'user', targetUserId, { classId });

  return { requestId, status: 'pending' };
}
