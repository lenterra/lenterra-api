/**
 * Staff invites: how an adult comes to have an account.
 *
 * Teachers used to sign in with a code sent to their email. Nothing reads a
 * mailbox any more, so authority now arrives the same way a student's class
 * membership does — as a code handed over by somebody who already has it.
 *
 * The chain is deliberately the class-code chain, not a parallel one:
 *
 *   code ─▶ v1.staff.grant   (no account yet; validates and signs a grant)
 *        ─▶ verifier          (provisions an identity, mints an assertion)
 *        ─▶ authenticateCustom
 *        ─▶ v1.staff.join     (redeems the invite, writes role and school)
 *
 * Two differences from a class code, and both are because of what is behind it.
 * A class code admits a child to a class; a staff code admits an adult to other
 * people's children's records. So it is **single-use**, enforced by the database
 * rather than by checking first and writing after, and it can only be issued by
 * an account that already holds authority over the school it names.
 *
 * The invite carries the role. The *grant* does not: it names the invite and
 * stops there, so what authority is conferred is read from the database at
 * redemption and never travels through a client that could edit it.
 */

import { LenterraError, conflict, forbidden, invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireInt, requireString, toIso, type Ctx } from '../lib/ctx';
import {
  LIMITS,
  assertFailureBudget,
  checkRateLimit,
  recordFailure,
  type RateLimit,
} from '../lib/ratelimit';
import { JOIN_GRANT_TTL_SECONDS, mintGrant } from '../lib/assertion';
import { Q } from '../db/queries';
import { audit, requireRole, type Role } from '../domain/profile';

/** Roles an invite may confer. `student` is not one of them: it is the default. */
const GRANTABLE: Role[] = ['teacher', 'school_admin', 'staff'];

/** Long enough that guessing is hopeless, short enough to read down a phone line. */
const CODE_LENGTH = 10;

/** A working week. An invite that outlives the conversation that created it is a key left in a door. */
const DEFAULT_TTL_HOURS = 168;

interface InviteRow {
  id: string;
  role: string;
  school_id: string | null;
  school_name: string | null;
}

// ---------------------------------------------------------------------------
// v1.staff.grant — reachable with no account
// ---------------------------------------------------------------------------

export interface StaffGrantReq {
  code: string;
  deviceId?: string;
}

export interface StaffGrantRes {
  grant: string;
  /** Shown before the teacher commits, so a mistyped code is caught by a human. */
  role: string;
  schoolName: string | null;
  expiresIn: number;
}

/**
 * Mint a grant for a valid staff code.
 *
 * Writes nothing, exactly like `classGrant`. A caller holding a stolen code can
 * learn which role and school it is for and burn rate-limit budget; redeeming it
 * still requires completing the chain, and doing so spends the code.
 *
 * The rate limit keys on a device identifier because there is no user yet, and
 * shares its failure budget with `v1.staff.join` so that guessing here does not
 * reset the counter guarding there.
 */
export function staffGrant(c: Ctx, req: StaffGrantReq): StaffGrantRes {
  const code = requireString(req.code, 'code', 32).toUpperCase();
  const deviceId = optionalString(req.deviceId, 'deviceId', 128) ?? c.userId;

  if (!deviceId) {
    throw invalidArgument('deviceId is required');
  }

  const secret = (c.ctx.env ?? {})['JOIN_GRANT_HMAC_SECRET'] as string | undefined;
  if (!secret) {
    c.logger.error('JOIN_GRANT_HMAC_SECRET is not set; staff sign-in is unavailable');
    throw new LenterraError('UNAVAILABLE', 'Signing in with a staff code is temporarily unavailable');
  }

  checkRateLimit(c, 'v1.staff.grant', LIMITS['v1.staff.grant'] as RateLimit, deviceId);
  assertFailureBudget(c, 'v1.staff.join', deviceId);

  const invite = resolveInvite(c, code, deviceId);

  return {
    grant: mintGrant(c.nk, secret, { kind: 'staff', inviteId: invite.id }, Math.floor(c.now / 1000)),
    role: invite.role,
    schoolName: invite.school_name,
    expiresIn: JOIN_GRANT_TTL_SECONDS,
  };
}

/**
 * Spent, revoked, expired, and never-existed are one answer.
 *
 * Telling them apart would let somebody with a list of guesses learn which codes
 * were ever issued, and an issued staff code names a school.
 */
function resolveInvite(c: Ctx, code: string, subject: string): InviteRow {
  const rows = c.nk.sqlQuery(Q.staffInviteByCode, [code]);
  if (rows.length === 0) {
    recordFailure(c, 'v1.staff.join', subject);
    throw notFound('That code is not valid');
  }
  return rows[0] as InviteRow;
}

// ---------------------------------------------------------------------------
// v1.staff.join — the caller is authenticated, on a brand-new account
// ---------------------------------------------------------------------------

export interface StaffJoinReq {
  code: string;
  deviceId?: string;
  idempotencyKey: string;
}

