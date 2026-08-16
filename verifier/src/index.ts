/**
 * The auth verifier sidecar (ADR-004).
 *
 * Deliberately tiny: one real endpoint, no database, no session state. It can
 * crash and restart with no consequence beyond sign-ins pausing for a moment,
 * and existing sessions are untouched — which matters because thirdweb being
 * unavailable during a class onboarding session is the concentrated risk in
 * this design (OQ-03).
 *
 * What it must never do: issue an assertion for an address it has not seen
 * proof of. Every other check in the chain is ceremony around that one.
 */

import express, { type Request, type Response } from 'express';
import { createThirdwebClient } from 'thirdweb';
import { createAuth } from 'thirdweb/auth';

import {
  ASSERTION_TTL_SECONDS,
  buildClaims,
  signAssertion,
  verifyJoinGrant,
  type AuthStrategy,
} from './assertion.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at start, not at the first sign-in. A verifier running without its
    // secret would either reject everyone or, worse, sign with an empty key.
    throw new Error(`${name} is required`);
  }
  return value;
}

const PORT = Number(process.env.VERIFIER_PORT ?? 8787);
const HMAC_SECRET = required('ASSERTION_HMAC_SECRET');
const JOIN_GRANT_SECRET = process.env.JOIN_GRANT_HMAC_SECRET ?? '';
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY ?? '';
const AUTH_DOMAIN = process.env.AUTH_DOMAIN ?? 'localhost:8787';

if (HMAC_SECRET.length < 32) {
  throw new Error('ASSERTION_HMAC_SECRET must be at least 32 characters');
}

const auth = THIRDWEB_SECRET_KEY
  ? createAuth({
      domain: AUTH_DOMAIN,
      client: createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY }),
    })
  : null;

const app = express();
app.use(express.json({ limit: '16kb' }));

/** Never log a token, an assertion, or an email (20-14). */
function logAttempt(outcome: string, detail?: string): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), outcome, detail: detail ?? null }));
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Exchange a thirdweb RS256 JWT for a short-lived HS256 assertion.
 */
app.post('/session', async (req: Request, res: Response) => {
  const twJwt = (req.body as { twJwt?: unknown })?.twJwt;

  if (typeof twJwt !== 'string' || twJwt.length === 0) {
    logAttempt('rejected', 'missing_token');
    return res.status(400).json({ error: 'missing_token' });
  }

  if (!auth) {
    logAttempt('unavailable', 'thirdweb_not_configured');
    return res.status(503).json({ error: 'verifier_not_configured' });
  }

  try {
    const result = await auth.verifyJWT({ jwt: twJwt });
    if (!result.valid) {
      logAttempt('rejected', 'invalid_token');
      return res.status(401).json({ error: 'invalid_token' });
    }

    const parsed = result.parsedJWT as { sub?: string; ctx?: { strategy?: string } };
    const address = (parsed.sub ?? '').toLowerCase();
    if (!address.startsWith('0x')) {
      logAttempt('rejected', 'unexpected_subject');
      return res.status(401).json({ error: 'invalid_token' });
    }

    const strategy = normaliseStrategy(parsed.ctx?.strategy);
    const claims = buildClaims(address, strategy, nowSeconds());

    logAttempt('issued', strategy);
    return res.json({
      assertion: signAssertion(claims, HMAC_SECRET),
      address,
      expiresIn: ASSERTION_TTL_SECONDS,
    });
  } catch (err) {
    logAttempt('error', err instanceof Error ? err.name : 'unknown');
    return res.status(401).json({ error: 'invalid_token' });
  }
});

/**
 * Class-code onboarding (TRD-AUTH-004).
 *
 * The grant is minted by Nakama after it has validated the class code, so this
 * service never decides who may join a class — it only attests an identity for
 * a grant that Nakama already signed. Reversing that would put class
 * membership behind a service with no database and no audit log.
 */
app.post('/session/class-code', async (req: Request, res: Response) => {
  const grant = (req.body as { grant?: unknown })?.grant;

  if (!JOIN_GRANT_SECRET) {
    logAttempt('unavailable', 'join_grant_not_configured');
    return res.status(503).json({ error: 'verifier_not_configured' });
  }
  if (typeof grant !== 'string') {
    logAttempt('rejected', 'missing_grant');
    return res.status(400).json({ error: 'missing_grant' });
  }

  const verified = verifyJoinGrant(grant, JOIN_GRANT_SECRET, nowSeconds());
  if (!verified.valid) {
    logAttempt('rejected', `grant_${verified.reason}`);
    return res.status(401).json({ error: 'invalid_grant' });
  }

  // Whether thirdweb can provision a wallet headlessly from a server-generated
  // identifier — and later link it to an email keeping the same address — is
  // unverified against a live integration (OQ-04). Until that spike lands,
  // this path reports itself unimplemented rather than silently minting an
  // address that cannot be upgraded, which would strand every class-code
  // student's certificates at R3.
  logAttempt('unimplemented', 'headless_provisioning_pending_oq04');
  return res.status(501).json({
    error: 'not_implemented',
    detail: 'headless wallet provisioning is pending the thirdweb spike (OQ-04)',
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    thirdweb: auth !== null,
    classCode: JOIN_GRANT_SECRET.length > 0,
  });
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      msg: 'verifier listening',
      port: PORT,
      thirdweb: auth !== null,
    }),
  );
});

function normaliseStrategy(value: unknown): AuthStrategy {
  if (value === 'google') return 'google';
  if (value === 'class_code') return 'class_code';
  return 'email';
}
