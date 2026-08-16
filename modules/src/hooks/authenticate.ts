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

const ISSUER = 'lenterra-verifier';
const AUDIENCE = 'lenterra-nakama';
const CLOCK_SKEW_SECONDS = 30;

interface AssertionClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  strategy?: string;
}

function secrets(ctx: nkruntime.Context): string[] {
  const env = ctx.env ?? {};
  const out: string[] = [];
  if (env['ASSERTION_HMAC_SECRET']) out.push(env['ASSERTION_HMAC_SECRET'] as string);
  // Rotation accepts both keys during the window, so replacing the secret does
  // not create a period in which every sign-in fails.
  if (env['ASSERTION_HMAC_SECRET_PREVIOUS']) {
    out.push(env['ASSERTION_HMAC_SECRET_PREVIOUS'] as string);
  }
  return out;
}

/**
 * Constant-time comparison.
 *
 * Length and content are both compared without an early exit, so the timing
 * leaks neither.
 */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = a.length > b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * `nk.hmacSha256Hash` returns an ArrayBuffer and `base64UrlEncode` may or may
 * not pad depending on the runtime build. Padding is stripped here so the
 * comparison is against exactly what Node's `digest('base64url')` produced on
 * the verifier side — a padding mismatch would reject every valid sign-in.
 */
function unpadded(value: string): string {
  return value.replace(/=+$/, '');
}

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
  if (!assertion) reject('missing_assertion');

  const parts = assertion.split('.');
  if (parts.length !== 3) reject('malformed_assertion');

  const keys = secrets(ctx);
  if (keys.length === 0) {
    logger.error('ASSERTION_HMAC_SECRET is not configured; refusing all sign-ins');
    throw new LenterraError('UNAVAILABLE', 'Sign-in is temporarily unavailable');
  }

  // 1. signature
  const signingInput = parts[0] + '.' + parts[1];
  const presented = unpadded(parts[2] as string);
  let signatureOk = false;
  for (let i = 0; i < keys.length; i++) {
    const mac = nk.hmacSha256Hash(signingInput, keys[i] as string);
    if (constantTimeEquals(unpadded(nk.base64UrlEncode(mac)), presented)) signatureOk = true;
  }
  if (!signatureOk) reject('bad_signature');

  // 2. claims
  let claims: AssertionClaims;
  try {
    claims = JSON.parse(
      nk.binaryToString(nk.base64UrlDecode(parts[1] as string)),
    ) as AssertionClaims;
  } catch (_e) {
    return reject('malformed_claims');
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== AUDIENCE) reject('bad_audience');
  if (claims.iss !== ISSUER) reject('bad_issuer');
  if (claims.exp < now - CLOCK_SKEW_SECONDS) reject('expired');
  if (claims.iat > now + CLOCK_SKEW_SECONDS) reject('from_the_future');

  // 3. The claim that closes the hole: the assertion's subject must be the
  // account being requested. Without this, every other check is decoration
  // around the same impersonation.
  if (!claims.sub || claims.sub.toLowerCase() !== requestedId) reject('subject_mismatch');

  // 4. replay protection — the jti is burned on first use
  if (!claims.jti) reject('missing_jti');
  const inserted = nk.sqlExec(Q.burnJti, [claims.jti, claims.exp]);
  if (inserted.rowsAffected === 0) reject('replayed');

  // The assertion must never be persisted in account vars, where it would be
  // readable for as long as the account exists.
  delete (account as { vars?: Record<string, string> }).vars!['assertion'];
  (account as { vars: Record<string, string> }).vars['authStrategy'] =
    claims.strategy === 'google' || claims.strategy === 'class_code'
      ? claims.strategy
      : 'email';

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
  const address = ((account && account.id) || '').toLowerCase();
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
    address,
    strategy,
  ]);

  logger.info('profile created user=%s strategy=%s', ctx.userId, strategy);
};

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
