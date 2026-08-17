import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  ASSERTION_TTL_SECONDS,
  buildClaims,
  signAssertion,
  verifyAssertion,
  verifyGrant,
} from '../dist/assertion.js';

const SECRET = 'a'.repeat(48);
const OTHER = 'b'.repeat(48);
const NOW = 1_760_000_000;
const ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

test('a freshly minted assertion verifies', () => {
  const claims = buildClaims(ADDRESS, 'email', NOW);
  const result = verifyAssertion(signAssertion(claims, SECRET), [SECRET], NOW);

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.claims.iss, 'lenterra-verifier');
    assert.equal(result.claims.aud, 'lenterra-nakama');
    assert.equal(result.claims.exp - result.claims.iat, ASSERTION_TTL_SECONDS);
  }
});

test('the subject is lower-cased, so case cannot fork an account', () => {
  const claims = buildClaims(ADDRESS, 'email', NOW);
  assert.equal(claims.sub, ADDRESS.toLowerCase());
});

test('each assertion carries a distinct jti', () => {
  const a = buildClaims(ADDRESS, 'email', NOW);
  const b = buildClaims(ADDRESS, 'email', NOW);
  assert.notEqual(a.jti, b.jti, 'a reused jti would defeat replay protection');
});

test('an assertion signed with another key is rejected', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', NOW), OTHER);
  const result = verifyAssertion(assertion, [SECRET], NOW);

  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'bad_signature');
});

test('editing the claims invalidates the signature', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', NOW), SECRET);
  const [header, , mac] = assertion.split('.');

  // Swap the subject for someone else's address — the exact attack the current
  // implementation allows, where a client asserts an identity and the server
  // believes it.
  const forged = Buffer.from(
    JSON.stringify({ ...buildClaims('0xvictim', 'email', NOW), jti: 'x' }),
  ).toString('base64url');

  const result = verifyAssertion(`${header}.${forged}.${mac}`, [SECRET], NOW);
  assert.equal(result.valid, false);
});

test('an expired assertion is rejected past the skew allowance', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', NOW), SECRET);

  // Inside the ±30s tolerance the assertion still passes.
  assert.equal(verifyAssertion(assertion, [SECRET], NOW + ASSERTION_TTL_SECONDS + 20).valid, true);

  const late = verifyAssertion(assertion, [SECRET], NOW + ASSERTION_TTL_SECONDS + 120);
  assert.equal(late.valid, false);
  if (!late.valid) assert.equal(late.reason, 'expired');
});

test('an assertion from the future is rejected', () => {
  const assertion = signAssertion(buildClaims(ADDRESS, 'email', NOW + 600), SECRET);
  const result = verifyAssertion(assertion, [SECRET], NOW);

  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'from_the_future');
});

test('rotation accepts both keys at once, so no sign-in window fails', () => {
  const old = signAssertion(buildClaims(ADDRESS, 'email', NOW), OTHER);
  const fresh = signAssertion(buildClaims(ADDRESS, 'email', NOW), SECRET);

  assert.equal(verifyAssertion(old, [SECRET, OTHER], NOW).valid, true);
  assert.equal(verifyAssertion(fresh, [SECRET, OTHER], NOW).valid, true);
  assert.equal(verifyAssertion(old, [SECRET], NOW).valid, false, 'and the old key stops working');
});

test('a malformed assertion is rejected rather than throwing', () => {
  for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...']) {
    const result = verifyAssertion(bad, [SECRET], NOW);
    assert.equal(result.valid, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Join grants
// ---------------------------------------------------------------------------

function mintGrant(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

test('a valid join grant verifies and carries its class', () => {
  const grant = mintGrant(
    { classId: 'class-1', seed: 'server-generated', iat: NOW, exp: NOW + 300, jti: 'j1' },
    SECRET,
  );
  const result = verifyGrant(grant, SECRET, NOW);

  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.grant.classId, 'class-1');
});

test('a join grant for another class cannot be forged', () => {
  const grant = mintGrant(
    { classId: 'class-1', seed: 's', iat: NOW, exp: NOW + 300, jti: 'j1' },
    OTHER,
  );
  assert.equal(verifyGrant(grant, SECRET, NOW).valid, false);
});

test('an expired join grant is rejected', () => {
  const grant = mintGrant(
    { classId: 'class-1', seed: 's', iat: NOW - 600, exp: NOW - 300, jti: 'j1' },
    SECRET,
  );
  const result = verifyGrant(grant, SECRET, NOW);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'expired');
});

test('a staff grant verifies and carries its invite', () => {
  const grant = mintGrant(
    { kind: 'staff', inviteId: 'invite-1', seed: 's', iat: NOW, exp: NOW + 300, jti: 'j1' },
    SECRET,
  );
  const result = verifyGrant(grant, SECRET, NOW, 'staff');

  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.grant.inviteId, 'invite-1');
});

// The two endpoints mint identically-signed grants, so the only thing keeping a
// class code from being redeemed for a staff role is this check. Both
// directions, because a staff grant presented as a class code would create an
// account with no class and no explanation for it.
test('a grant of the wrong kind is refused in both directions', () => {
  const staff = mintGrant(
    { kind: 'staff', inviteId: 'invite-1', seed: 's', iat: NOW, exp: NOW + 300, jti: 'j1' },
    SECRET,
  );
  const asClass = verifyGrant(staff, SECRET, NOW, 'class');
  assert.equal(asClass.valid, false);
  if (!asClass.valid) assert.equal(asClass.reason, 'wrong_kind');

  const klass = mintGrant(
    { kind: 'class', classId: 'class-1', seed: 's', iat: NOW, exp: NOW + 300, jti: 'j1' },
    SECRET,
  );
  const asStaff = verifyGrant(klass, SECRET, NOW, 'staff');
  assert.equal(asStaff.valid, false);
  if (!asStaff.valid) assert.equal(asStaff.reason, 'wrong_kind');
});

// Grants minted before staff codes existed carry no `kind` at all. They were
// all class grants, and one in flight during a deploy has to keep working.
test('a grant with no kind is treated as a class grant', () => {
  const grant = mintGrant(
    { classId: 'class-1', seed: 's', iat: NOW, exp: NOW + 300, jti: 'j1' },
    SECRET,
  );
  assert.equal(verifyGrant(grant, SECRET, NOW, 'class').valid, true);
  assert.equal(verifyGrant(grant, SECRET, NOW, 'staff').valid, false);
});
