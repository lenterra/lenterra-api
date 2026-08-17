/**
 * Profiles, roles, and authorisation.
 *
 * Roles live in `lenterra_account_profile.role` rather than Nakama metadata
 * because teacher queries need to join on them. Every teacher RPC starts with
 * one of the checks below; there is no path in which a class id from a request
 * body is trusted (TRD-AUTH-009).
 */

import { forbidden, notFound } from '../lib/errors';
import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';

export type Role = 'student' | 'teacher' | 'school_admin' | 'staff';

/**
 * What the student is wearing.
 *
 * Each slot holds a redeemed item id or null. Resolving an id to a colour or a
 * word is the client's job, against the catalogue it already has — the server
 * stores the choice, not its rendering, so a restyle is a content change rather
 * than a migration.
 */
export interface Equipped {
  avatarColor: string | null;
  boardSkin: string | null;
  title: string | null;
}

export interface Profile {
  userId: string;
  role: Role;
  displayName: string;
  friendCode: string;
  schoolId: string | null;
  locale: string;
  authStrategy: string;
  onboarded: boolean;
  /** False for a class-code account that has not yet added an email. */
  hasWallet: boolean;
  equipped: Equipped;
}

export function loadProfile(c: Ctx, userId?: string): Profile {
  const rows = c.nk.sqlQuery(Q.profileByUser, [userId ?? c.userId]);
  if (rows.length === 0) throw notFound('Profile not found');

  const row = rows[0] as {
    user_id: string;
    role: Role;
    display_name: string;
    friend_code: string;
    school_id: string | null;
    locale: string;
    auth_strategy: string;
    onboarded: boolean;
    has_wallet: boolean;
    equipped_avatar_color: string | null;
    equipped_board_skin: string | null;
    equipped_title: string | null;
  };

  return {
    userId: row.user_id,
    role: row.role,
    displayName: row.display_name,
    friendCode: row.friend_code,
    schoolId: row.school_id,
    locale: row.locale,
    authStrategy: row.auth_strategy,
    onboarded: row.onboarded,
    hasWallet: row.has_wallet === true,
    equipped: {
      // `?? null` rather than a bare read: a profile row written before 0010
      // has no such property at all under goja, and `undefined` would serialise
      // the field out of the response instead of sending an empty slot.
      avatarColor: row.equipped_avatar_color ?? null,
      boardSkin: row.equipped_board_skin ?? null,
      title: row.equipped_title ?? null,
    },
  };
}

/**
 * The class must exist, and it must belong to this teacher.
 *
 * Checked before any data is read, not as a filter on results. A query that
 * fetches first and filters after is one refactor away from leaking another
 * school's children.
 */
export function requireTeacherOf(c: Ctx, classId: string): { id: string; name: string; schoolId: string; leaderboardEnabled: boolean } {
  const rows = c.nk.sqlQuery(Q.classOwnedBy, [classId, c.userId]);
  if (rows.length === 0) throw forbidden('Not your class');

  const row = rows[0] as {
    id: string;
    name: string;
    school_id: string;
    leaderboard_enabled: boolean;
  };
  return {
    id: row.id,
    name: row.name,
    schoolId: row.school_id,
    leaderboardEnabled: row.leaderboard_enabled,
  };
}

export function requireRole(c: Ctx, roles: Role[]): Profile {
  const profile = loadProfile(c);
  if (roles.indexOf(profile.role) < 0) throw forbidden('Not permitted');
  return profile;
}

export function requireStaff(c: Ctx): Profile {
  return requireRole(c, ['staff']);
}

/** A student must actually be in the class a teacher is asking about. */
export function requireMemberOf(c: Ctx, classId: string, userId: string): void {
  const rows = c.nk.sqlQuery(Q.memberOfClass, [classId, userId]);
  if (rows.length === 0) throw notFound('Student is not in this class');
}

/**
 * Display-name validation (PRD-ONB-003).
 *
 * The contact-details check is the one that matters: a display name is visible
 * to a whole class, and a child who puts a phone number in it has published it
 * to everyone. Profanity filtering is deliberately shallow — a wordlist cannot
 * be complete, and the moderation report path is what actually handles abuse.
 */
export type NameRejection = 'too_long' | 'too_short' | 'contains_contact' | 'profanity';

const CONTACT_PATTERNS = [
  /\d{7,}/, // phone numbers
  /@[a-z0-9]/i, // emails and social handles
  /(wa|whatsapp|telegram|tiktok|ig|instagram)[\s.:_-]*\d/i,
  /https?:\/\//i,
  /0x[0-9a-f]{6,}/i, // a wallet address is never a display name
];

const BLOCKED = ['anjing', 'babi', 'bangsat', 'kontol', 'memek', 'fuck', 'shit', 'bitch'];

export function validateDisplayName(name: string): NameRejection | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return 'too_short';
  if (trimmed.length > 24) return 'too_long';

  for (let i = 0; i < CONTACT_PATTERNS.length; i++) {
    if ((CONTACT_PATTERNS[i] as RegExp).test(trimmed)) return 'contains_contact';
  }

  const lower = trimmed.toLowerCase();
  for (let i = 0; i < BLOCKED.length; i++) {
    if (lower.indexOf(BLOCKED[i] as string) >= 0) return 'profanity';
  }
  return null;
}

/** `Ani Putri` → `A•• P•••`. Enough to recognise your own, not to read a roster. */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const masked: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    masked.push(part.charAt(0) + new Array(Math.max(1, part.length - 1) + 1).join('•'));
  }
  return masked.join(' ');
}

export function audit(
  c: Ctx,
  action: string,
  subjectType: string,
  subjectId: string,
  detail?: Record<string, unknown>,
): void {
  c.nk.sqlExec(Q.auditInsert, [
    c.nk.uuidv4(),
    c.userId,
    action,
    subjectType,
    subjectId,
    JSON.stringify(detail ?? {}),
  ]);
}
