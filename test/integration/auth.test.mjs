/**
 * Authentication against a real Nakama.
 *
 * **The highest-priority test in the project.** Everything else assumes
 * identity means something, and today it does not: the client sends a wallet
 * address and the server believes it. These cases are what make that false.
 *
 * Runs in CI only — Nakama has no arm64 image, so it cannot run on the primary
 * development machine (docs/local-development.md). Skips cleanly when no server
 * is reachable.
 */

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

const HOST = process.env.NAKAMA_HOST ?? 'localhost';
const PORT = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'lenterra-localdev-key';
const SECRET = process.env.ASSERTION_HMAC_SECRET ?? '';

const BASE = `http://${HOST}:${PORT}`;
let available = false;

before(async () => {
  if (!SECRET) {
    console.log('skipping auth integration: ASSERTION_HMAC_SECRET not set');
    return;
  }
  try {
    const res = await fetch(`${BASE}/healthcheck`, { signal: AbortSignal.timeout(4000) });
    available = res.ok;
  } catch {
    console.log(`skipping auth integration: no Nakama at ${BASE}`);
  }
});

const b64url = (value) => Buffer.from(value).toString('base64url');

function mintAssertion(claims, secret = SECRET) {
  const body = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(claims),
  )}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function validClaims(address, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: address,
    iss: 'lenterra-verifier',
    aud: 'lenterra-nakama',
    iat: now,
    exp: now + 120,
    jti: randomUUID(),
    strategy: 'email',
    ...over,
  };
}

/** Raw `authenticate/custom`, so the assertion can be controlled precisely. */
async function authenticate(address, vars) {
  const res = await fetch(`${BASE}/v2/account/authenticate/custom?create=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${SERVER_KEY}:`).toString('base64')}`,
    },
    body: JSON.stringify({ id: address, vars }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const newAddress = () => `0x${randomUUID().replace(/-/g, '')}${'0'.repeat(8)}`.slice(0, 42);

describe('authenticateCustom', () => {
  test('a valid assertion signs in and creates a profile', async (t) => {
    if (!available) return t.skip('no nakama');

    const address = newAddress();
    const result = await authenticate(address, {
      assertion: mintAssertion(validClaims(address)),
    });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.body.token, 'a session token is returned');
  });

  // --- the six rejection cases (TRD-AUTH-003) -----------------------------

  test('rejects a missing assertion', async (t) => {
    if (!available) return t.skip('no nakama');
    const result = await authenticate(newAddress(), {});
    assert.notEqual(result.status, 200);
  });

  test('rejects a malformed assertion', async (t) => {
    if (!available) return t.skip('no nakama');
    const result = await authenticate(newAddress(), { assertion: 'not.a.jwt.at.all' });
    assert.notEqual(result.status, 200);
  });

  test('rejects an assertion signed with the wrong key', async (t) => {
    if (!available) return t.skip('no nakama');

    const address = newAddress();
    const forged = mintAssertion(validClaims(address), 'a-different-secret-entirely-32-chars');
    const result = await authenticate(address, { assertion: forged });

    assert.notEqual(result.status, 200, 'an unsigned identity must not be accepted');
  });

  test('rejects an expired assertion', async (t) => {
    if (!available) return t.skip('no nakama');

    const address = newAddress();
    const now = Math.floor(Date.now() / 1000);
    const expired = mintAssertion(validClaims(address, { iat: now - 600, exp: now - 300 }));

    assert.notEqual((await authenticate(address, { assertion: expired })).status, 200);
  });

  test('rejects a replayed assertion', async (t) => {
    if (!available) return t.skip('no nakama');

    const address = newAddress();
    const assertion = mintAssertion(validClaims(address));

    const first = await authenticate(address, { assertion });
    assert.equal(first.status, 200);

    const second = await authenticate(address, { assertion });
    assert.notEqual(second.status, 200, 'a jti must be usable exactly once');
  });

  /**
   * The case that matters most.
   *
   * A caller holding a perfectly valid assertion for their *own* address must
   * not be able to sign in as someone else by naming a different account. This
   * is the exact attack the current implementation permits, and addresses are
   * not secret — the demo prints one on screen.
   */
  test('rejects an assertion whose subject is a different account', async (t) => {
    if (!available) return t.skip('no nakama');

    const mine = newAddress();
    const victim = newAddress();

    // First, establish the victim's account legitimately.
    assert.equal(
      (await authenticate(victim, { assertion: mintAssertion(validClaims(victim)) })).status,
      200,
    );

    // Now present a valid assertion for my own address against theirs.
    const result = await authenticate(victim, {
      assertion: mintAssertion(validClaims(mine)),
    });

    assert.notEqual(result.status, 200, 'subject binding is what closes the impersonation hole');
  });

  test('rejects an assertion with the wrong audience', async (t) => {
    if (!available) return t.skip('no nakama');

    const address = newAddress();
    const wrong = mintAssertion(validClaims(address, { aud: 'somebody-elses-service' }));

    assert.notEqual((await authenticate(address, { assertion: wrong })).status, 200);
  });

  test('the assertion is not persisted into account vars', async (t) => {
    if (!available) return t.skip('no nakama');

    const address = newAddress();
    const assertion = mintAssertion(validClaims(address));
    const session = await authenticate(address, { assertion });
    assert.equal(session.status, 200);

    const res = await fetch(`${BASE}/v2/account`, {
      headers: { Authorization: `Bearer ${session.body.token}` },
    });
    const account = await res.json();
    const vars = account?.custom_id ? (account.vars ?? {}) : {};

    assert.equal(
      JSON.stringify(vars).includes(assertion),
      false,
      'a stored assertion would be readable for the life of the account',
    );
  });
});
