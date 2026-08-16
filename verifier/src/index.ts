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
import { createAuth, type LoginPayload } from 'thirdweb/auth';

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
 * Step 1: issue a login payload for an address to sign.
 *
 * A nonce the client cannot choose is what makes the signature in step 2
 * un-replayable. thirdweb tracks it internally and rejects a reused one.
 */
app.post('/session/challenge', async (req: Request, res: Response) => {
  const address = (req.body as { address?: unknown })?.address;

  if (typeof address !== 'string' || !address.startsWith('0x')) {
    logAttempt('rejected', 'missing_address');
    return res.status(400).json({ error: 'missing_address' });
  }
  if (!auth) {
    logAttempt('unavailable', 'thirdweb_not_configured');
    return res.status(503).json({ error: 'verifier_not_configured' });
  }

  try {
    const payload = await auth.generatePayload({ address });
    logAttempt('challenged');
    return res.json({ payload });
  } catch (err) {
    logAttempt('error', err instanceof Error ? err.name : 'unknown');
    return res.status(500).json({ error: 'challenge_failed' });
  }
});

/**
 * Step 2: exchange a signed login payload for a short-lived HS256 assertion.
 *
 * **Corrected from the original design (ADR-004).** That assumed the wallet
 * could hand over an RS256 JWT via `getAuthToken()`. thirdweb v5 exposes no such
 * method; its supported flow is sign-in-with-Ethereum, where the wallet signs a
 * server-issued payload.
 *
 * This is the better primitive anyway. A bearer token proves only that the
 * holder was given one; a signature over a server-chosen nonce proves the caller
 * controls the private key for that address *right now* — which is exactly the
 * claim the whole chain exists to establish.
 */
app.post('/session', async (req: Request, res: Response) => {
  const body = req.body as { payload?: LoginPayload; signature?: unknown; strategy?: unknown };

  if (!body?.payload || typeof body.signature !== 'string') {
    logAttempt('rejected', 'missing_signature');
    return res.status(400).json({ error: 'missing_signature' });
  }
  if (!auth) {
    logAttempt('unavailable', 'thirdweb_not_configured');
    return res.status(503).json({ error: 'verifier_not_configured' });
  }

  try {
    const verified = await auth.verifyPayload({
      payload: body.payload,
      signature: body.signature as `0x${string}`,
    });

    if (!verified.valid) {
      logAttempt('rejected', 'invalid_signature');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    // The address comes from the *verified* payload, never from the request
    // body. Reading it from anywhere else would reintroduce the hole this
    // whole service exists to close.
    const address = verified.payload.address.toLowerCase();
    if (!address.startsWith('0x')) {
      logAttempt('rejected', 'unexpected_subject');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const strategy = normaliseStrategy(body.strategy);
    const claims = buildClaims(address, strategy, nowSeconds());

    logAttempt('issued', strategy);
    return res.json({
      assertion: signAssertion(claims, HMAC_SECRET),
      address,
      expiresIn: ASSERTION_TTL_SECONDS,
    });
  } catch (err) {
    logAttempt('error', err instanceof Error ? err.name : 'unknown');
    return res.status(401).json({ error: 'invalid_signature' });
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
