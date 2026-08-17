/**
 * Shared plumbing for the integration suite.
 *
 * These tests drive a real Nakama with the real modules loaded, against a real
 * Postgres. That is the only place goja behaviour, hook registration, SQL, and
 * the RPC envelope are exercised together — and Nakama publishes no arm64
 * image, so it is CI or nowhere (docs/local-development.md).
 *
 * Everything here skips cleanly when the stack is absent, so `npm test` on a
 * developer machine stays green rather than red-for-the-wrong-reason. A suite
 * that is red by default is a suite people stop reading.
 *
 * **Roles and schools are seeded through SQL, not through RPCs.** There is no
 * handler that promotes a caller to teacher, deliberately — TRD-AUTH-010 grants
 * staff roles out of band and audits them, and adding a test-only path to do it
 * over the wire would create exactly the privilege-escalation route the absence
 * is there to prevent.
 */

import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

const HOST = process.env.NAKAMA_HOST ?? 'localhost';
const PORT = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'lenterra-localdev-key';
const HTTP_KEY = process.env.NAKAMA_HTTP_KEY ?? 'lenterra-localdev-http';
const SECRET = process.env.ASSERTION_HMAC_SECRET ?? '';

/**
 * Where the server is.
 *
 * `TEST_NAKAMA_URL` points the whole suite at a deployed server — the only way
 * to run any of this on a machine where Nakama's amd64-only image will not
 * start, which is the machine this was written on.
 *
 * **Running this against production writes to production.** These tests create
 * accounts, classes, and attempts, and seed roles directly in the database.
 * Point it at a staging deployment, or at one you are willing to have a test
 * class in.
 */
export const BASE = process.env.TEST_NAKAMA_URL ?? `http://${HOST}:${PORT}`;

/** A remote run needs a database URL too, since roles are seeded through SQL. */
const REMOTE = Boolean(process.env.TEST_NAKAMA_URL);

const PG = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB ?? 'nakama',
      user: process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? 'localdev',
    };

let db = null;

/**
 * Is the stack up?
 *
 * Called from each suite's `before`. Returns false rather than throwing, and
 * every test then skips with a reason naming what was missing.
 */
export async function connect() {
  if (!SECRET) {
    console.log('skipping integration: ASSERTION_HMAC_SECRET not set');
    return false;
  }
  if (REMOTE && !process.env.DATABASE_URL) {
    // Named rather than skipped quietly. Somebody who has set TEST_NAKAMA_URL
    // is trying to run these against a deployment, and a silent skip would let
    // them believe the suite passed there.
    console.log(
      'skipping integration: TEST_NAKAMA_URL is set but DATABASE_URL is not — ' +
        'roles and schools are seeded through SQL, so the suite needs both',
    );
    return false;
  }
  try {
    // A remote server is behind TLS and a proxy, so it gets longer than a
    // container on the same machine.
    const res = await fetch(`${BASE}/healthcheck`, {
      signal: AbortSignal.timeout(REMOTE ? 15_000 : 4000),
    });
    if (!res.ok) {
      // Something answered and it was not a healthy Nakama — a proxy, a parked
      // domain, the wrong host. Skipping silently here would look identical to
      // "no server configured", so it says which.
      console.log(`skipping integration: ${BASE}/healthcheck answered ${res.status}`);
      return false;
    }
  } catch {
    console.log(`skipping integration: no Nakama at ${BASE}`);
    return false;
  }
  try {
    db = new pg.Client(PG);
    await db.connect();
  } catch {
    console.log('skipping integration: no Postgres');
    db = null;
    return false;
  }
  if (REMOTE) console.log(`running integration against ${BASE} — this writes data there`);
  return true;
}

export async function disconnect() {
  if (db) await db.end();
  db = null;
}

export const sql = (text, params = []) => db.query(text, params);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const b64url = (value) => Buffer.from(value).toString('base64url');

export function mintAssertion(claims, secret = SECRET) {
  const body = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(claims),
  )}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function claimsFor(subject, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: subject,
    iss: 'lenterra-verifier',
    aud: 'lenterra-nakama',
    iat: now,
    exp: now + 120,
    jti: randomUUID(),
    strategy: 'email',
    ...over,
  };
}

