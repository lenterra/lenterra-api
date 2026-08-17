/**
 * Authentication hooks (TRD-AUTH-003).
 *
 * The hole this closes: `authenticateCustom(account.address)` sends a wallet
 * address and the server creates or returns the account for it. Nothing proves
 * the caller controls that address, and addresses are not secret — the demo
 * printed one on screen as "Your ID". Anyone who knows another student's
 * address can sign in as them.
 *
 * Step 3 below is the whole point. Everything else is ceremony around it.
 */

import { LenterraError } from '../lib/errors';
import { Q } from '../db/queries';
import { assertionSecrets, verifyAssertion } from '../lib/assertion';

export const beforeAuthenticateCustom: nkruntime.BeforeHookFunction<
  nkruntime.AuthenticateCustomRequest
> = function (ctx, logger, nk, data) {
  const account = data.account;
  const requestedId = ((account && account.id) || '').toLowerCase();
  const vars = (account && account.vars) || {};
  const assertion = vars['assertion'];

  // Explicitly typed so TypeScript treats a call as unreachable-after, which
  // is what lets the checks below read as guards rather than as conditions.
  const reject: (reason: string) => never = (reason: string): never => {
    // The reason and the requested id are logged; the assertion never is.
    logger.warn('auth rejected reason=%s id=%s', reason, requestedId || '(none)');
    throw new LenterraError('UNAUTHENTICATED', 'Sign-in could not be verified');
  };

  if (!requestedId) reject('missing_custom_id');

  const keys = assertionSecrets(ctx);
  if (keys.length === 0) {
    logger.error('ASSERTION_HMAC_SECRET is not configured; refusing all sign-ins');
    throw new LenterraError('UNAVAILABLE', 'Sign-in is temporarily unavailable');
  }

  // Signature, claims, and — the check the whole chain exists for — that the
  // assertion's subject is the account being requested. Without that last one
  // the caller could present a valid assertion for one identity while asking
  // to become another.
  const verified = verifyAssertion(
    nk,
    keys,
    assertion ?? '',
    requestedId,
    Math.floor(Date.now() / 1000),
  );
  if (!verified.ok) reject(verified.reason);

  // Replay protection — the jti is burned on first use. For a class-code
  // sign-in this jti came from the join grant, which is what makes that grant
  // single-use without the verifier needing a database.
  const inserted = nk.sqlExec(Q.burnJti, [verified.claims.jti, verified.claims.exp]);
  if (inserted.rowsAffected === 0) reject('replayed');

  // The assertion must never be persisted in account vars, where it would be
  // readable for as long as the account exists.
  delete (account as { vars?: Record<string, string> }).vars!['assertion'];
  (account as { vars: Record<string, string> }).vars['authStrategy'] = verified.strategy;

  return data;
};

/**
 * First authentication creates the profile row.
 *
 * The role is always 'student'. Teacher and school-admin roles are granted out
 * of band and audited (TRD-AUTH-010) — never from anything the client sent,
 * because the client sent the vars this function is reading.
 */
export const afterAuthenticateCustom: nkruntime.AfterHookFunction<
  nkruntime.Session,
  nkruntime.AuthenticateCustomRequest
> = function (ctx, logger, nk, out, data) {
  if (!out.created) return;

  const account = data.account;
  const customId = ((account && account.id) || '').toLowerCase();
  const vars = (account && account.vars) || {};

  const strategy = vars['authStrategy'] === 'google'
    ? 'google'
    : vars['authStrategy'] === 'class_code'
      ? 'class_code'
      : 'email';

  nk.sqlExec(Q.insertProfile, [
    ctx.userId,
    generateDisplayName(nk),
    generateFriendCode(nk),
    walletAddressOf(customId),
    strategy,
  ]);

  logger.info('profile created user=%s strategy=%s', ctx.userId, strategy);
};

/**
 * The wallet address, if this identity has one.
 *
 * An email or Google account is keyed by its address, so the custom id *is* the
 * address. A class-code account provisioned in `deferred` mode is keyed by an
 * opaque server-generated id and has no wallet at all until the student adds an
 * email — see `v1.account.upgrade`.
 *
 * Storing the opaque id in `wallet_address` would be worse than storing
 * nothing: every later reader would take it for an address, and the first one
 * to try minting a certificate to it would find out at the worst moment.
 */
function walletAddressOf(customId: string): string | null {
  return customId.indexOf('0x') === 0 ? customId : null;
}

/**
 * A neutral placeholder name.
 *
 * Not derived from the wallet address or an email: a default display name
 * leaking part of either would put a student's identifier in front of their
 * whole class before they have chosen anything.
 */
function generateDisplayName(nk: nkruntime.Nakama): string {
  const uuid = nk.uuidv4().replace(/-/g, '');
  return 'Siswa ' + uuid.slice(0, 4).toUpperCase();
}

/**
 * A rotatable friend code.
 *
 * Ambiguous characters (0/O, 1/I) are excluded because students read these
 * aloud to each other across a classroom.
 */
export function generateFriendCode(nk: nkruntime.Nakama): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const uuid = nk.uuidv4().replace(/-/g, '');
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet.charAt(parseInt(uuid.substr(i * 2, 2), 16) % alphabet.length);
  }
  return code;
}