export interface StaffJoinRes {
  role: string;
  schoolId: string | null;
  schoolName: string | null;
  /** How many classes moved across, when this invite transferred an account. */
  classesTransferred: number;
}

/**
 * Redeem the invite and become staff.
 *
 * The redemption is a single UPDATE with `redeemed_at IS NULL` in its predicate.
 * Two devices racing on one code therefore leave exactly one winner rather than
 * two accounts holding authority over the same school.
 *
 * When the invite names an account to transfer from, that teacher's role,
 * school, and classes move here and the old account is demoted to a student.
 * Nothing is merged and nothing is deleted: the previous account keeps its own
 * rows, it simply stops teaching. An administrator named that account when they
 * issued the invite, and that naming is the authorisation — the same shape as a
 * teacher naming a profile when they approve a student's reclaim.
 */
export function staffJoin(c: Ctx, req: StaffJoinReq): StaffJoinRes {
  const code = requireString(req.code, 'code', 32).toUpperCase();
  const deviceId = optionalString(req.deviceId, 'deviceId', 128) ?? c.userId;

  assertFailureBudget(c, 'v1.staff.join', deviceId);

  const redeemed = c.nk.sqlQuery(Q.staffInviteRedeem, [code, c.userId]) as {
    id: string;
    role: string;
    school_id: string | null;
    transfers_from: string | null;
  }[];
  if (redeemed.length === 0) {
    recordFailure(c, 'v1.staff.join', deviceId);
    throw notFound('That code is not valid');
  }

  const invite = redeemed[0] as {
    id: string;
    role: string;
    school_id: string | null;
    transfers_from: string | null;
  };

  const granted = c.nk.sqlQuery(Q.profileGrantStaff, [c.userId, invite.role, invite.school_id]);
  if (granted.length === 0) throw notFound('No profile for this account');

  let classesTransferred = 0;
  if (invite.transfers_from) {
    const moved = c.nk.sqlQuery(Q.classTransferOwner, [invite.transfers_from, c.userId]);
    classesTransferred = moved.length;

    // Demoted rather than deleted. Deleting is irreversible and the account may
    // hold a record somebody later needs; what matters is that two accounts
    // cannot teach the same class.
    c.nk.sqlExec(Q.setRole, [invite.transfers_from, 'student']);

    audit(c, 'staff.transfer', 'user', invite.transfers_from, {
      toUserId: c.userId,
      inviteId: invite.id,
      classes: classesTransferred,
    });
  }

  audit(c, 'staff.join', 'user', c.userId, { inviteId: invite.id, role: invite.role });

  const schoolName = invite.school_id ? schoolNameOf(c, invite.school_id) : null;
  return {
    role: invite.role,
    schoolId: invite.school_id,
    schoolName,
    classesTransferred,
  };
}

function schoolNameOf(c: Ctx, schoolId: string): string | null {
  const rows = c.nk.sqlQuery(Q.schoolById, [schoolId]) as { name: string }[];
  return rows.length === 0 ? null : (rows[0] as { name: string }).name;
}

// ---------------------------------------------------------------------------
// v1.admin.staff.invite* — issuing, listing, revoking
// ---------------------------------------------------------------------------

export interface StaffInviteReq {
  role: string;
  schoolId?: string | null;
  /** Move this account's role, school, and classes to whoever redeems the code. */
  transfersFrom?: string | null;
  expiresInHours?: number;
  idempotencyKey: string;
}

/**
 * Issue an invite.
 *
 * Two rules decide what an issuer may hand out, and both are about the same
 * thing — nobody may create authority they do not already hold:
 *
 * - A school administrator issues only for **their own school**, and only the
 *   roles at or below their own. Otherwise a compromised school account becomes
 *   a way to read every school.
 * - Platform staff may issue anything, including the school-less `staff` role.
 */
export function adminStaffInvite(c: Ctx, req: StaffInviteReq) {
  const issuer = requireRole(c, ['school_admin', 'staff']);
  const role = requireString(req.role, 'role', 16) as Role;

  if (GRANTABLE.indexOf(role) < 0) {
    throw invalidArgument('role must be teacher, school_admin, or staff');
  }

  let schoolId = optionalString(req.schoolId, 'schoolId', 64);

  if (issuer.role !== 'staff') {
    if (role === 'staff') throw forbidden('Only platform staff can grant the staff role');
    if (!issuer.schoolId) throw invalidArgument('Your account is not attached to a school');
    // Silently ignoring a mismatched schoolId would be worse than refusing: the
    // issuer would believe they had invited somebody to another school.
    if (schoolId !== null && schoolId !== issuer.schoolId) {
      throw forbidden('You can only invite people to your own school');
    }
    schoolId = issuer.schoolId;
  }

  if (role !== 'staff' && !schoolId) {
    throw invalidArgument('A teacher or school administrator must belong to a school');
  }

  const transfersFrom = optionalString(req.transfersFrom, 'transfersFrom', 64);
  if (transfersFrom !== null) assertTransferable(c, issuer.role, schoolId, transfersFrom);

  const hours =
    req.expiresInHours === undefined
      ? DEFAULT_TTL_HOURS
      : requireInt(req.expiresInHours, 'expiresInHours', 1, 720);

  const rows = c.nk.sqlQuery(Q.staffInviteCreate, [
    c.nk.uuidv4(),
    generateInviteCode(c),
    role,
    schoolId,
    c.userId,
    transfersFrom,
    String(hours),
  ]);
  if (rows.length === 0) throw invalidArgument('Could not create the invite');

  const row = rows[0] as { id: string; code: string; expires_at: string };
  audit(c, 'staff.invite.create', 'invite', row.id, { role, schoolId, transfersFrom });

  return {
    inviteId: row.id,
    // The one time the code is returned in full. An administrator who loses it
    // can still read it back from the list until it is redeemed.
    code: row.code,
    role,
    schoolId,
    expiresAt: row.expires_at,
  };
}