export const newAddress = () =>
  `0x${randomUUID().replace(/-/g, '')}${'0'.repeat(8)}`.slice(0, 42).toLowerCase();

/** Sign in as a brand-new student. Returns `{token, userId, address}`. */
export async function signIn(address = newAddress(), over = {}) {
  const res = await fetch(`${BASE}/v2/account/authenticate/custom?create=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${SERVER_KEY}:`).toString('base64')}`,
    },
    body: JSON.stringify({
      id: address,
      vars: { assertion: mintAssertion(claimsFor(address, over)) },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sign-in failed ${res.status}: ${JSON.stringify(body)}`);

  const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString('utf8'));
  return { token: body.token, userId: claims.uid, address };
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

/**
 * Call an RPC as a signed-in user and unwrap the envelope.
 *
 * Returns `{ok, data}` or `{ok:false, error}` rather than throwing, because
 * most of these tests are *about* the rejections and a helper that threw would
 * make asserting on a code more awkward than asserting on a value.
 */
export async function call(token, name, payload = {}) {
  const res = await fetch(`${BASE}/v2/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(JSON.stringify(payload)),
    signal: AbortSignal.timeout(30000),
  });

  const outer = await res.json().catch(() => ({}));
  if (!res.ok && outer.message) return { ok: false, http: res.status, error: { code: outer.message } };

  try {
    return JSON.parse(
      typeof outer.payload === 'string' ? outer.payload : JSON.stringify(outer.payload),
    );
  } catch {
    return { ok: false, http: res.status, error: { code: 'UNREADABLE' } };
  }
}

/** Call an RPC with no session, the way the verifier reaches `v1.class.grant`. */
export async function callAnonymous(name, payload = {}) {
  const res = await fetch(`${BASE}/v2/rpc/${name}?http_key=${encodeURIComponent(HTTP_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(payload)),
    signal: AbortSignal.timeout(30000),
  });

  const outer = await res.json().catch(() => ({}));
  try {
    return JSON.parse(
      typeof outer.payload === 'string' ? outer.payload : JSON.stringify(outer.payload),
    );
  } catch {
    return { ok: false, http: res.status, error: { code: 'UNREADABLE' } };
  }
}

// ---------------------------------------------------------------------------
// Fixtures in the database
// ---------------------------------------------------------------------------

export async function createSchool(name = `SMP Uji ${randomUUID().slice(0, 8)}`) {
  const id = randomUUID();
  await sql(
    `INSERT INTO lenterra_school (id, name, district, province) VALUES ($1, $2, 'Uji', 'NTT')`,
    [id, name],
  );
  return id;
}

/** Promote a signed-in user, and attach them to a school. Out of band, as designed. */
export async function makeTeacher(userId, schoolId) {
  await sql(
    `UPDATE lenterra_account_profile SET role = 'teacher', school_id = $2 WHERE user_id = $1`,
    [userId, schoolId],
  );
}

export async function makeStaff(userId) {
  await sql(`UPDATE lenterra_account_profile SET role = 'staff' WHERE user_id = $1`, [userId]);
}

/**
 * Record the consent a school needs before a class can exist.
 *
 * Written directly because the point of most tests using it is what happens
 * *after* consent exists; the gate itself is tested through the RPC, where it
 * belongs.
 */
export async function recordConsent(schoolId, userId) {
  await sql(
    `INSERT INTO lenterra_consent (id, school_id, kind, confirmed_by, process_note)
     VALUES ($1, $2, 'school_participation', $3, $4)
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      schoolId,
      userId,
      'Signed paper forms collected from guardians at the term-opening meeting.',
    ],
  );
}

/** A teacher, their school, its consent, and a class with a join code. */
export async function classroom() {
  const teacher = await signIn();
  const schoolId = await createSchool();
  await makeTeacher(teacher.userId, schoolId);
  await recordConsent(schoolId, teacher.userId);

  const created = await call(teacher.token, 'v1.teacher.class.create', {
    name: `Kelas ${randomUUID().slice(0, 4)}`,
    level: 'SMP',
    idempotencyKey: randomUUID(),
  });
  if (!created.ok) throw new Error(`class create failed: ${JSON.stringify(created.error)}`);

  return { teacher, schoolId, class: created.data };
}
