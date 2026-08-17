/**
 * Session bootstrap and profile.
 *
 * `v1.session.bootstrap` is one round trip that tells the client everything it
 * needs to render. On a 3G connection at the start of a lesson, five separate
 * calls is the difference between a screen that appears and a screen that
 * arrives in pieces.
 */

import { invalidArgument } from '../lib/errors';
import { optionalString, requireString, toIso, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { currentCatalog } from '../domain/catalog';
import { balance } from '../domain/ledger';
import { loadProfile, validateDisplayName, type Profile } from '../domain/profile';
import { generateFriendCode } from '../hooks/authenticate';

/**
 * The oldest client the server will serve.
 *
 * The only mechanism for forcing an upgrade when a rules-core change would
 * otherwise cause mass validation failures — and it is applied only after
 * queued attempts have had a chance to drain (TRD-ENG-007).
 */
export const MIN_SUPPORTED_CLIENT = '0.1.0';

export interface BootstrapReq {
  clientVersion?: string;
  coreVersion?: string;
  locale?: string;
}

export interface BootstrapRes {
  profile: {
    userId: string;
    displayName: string;
    friendCode: string;
    role: string;
    locale: string;
    schoolId: string | null;
    onboarded: boolean;
    authStrategy: string;
    /**
     * False for a class-code account that has not added an email yet.
     *
     * The app needs it to know whether to offer the upgrade, and the student
     * needs to be told why: a certificate has to be issued to an address, and
     * until there is one there is nowhere to issue it.
     */
    hasWallet: boolean;
    /**
     * When this account is due to be deleted, if a request is outstanding.
     *
     * Reported because the *cancellation* has to be reachable, and it cannot be
     * offered by a client that does not know a request exists. A student who
     * asks for deletion on a borrowed phone and changes their mind an hour
     * later on another one had, until this was here, no way to take it back —
     * the thirty-day window was a promise the product could not keep.
     */
    deletionScheduledFor: string | null;
  };
  class: { id: string; name: string; leaderboardEnabled: boolean } | null;
  entitlements: string[];
  catalog: { currentVersion: string; clientVersion: string | null; updateRequired: boolean };
  summary: { points: number; streakDays: number; rank: number | null };
  serverTime: string;
  minSupportedClient: string;
}

export function sessionBootstrap(c: Ctx, req: BootstrapReq): BootstrapRes {
  const profile = loadProfile(c);
  const catalog = currentCatalog(c);

  const classRows = c.nk.sqlQuery(Q.classOfUser, [c.userId]);
  const klass =
    classRows.length === 0
      ? null
      : (function () {
          const row = classRows[0] as { id: string; name: string; leaderboard_enabled: boolean };
          return { id: row.id, name: row.name, leaderboardEnabled: row.leaderboard_enabled };
        })();

  const entitlementRows = c.nk.sqlQuery(Q.entitlements, [c.userId]) as { entitlement: string }[];
  const entitlements: string[] = [];
  for (let i = 0; i < entitlementRows.length; i++) {
    entitlements.push((entitlementRows[i] as { entitlement: string }).entitlement);
  }
  if (entitlements.length === 0) entitlements.push('free');

  const streakRows = c.nk.sqlQuery(Q.streakRead, [c.userId]);
  const streakDays =
    streakRows.length === 0 ? 0 : Number((streakRows[0] as { current_days: number }).current_days);

  const deletionRows = c.nk.sqlQuery(Q.deletionPending, [c.userId]) as { scheduled_ms: number }[];
  const deletionScheduledFor =
    deletionRows.length === 0
      ? null
      : toIso(Number((deletionRows[0] as { scheduled_ms: number }).scheduled_ms));

  return {
    profile: {
      userId: profile.userId,
      displayName: profile.displayName,
      friendCode: profile.friendCode,
      role: profile.role,
      locale: req.locale ? requireString(req.locale, 'locale', 8) : profile.locale,
      schoolId: profile.schoolId,
      onboarded: profile.onboarded,
      authStrategy: profile.authStrategy,
      hasWallet: profile.hasWallet,
      deletionScheduledFor,
    },
    class: klass,
    entitlements,
    catalog: {
      currentVersion: catalog.version,
      clientVersion: null,
      updateRequired: false,
    },
    summary: { points: balance(c, c.userId), streakDays, rank: null },
    // The client's clock reference for ordering offline events. A device clock
    // can be hours out; this is how the client corrects for it (20-09).
    serverTime: toIso(c.now),
    minSupportedClient: MIN_SUPPORTED_CLIENT,
  };
}

export interface ProfileUpdateReq {
  displayName?: string;
  locale?: string;
  rotateFriendCode?: boolean;
  idempotencyKey: string;
}

export interface ProfileUpdateRes {
  displayName: string;
  friendCode: string;
  locale: string;
}

export function profileUpdate(c: Ctx, req: ProfileUpdateReq): ProfileUpdateRes {
  const displayName = optionalString(req.displayName, 'displayName', 64);
  const locale = optionalString(req.locale, 'locale', 8);

  if (displayName !== null) {
    const rejection = validateDisplayName(displayName);
    if (rejection) {
      throw invalidArgument('That name cannot be used', { reason: rejection });
    }
  }

  let friendCode: string | null = null;
  if (req.rotateFriendCode === true) {
    // A friend code is the student-facing identifier and is rotatable
    // precisely so a child who has shared it too widely can take it back.
    friendCode = uniqueFriendCode(c);
  }

  const rows = c.nk.sqlQuery(Q.profileUpdate, [
    c.userId,
    displayName === null ? null : displayName.trim(),
    locale,
    friendCode,
  ]);
  if (rows.length === 0) throw invalidArgument('Profile not found');

  const row = rows[0] as { display_name: string; friend_code: string; locale: string };
  c.nk.sqlExec(Q.markOnboarded, [c.userId]);

  return { displayName: row.display_name, friendCode: row.friend_code, locale: row.locale };
}

function uniqueFriendCode(c: Ctx): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateFriendCode(c.nk);
    if (c.nk.sqlQuery(Q.friendCodeExists, [code]).length === 0) return code;
  }
  // 32^8 codes; eight collisions in a row means something is very wrong.
  throw invalidArgument('Could not allocate a friend code, please try again');
}

export function profileOf(c: Ctx): Profile {
  return loadProfile(c);
}
