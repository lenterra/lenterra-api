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
import { provisionerFromEnv } from './provision.js';

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
const NAKAMA_URL = process.env.NAKAMA_URL ?? 'http://nakama:7350';
// Reaching a Nakama RPC with no session needs this. It is a server-side secret
// and it stays one — the phone never sees it, which is the whole reason the
// class-code hop runs here rather than on the device.
const NAKAMA_HTTP_KEY = process.env.NAKAMA_HTTP_KEY ?? '';

if (HMAC_SECRET.length < 32) {
  throw new Error('ASSERTION_HMAC_SECRET must be at least 32 characters');
}

const auth = THIRDWEB_SECRET_KEY
  ? createAuth({
      domain: AUTH_DOMAIN,
      client: createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY }),
    })
  : null;

// Throws at start if the selected mode cannot work, for the same reason
// `required()` above does: a service that starts happily and then fails every
// student is a service whose configuration error is found by a classroom.
const provisioner = provisionerFromEnv(process.env);

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
 * **Nakama decides whether the code is real; this service never does.** It
 * holds no database and writes no audit log, so putting class membership behind
 * it would put a list of children behind a process with no memory of who asked.
 * The grant it receives back is Nakama's signed statement that a code was
 * valid, and this endpoint only attests an identity for that statement.
 *
 * The Nakama call is made here rather than from the phone because reaching an
 * RPC with no session requires the runtime HTTP key, and an HTTP key in an APK
 * is an HTTP key in everyone's hands. That key belongs on a server; this is the
 * server it belongs on.
 *
 * The identity itself comes from whichever provisioner is configured. See
 * `provision.ts` for why there are two and what each costs; nothing below this
 * line branches on the answer.
 */
app.post('/session/class-code', async (req: Request, res: Response) => {
  const body = req.body as { code?: unknown; deviceId?: unknown };

  if (!JOIN_GRANT_SECRET || !NAKAMA_HTTP_KEY) {
    logAttempt('unavailable', 'class_code_not_configured');
    return res.status(503).json({ error: 'verifier_not_configured' });
  }
  if (typeof body?.code !== 'string' || body.code.length === 0 || body.code.length > 16) {
    logAttempt('rejected', 'missing_code');
    return res.status(400).json({ error: 'missing_code' });
  }
  if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
    // Without one there is nothing to rate-limit against, and an unlimited
    // guessing channel against a six-character code is the one failure this
    // path must not have.
    logAttempt('rejected', 'missing_device_id');
    return res.status(400).json({ error: 'missing_device_id' });
  }

  const minted = await mintGrant(body.code, body.deviceId);
  if (!minted.ok) {
    logAttempt('rejected', `grant_${minted.code}`);
    return res.status(minted.status).json({ error: minted.code });
  }

  // Verified even though it arrived over a trusted channel. `verifyJoinGrant`
  // stays the single gate, so a misconfigured NAKAMA_URL cannot become a way to
  // inject identities into the system.
  const verified = verifyJoinGrant(minted.grant, JOIN_GRANT_SECRET, nowSeconds());
  if (!verified.valid) {
    logAttempt('error', `grant_${verified.reason}`);
    return res.status(502).json({ error: 'invalid_grant' });
  }

  let identity;
  try {
    identity = await provisioner.provision(verified.grant.seed);
  } catch (err) {
    // Never silently the other mode. Dropping to `deferred` because thirdweb
    // was slow would give some students in one class an address and others
    // none, with nothing in the logs saying which.
    logAttempt('error', err instanceof Error ? err.message : 'provision_failed');
    return res.status(503).json({ error: 'provisioning_failed' });
  }

  // The grant's jti becomes the assertion's, which is what makes the grant
  // single-use: Nakama burns it on first presentation and the second one is
  // rejected as a replay. The verifier holds no state and must not have to.
  const claims = buildClaims(identity.customId, 'class_code', nowSeconds(), verified.grant.jti);

  logAttempt('issued', `class_code_${provisioner.mode}`);
  return res.json({
    assertion: signAssertion(claims, HMAC_SECRET),
    customId: identity.customId,
    walletAddress: identity.walletAddress,
    classId: verified.grant.classId,
    className: minted.className,
    schoolName: minted.schoolName,
    expiresIn: ASSERTION_TTL_SECONDS,
  });
});

type MintResult =
  | { ok: true; grant: string; className: string; schoolName: string }
  | { ok: false; status: number; code: string };

/**
 * Ask Nakama to validate the code and sign a grant for it.
 *
 * Nakama's failures are passed through by *kind* and never by message. It
 * deliberately returns the same answer for an unknown code and an expired one —
 * telling them apart would let someone enumerate which codes ever existed — and
 * relaying its text here would undo that.
 */
async function mintGrant(code: string, deviceId: string): Promise<MintResult> {
  let response: globalThis.Response;
  try {
    response = await fetch(
      `${NAKAMA_URL}/v2/rpc/v1.class.grant?http_key=${encodeURIComponent(NAKAMA_HTTP_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Nakama's HTTP RPC takes the payload as a JSON-encoded *string*.
        body: JSON.stringify(JSON.stringify({ code, deviceId })),
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    return { ok: false, status: 503, code: 'server_unreachable' };
  }

  if (!response.ok) return { ok: false, status: 502, code: 'grant_failed' };

  let envelope: { ok?: boolean; data?: unknown; error?: { code?: string } };
  try {
    const outer = (await response.json()) as { payload?: unknown };
    envelope = JSON.parse(
      typeof outer.payload === 'string' ? outer.payload : JSON.stringify(outer.payload),
    );
  } catch {
    return { ok: false, status: 502, code: 'grant_failed' };
  }

  if (envelope.ok !== true) {
    const code = envelope.error?.code;
    if (code === 'NOT_FOUND') return { ok: false, status: 404, code: 'invalid_code' };
    if (code === 'CONFLICT') return { ok: false, status: 409, code: 'class_full' };
    if (code === 'RATE_LIMITED') return { ok: false, status: 429, code: 'too_many_attempts' };
    return { ok: false, status: 503, code: 'grant_failed' };
  }

  const data = envelope.data as { grant?: unknown; className?: unknown; schoolName?: unknown };
  if (typeof data?.grant !== 'string') return { ok: false, status: 502, code: 'grant_failed' };

  return {
    ok: true,
    grant: data.grant,
    className: typeof data.className === 'string' ? data.className : '',
    schoolName: typeof data.schoolName === 'string' ? data.schoolName : '',
  };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    thirdweb: auth !== null,
    classCode: JOIN_GRANT_SECRET.length > 0 && NAKAMA_HTTP_KEY.length > 0,
    // Named rather than merely on/off: which mode is running decides whether a
    // class-code student has a wallet, and that is not something to discover by
    // reading a profile row.
    provisioner: provisioner.mode,
  });
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      msg: 'verifier listening',
      port: PORT,
      thirdweb: auth !== null,
      provisioner: provisioner.mode,
    }),
  );
});

function normaliseStrategy(value: unknown): AuthStrategy {
  if (value === 'google') return 'google';
  if (value === 'class_code') return 'class_code';
  return 'email';
}
