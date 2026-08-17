/**
 * HS256 assertion minting (ADR-004, TRD-AUTH-001/002).
 *
 * Nakama's TypeScript runtime provides `nk.hmacSha256Hash` but no JWT
 * *verification* primitive, and no way to run thirdweb's Node SDK. So this
 * service verifies the RS256 token where a real runtime exists and re-attests
 * it with a primitive Nakama genuinely has.
 *
 * The assertion is short-lived and single-use by construction: 120 seconds is
 * enough for a slow 3G handshake and short enough that a leaked assertion is
 * worthless before anyone can use it, and the `jti` is burned on first use by
 * the Nakama hook.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const ASSERTION_TTL_SECONDS = 120;
export const ISSUER = 'lenterra-verifier';
export const AUDIENCE = 'lenterra-nakama';

export type AuthStrategy = 'email' | 'google' | 'class_code';

export interface AssertionClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  strategy: AuthStrategy;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Compact JWS over the claims. Header is fixed; there is only one algorithm. */
export function signAssertion(claims: AssertionClaims, secret: string): string {
  const body = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(claims),
  )}`;
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * @param jti Supply the join grant's own `jti` on the class-code path. Nakama
 *   burns it when the assertion is presented, which is what makes the grant
 *   single-use without this service needing a database to remember grants it
 *   has already honoured. Everywhere else a fresh one is correct.
 */
export function buildClaims(
  subject: string,
  strategy: AuthStrategy,
  nowSeconds: number,
  jti?: string,
): AssertionClaims {
  return {
    // Lower-cased here and compared lower-cased in the hook. A subject that
    // differs only in case must not be able to masquerade as a second account.
    sub: subject.toLowerCase(),
    iss: ISSUER,
    aud: AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
    jti: jti ?? randomUUID(),
    strategy,
  };
}

/**
 * Verify an assertion this service minted.
 *
 * Only used by the service's own tests and by the health check — Nakama does
 * the real verification. Kept here so both sides are written against the same
 * understanding of the format.
 */
export function verifyAssertion(
  assertion: string,
  secrets: string[],
  nowSeconds: number,
): { valid: true; claims: AssertionClaims } | { valid: false; reason: string } {
  const parts = assertion.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  const body = `${parts[0]}.${parts[1]}`;
  let matched = false;

  // Rotation accepts two keys at once, so the secret can be replaced without
  // a window in which every sign-in fails (TRD-AUTH-001).
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts[2] as string);
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  if (!matched) return { valid: false, reason: 'bad_signature' };

  let claims: AssertionClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed_claims' };
  }

  if (claims.iss !== ISSUER) return { valid: false, reason: 'bad_issuer' };
  if (claims.aud !== AUDIENCE) return { valid: false, reason: 'bad_audience' };
  if (claims.exp < nowSeconds - 30) return { valid: false, reason: 'expired' };
  if (claims.iat > nowSeconds + 30) return { valid: false, reason: 'from_the_future' };

  return { valid: true, claims };
}

/**
 * Join grants for class-code onboarding (TRD-AUTH-004).
 *
 * A grant names the class and carries a **server-generated** identity seed.
 * The seed must not be derived from the class code: every student in a class
 * would derive the same wallet, and any student could derive any classmate's.
 */
export interface JoinGrant {
  classId: string;
  seed: string;
  iat: number;
  exp: number;
  jti: string;
}

export const JOIN_GRANT_TTL_SECONDS = 300;

export function verifyJoinGrant(
  grant: string,
  secret: string,
  nowSeconds: number,
): { valid: true; grant: JoinGrant } | { valid: false; reason: string } {
  const parts = grant.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret).update(parts[0] as string).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[1] as string);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload: JoinGrant;
  try {
    payload = JSON.parse(Buffer.from(parts[0] as string, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed_claims' };
  }

  if (payload.exp < nowSeconds) return { valid: false, reason: 'expired' };
  return { valid: true, grant: payload };
}
