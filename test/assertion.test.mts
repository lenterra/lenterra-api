/**
 * The assertion, signed by the verifier and checked by Nakama.
 *
 * The other half of the same two-runtime wire format as `grant.test.mts`, and
 * the more consequential half: this is the check that makes identity mean
 * anything. Before it existed the client sent a wallet address and the server
 * believed it, so anyone who knew another student's address could sign in as
 * them.
 *
 * Until now the only thing exercising it was the integration suite, which needs
 * a real Nakama and therefore runs in CI only — so on the machine where the
 * code is written, nothing checked it at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

import { verifyAssertion } from '../modules/src/lib/assertion.ts';
import { buildClaims, signAssertion } from '../verifier/src/assertion.ts';

const SECRET = 'an-assertion-secret-of-at-least-32-characters';
const OTHER = 'a-rotated-assertion-secret-32-chars-plus';
const ADDRESS = '0x82e5aa1b7c9d4f0e6a3b8c5d2e1f0a9b8c7d6e03';

function nk(padding = false) {
  const encode = (value: string | ArrayBuffer): string => {
    const buffer =
      typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value as ArrayBuffer);
    const raw = buffer.toString('base64url');
    if (!padding) return raw;
    const remainder = raw.length % 4;
    return remainder === 0 ? raw : raw + '='.repeat(4 - remainder);
  };

  return {
    base64UrlEncode: encode,
    base64UrlDecode: (value: string) => {
      const buffer = Buffer.from(value, 'base64url');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    binaryToString: (data: ArrayBuffer) => Buffer.from(data).toString('utf8'),
    hmacSha256Hash: (input: string, key: string) => {
      const mac = createHmac('sha256', key).update(input).digest();
      return mac.buffer.slice(mac.byteOffset, mac.byteOffset + mac.byteLength);
    },
  } as unknown as nkruntime.Nakama;
}

const now = () => Math.floor(Date.now() / 1000);

test('an assertion the verifier signed is accepted for the subject it names', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', now()), SECRET);
  const result = verifyAssertion(nk(), [SECRET], assertion, ADDRESS, now());

  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  if (!result.ok) return;
  assert.equal(result.claims.sub, ADDRESS);
  assert.equal(result.strategy, 'email');
});

test('a padded base64url encoder does not reject every valid assertion', () => {
  // `nk.base64UrlEncode` pads or does not depending on the Nakama build. If the
  // comparison were length-sensitive this would fail all of them at once, which
  // is a whole deployment failing to sign in rather than a subtle bug.
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', now()), SECRET);
  assert.equal(verifyAssertion(nk(true), [SECRET], assertion, ADDRESS, now()).ok, true);
});

test('an assertion for one address cannot be used to become another', () => {
  // The hole the whole chain exists to close. Everything else here is ceremony
  // around this single check.
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', now()), SECRET);
  const result = verifyAssertion(
    nk(),
    [SECRET],
    assertion,
    '0x0000000000000000000000000000000000000001',
    now(),
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'subject_mismatch');
});

test('an address differing only in case is the same account, not a second one', () => {
  const assertion = signAssertion(buildClaims(ADDRESS.toUpperCase(), 'email', now()), SECRET);
  assert.equal(verifyAssertion(nk(), [SECRET], assertion, ADDRESS, now()).ok, true);
});

test('rotation accepts the previous secret, so replacing one does not lock everybody out', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'google', now()), OTHER);

  assert.equal(verifyAssertion(nk(), [SECRET], assertion, ADDRESS, now()).ok, false);
  assert.equal(verifyAssertion(nk(), [SECRET, OTHER], assertion, ADDRESS, now()).ok, true);
});

test('an assertion signed with an unknown secret is refused', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', now()), 'not-the-secret-at-all-32-chars-x');
  const result = verifyAssertion(nk(), [SECRET], assertion, ADDRESS, now());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad_signature');
});

test('edited claims are refused, because the signature covers them', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', now()), SECRET);
  const [header, payload, mac] = assertion.split('.');

  const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
  claims.sub = '0x0000000000000000000000000000000000000002';
  const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${mac}`;

  assert.equal(verifyAssertion(nk(), [SECRET], tampered, claims.sub, now()).ok, false);
});

test('an expired assertion is refused past the skew window', () => {
  const stale = buildClaims(ADDRESS, 'email', now() - 600);
  const result = verifyAssertion(nk(), [SECRET], signAssertion(stale, SECRET), ADDRESS, now());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'expired');
});

test('a small clock difference does not reject a valid sign-in', () => {
  // Phones are shared and their clocks are wrong. A student whose handset is
  // twenty seconds fast must still be able to sign in.
  const claims = buildClaims(ADDRESS, 'email', now() + 20);
  assert.equal(verifyAssertion(nk(), [SECRET], signAssertion(claims, SECRET), ADDRESS, now()).ok, true);
});

test('an assertion dated far in the future is refused', () => {
  const claims = buildClaims(ADDRESS, 'email', now() + 3600);
  const result = verifyAssertion(nk(), [SECRET], signAssertion(claims, SECRET), ADDRESS, now());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'from_the_future');
});

test('the wrong audience or issuer is refused', () => {
  for (const [field, value, reason] of [
    ['aud', 'somebody-elses-service', 'bad_audience'],
    ['iss', 'somebody-elses-verifier', 'bad_issuer'],
  ] as const) {
    const claims = { ...buildClaims(ADDRESS, 'email', now()), [field]: value };
    const result = verifyAssertion(nk(), [SECRET], signAssertion(claims, SECRET), ADDRESS, now());

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, reason);
  }
});

test('an assertion with no jti is refused, because replay protection needs one', () => {
  const claims = { ...buildClaims(ADDRESS, 'email', now()), jti: '' };
  const result = verifyAssertion(nk(), [SECRET], signAssertion(claims, SECRET), ADDRESS, now());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'missing_jti');
});

test('a malformed assertion is refused before any of it is trusted', () => {
  for (const [input, reason] of [
    ['', 'missing_assertion'],
    ['a.b', 'malformed_assertion'],
    ['a.b.c.d', 'malformed_assertion'],
  ] as const) {
    const result = verifyAssertion(nk(), [SECRET], input, ADDRESS, now());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, reason);
  }
});

test('a correctly signed assertion with an unreadable body is refused', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from('not json at all').toString('base64url');
  const body = `${header}.${payload}`;
  const mac = createHmac('sha256', SECRET).update(body).digest('base64url');

  const result = verifyAssertion(nk(), [SECRET], `${body}.${mac}`, ADDRESS, now());
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'malformed_claims');
});

test('with no secret configured nothing verifies, rather than everything', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', now()), SECRET);
  const result = verifyAssertion(nk(), [], assertion, ADDRESS, now());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'no_secret_configured');
});

test('an unknown strategy reads as email rather than as something new', () => {
  const claims = { ...buildClaims(ADDRESS, 'email', now()), strategy: 'nonsense' as never };
  const result = verifyAssertion(nk(), [SECRET], signAssertion(claims, SECRET), ADDRESS, now());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.strategy, 'email');
});

test('a class-code subject is not an address, and is accepted as itself', () => {
  // The deferred provisioner issues an opaque id. Nothing in verification may
  // assume a subject looks like an address — that assumption is what the
  // upgrade path checks for deliberately, and it belongs there, not here.
  const opaque = 'lc_9f2c1d8e4b6a70335c1e2d4f8a9b0c1d';
  const assertion = signAssertion(buildClaims(opaque, 'class_code', now(), randomUUID()), SECRET);
  const result = verifyAssertion(nk(), [SECRET], assertion, opaque, now());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.strategy, 'class_code');
});

test('a class-code assertion reuses the grant jti, which is what makes a grant single-use', () => {
  const jti = randomUUID();
  const assertion = signAssertion(buildClaims('lc_abc', 'class_code', now(), jti), SECRET);
  const result = verifyAssertion(nk(), [SECRET], assertion, 'lc_abc', now());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.claims.jti, jti);
});
