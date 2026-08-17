/**
 * Assertion verification and join-grant minting.
 *
 * Two things live here because they are the same primitive used in opposite
 * directions: an HMAC the verifier produces and Nakama checks, and an HMAC
 * Nakama produces and the verifier checks.
 *
 * Verification was previously inlined in `beforeAuthenticateCustom`, which was
 * fine while sign-in was the only caller. It no longer is — upgrading a
 * class-code account to an email presents an assertion too, and an account
 * upgrade that verified assertions *almost* like the sign-in path would be a
 * second front door with a slightly different lock. One implementation, two
 * callers.
 */

const ISSUER = 'lenterra-verifier';
const AUDIENCE = 'lenterra-nakama';
const CLOCK_SKEW_SECONDS = 30;

/**
 * How an account proved who it is.
 *
 * `email` and `google` are no longer issued — nothing in this system reads a
 * mailbox any more — but they are still accepted here, because profiles created
 * under them exist and must keep signing in.
 */
export type AuthStrategy = 'email' | 'google' | 'class_code' | 'staff_code' | 'wallet';

export interface AssertionClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  strategy?: string;
}

export type AssertionResult =
  | { ok: true; claims: AssertionClaims; strategy: AuthStrategy }
  | { ok: false; reason: string };

/**
 * Both live secrets.
 *
 * Rotation accepts the previous key during the window, so replacing the secret
 * does not create a period in which every sign-in fails.
 */
export function assertionSecrets(ctx: nkruntime.Context): string[] {
  const env = ctx.env ?? {};
  const out: string[] = [];
  if (env['ASSERTION_HMAC_SECRET']) out.push(env['ASSERTION_HMAC_SECRET'] as string);
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
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = a.length > b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * `nk.hmacSha256Hash` returns an ArrayBuffer and `base64UrlEncode` may or may
 * not pad depending on the runtime build. Padding is stripped so the comparison
 * is against exactly what Node's `digest('base64url')` produced on the verifier
 * side — a padding mismatch would reject every valid sign-in.
 */
export function unpadded(value: string): string {
  return value.replace(/=+$/, '');
}

export function normaliseStrategy(value: unknown): AuthStrategy {
  if (value === 'google') return 'google';
  if (value === 'class_code') return 'class_code';
  if (value === 'staff_code') return 'staff_code';
  if (value === 'wallet') return 'wallet';
  return 'email';
}

/**
 * Verify an assertion minted by the verifier.
 *
 * Everything except the subject check is ceremony around it: without step 3 the
 * caller could present a valid assertion for one identity while asking to
 * become another.
 *
 * The `jti` is **not** burned here. Burning is a side effect the caller has to
 * decide about — the sign-in hook burns before the account is created, the
 * upgrade RPC burns before it re-keys — and a function that both verifies and
 * mutates cannot be used to check something twice.
 */
export function verifyAssertion(
  nk: nkruntime.Nakama,
  secrets: string[],
  assertion: string,
  expectedSubject: string | null,
  nowSeconds: number,
): AssertionResult {
  if (!assertion) return { ok: false, reason: 'missing_assertion' };
  if (secrets.length === 0) return { ok: false, reason: 'no_secret_configured' };

  const parts = assertion.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_assertion' };

  const signingInput = parts[0] + '.' + parts[1];
  const presented = unpadded(parts[2] as string);
  let signatureOk = false;
  for (let i = 0; i < secrets.length; i++) {
    const mac = nk.hmacSha256Hash(signingInput, secrets[i] as string);
    if (constantTimeEquals(unpadded(nk.base64UrlEncode(mac)), presented)) signatureOk = true;
  }
  if (!signatureOk) return { ok: false, reason: 'bad_signature' };

  let claims: AssertionClaims;
  try {
    claims = JSON.parse(
      nk.binaryToString(nk.base64UrlDecode(parts[1] as string)),
    ) as AssertionClaims;
  } catch (_e) {
    return { ok: false, reason: 'malformed_claims' };
  }

  if (claims.aud !== AUDIENCE) return { ok: false, reason: 'bad_audience' };
  if (claims.iss !== ISSUER) return { ok: false, reason: 'bad_issuer' };
  if (claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'from_the_future' };
  }
  if (!claims.sub) return { ok: false, reason: 'missing_subject' };
  if (expectedSubject !== null && claims.sub.toLowerCase() !== expectedSubject.toLowerCase()) {
    return { ok: false, reason: 'subject_mismatch' };
  }
  if (!claims.jti) return { ok: false, reason: 'missing_jti' };

  return { ok: true, claims, strategy: normaliseStrategy(claims.strategy) };
}

// ---------------------------------------------------------------------------
// Join grants
// ---------------------------------------------------------------------------

/**
 * How long a student has between reading the code off the board and finishing
 * sign-in. Long enough for a slow handset on a slow network, short enough that
 * a grant read off a screen over someone's shoulder is worthless by the time
 * it could be used.
 */
export const JOIN_GRANT_TTL_SECONDS = 300;

/**
 * What a grant is a grant *for*.
 *
 * Two kinds share one format because they are the same statement — "a code was
 * presented and this server found it valid" — about two different codes. What
 * they must not share is a redemption path: a class code admits a child to a
 * class, a staff code admits an adult to other people's children's records, and
 * `kind` is what stops one being presented where the other is expected.
 */
export type GrantSubject =
  | { kind: 'class'; classId: string }
  | { kind: 'staff'; inviteId: string };

export interface Grant {
  /** Absent on grants minted before staff codes existed; those are class grants. */
  kind?: 'class' | 'staff';
  classId?: string;
  inviteId?: string;
  /** Server-generated. Never derived from the code — see `mintGrant`. */
  seed: string;
  iat: number;
  exp: number;
  jti: string;
}

/**
 * Mint a grant the verifier will accept.
 *
 * The seed is `nk.uuidv4()` and nothing else. Deriving it from the code would
 * give every student in a class the same identity, and would let any one of them
 * derive any classmate's.
 *
 * The `jti` becomes the assertion's `jti` further down the chain, which is what
 * makes the grant single-use: `Q.burnJti` rejects the second presentation. The
 * verifier holds no state and must not have to.
 *
 * Note what a grant does **not** carry: no role, no school, no class membership.
 * A staff grant names the invite and stops there, so the authority it confers is
 * read from the database at redemption rather than travelling through a client.
 */
export function mintGrant(
  nk: nkruntime.Nakama,
  secret: string,
  subject: GrantSubject,
  nowSeconds: number,
): string {
  const grant: Grant = {
    kind: subject.kind,
    seed: nk.uuidv4(),
    iat: nowSeconds,
    exp: nowSeconds + JOIN_GRANT_TTL_SECONDS,
    jti: nk.uuidv4(),
  };
  if (subject.kind === 'class') grant.classId = subject.classId;
  else grant.inviteId = subject.inviteId;

  // The verifier signs over the encoded payload rather than the JSON, so the
  // two sides never have to agree on key ordering or whitespace.
  const payload = unpadded(nk.base64UrlEncode(nk.stringToBinary(JSON.stringify(grant))));
  const mac = unpadded(nk.base64UrlEncode(nk.hmacSha256Hash(payload, secret)));
  return payload + '.' + mac;
}