/** The account being transferred from must be one the issuer could already act on. */
function assertTransferable(
  c: Ctx,
  issuerRole: Role,
  schoolId: string | null,
  targetUserId: string,
): void {
  const rows = c.nk.sqlQuery(Q.profileByUser, [targetUserId]) as {
    role: string;
    school_id: string | null;
  }[];
  if (rows.length === 0) throw notFound('No such account');

  const target = rows[0] as { role: string; school_id: string | null };
  if (GRANTABLE.indexOf(target.role as Role) < 0) {
    throw conflict('not_staff', 'That account does not hold a staff role');
  }
  if (issuerRole !== 'staff' && target.school_id !== schoolId) {
    throw forbidden('That account belongs to another school');
  }
}

export function adminStaffInviteList(c: Ctx, req: { schoolId?: string | null }) {
  const issuer = requireRole(c, ['school_admin', 'staff']);

  // A school administrator sees their own school and cannot ask about another.
  // Platform staff passing nothing see every school.
  const schoolId =
    issuer.role === 'staff'
      ? optionalString(req.schoolId, 'schoolId', 64)
      : (issuer.schoolId ?? null);

  const rows = c.nk.sqlQuery(Q.staffInviteList, [schoolId]) as {
    id: string;
    code: string | null;
    role: string;
    school_id: string | null;
    transfers_from: string | null;
    created_at: string;
    expires_at: string;
    redeemed_at: string | null;
    revoked_at: string | null;
    redeemed_by_name: string | null;
  }[];

  const invites = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (typeof rows)[number];
    invites.push({
      id: row.id,
      code: row.code,
      role: row.role,
      schoolId: row.school_id,
      transfersFrom: row.transfers_from,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: statusOf(c, row),
      redeemedByName: row.redeemed_by_name,
    });
  }
  return { invites };
}

function statusOf(
  c: Ctx,
  row: { redeemed_at: string | null; revoked_at: string | null; expires_at: string },
): string {
  if (row.redeemed_at) return 'redeemed';
  if (row.revoked_at) return 'revoked';
  return Date.parse(row.expires_at) <= c.now ? 'expired' : 'open';
}

export function adminStaffInviteRevoke(c: Ctx, req: { inviteId: string; idempotencyKey: string }) {
  const issuer = requireRole(c, ['school_admin', 'staff']);
  const inviteId = requireString(req.inviteId, 'inviteId', 64);

  // Read before revoking so a school administrator cannot revoke another
  // school's invite by guessing an id.
  const existing = c.nk.sqlQuery(Q.staffInviteById, [inviteId]) as { school_id: string | null }[];
  if (existing.length === 0) throw notFound('No such invite');
  if (
    issuer.role !== 'staff' &&
    (existing[0] as { school_id: string | null }).school_id !== issuer.schoolId
  ) {
    throw forbidden('That invite belongs to another school');
  }

  const revoked = c.nk.sqlQuery(Q.staffInviteRevoke, [inviteId]);
  if (revoked.length === 0) throw conflict('already_closed', 'That invite is already spent');

  audit(c, 'staff.invite.revoke', 'invite', inviteId, {});
  return { revoked: true, at: toIso(c.now) };
}

/**
 * Ten characters from an alphabet with no ambiguous glyphs.
 *
 * Longer than a class code because a class code is bounded by expiry, class
 * size, and a five-failure limit, while this one confers a role. The same
 * 0/O and 1/I exclusions apply — it will be read down a phone line.
 */
function generateInviteCode(c: Ctx): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    while (code.length < CODE_LENGTH) {
      const uuid = c.nk.uuidv4().replace(/-/g, '');
      for (let i = 0; i < 8 && code.length < CODE_LENGTH; i++) {
        code += alphabet.charAt(parseInt(uuid.substr(i * 2, 2), 16) % alphabet.length);
      }
    }
    if (c.nk.sqlQuery(Q.staffInviteExists, [code]).length === 0) return code;
  }
  throw invalidArgument('Could not allocate an invite code, please try again');
}
