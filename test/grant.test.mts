/**
 * The join grant, minted on one side and verified on the other.
 *
 * These are two separate implementations of one wire format, in two runtimes,
 * neither of which can import the other: Nakama's half runs in goja with only
 * `nk.*` primitives, the verifier's half runs in Node with `node:crypto`. A
 * disagreement between them is not a compile error and not a type error — it is
 * a class of students who cannot sign in, discovered during the lesson.
 *
 * The padding case is the specific hazard. `nk.base64UrlEncode` pads or does
 * not depending on the runtime build, Node's `digest('base64url')` never pads,
 * and the verifier compares with `timingSafeEqual`, which requires equal
 * lengths. A padded MAC therefore fails every grant rather than some of them,
 * so both encoders are exercised here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

import { JOIN_GRANT_TTL_SECONDS, mintJoinGrant } from '../modules/src/lib/assertion.ts';
import { verifyJoinGrant } from '../verifier/src/assertion.ts';

const SECRET = 'a-join-grant-secret-of-at-least-32-characters';

/**
 * The `nk` surface `mintJoinGrant` touches, backed by node:crypto.
 *
 * @param padding Whether `base64UrlEncode` pads, which is the one behaviour
 *   that genuinely differs between Nakama builds.
 */
function fakeNk(padding: boolean) {
  const encode = (value: string | ArrayBuffer): string => {
    const buffer =
      typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value as ArrayBuffer);
    const raw = buffer.toString('base64url');
    if (!padding) return raw;
    const remainder = raw.length % 4;
    return remainder === 0 ? raw : raw + '='.repeat(4 - remainder);
  };

  return {
    uuidv4: () => randomUUID(),
    stringToBinary: (str: string) => {
      const buffer = Buffer.from(str, 'utf8');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    binaryToString: (data: ArrayBuffer) => Buffer.from(data).toString('utf8'),
    base64UrlEncode: encode,
    hmacSha256Hash: (input: string, key: string) => {
      const mac = createHmac('sha256', key).update(input).digest();
      return mac.buffer.slice(mac.byteOffset, mac.byteOffset + mac.byteLength);
    },
  } as unknown as nkruntime.Nakama;
}

const CLASS_ID = '4b7d4e0a-9a1e-4c9c-8f42-2f0d5b9c1a33';

for (const padding of [false, true]) {
  test(`a grant minted by Nakama verifies at the verifier (padding: ${padding})`, () => {
    const now = Math.floor(Date.now() / 1000);
    const grant = mintJoinGrant(fakeNk(padding), SECRET, CLASS_ID, now);

    const result = verifyJoinGrant(grant, SECRET, now);
    assert.equal(result.valid, true, result.valid ? '' : result.reason);
    if (!result.valid) return;

    assert.equal(result.grant.classId, CLASS_ID);
    assert.equal(result.grant.exp - result.grant.iat, JOIN_GRANT_TTL_SECONDS);
    assert.ok(result.grant.seed.length > 0);
    assert.ok(result.grant.jti.length > 0);
  });
}

test('the seed is never derived from the class, so two students never share one', () => {
  // The property TRD-AUTH-004 turns on. If the seed came from the class code,
  // every student in a class would provision the same identity and any one of
  // them could provision any classmate's.
  const now = Math.floor(Date.now() / 1000);
  const nk = fakeNk(false);

  const seeds = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const result = verifyJoinGrant(mintJoinGrant(nk, SECRET, CLASS_ID, now), SECRET, now);
    assert.equal(result.valid, true);
    if (result.valid) seeds.add(result.grant.seed);
  }

  assert.equal(seeds.size, 50, 'every grant for one class must carry a distinct seed');
});

test('each grant carries its own jti, so honouring one does not burn the next', () => {
  const now = Math.floor(Date.now() / 1000);
  const nk = fakeNk(false);

  const first = verifyJoinGrant(mintJoinGrant(nk, SECRET, CLASS_ID, now), SECRET, now);
  const second = verifyJoinGrant(mintJoinGrant(nk, SECRET, CLASS_ID, now), SECRET, now);
  assert.ok(first.valid && second.valid);
  if (!first.valid || !second.valid) return;

  assert.notEqual(first.grant.jti, second.grant.jti);
});

test('a grant signed with the wrong secret is refused', () => {
  const now = Math.floor(Date.now() / 1000);
  const grant = mintJoinGrant(fakeNk(false), 'a-different-secret-of-at-least-32-characters', CLASS_ID, now);

  const result = verifyJoinGrant(grant, SECRET, now);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'bad_signature');
});

test('a grant with an edited class id is refused', () => {
  // The payload is signed, not merely encoded. Someone who reads a grant off a
  // screen must not be able to point it at a class they were never given a
  // code for.
  const now = Math.floor(Date.now() / 1000);
  const grant = mintJoinGrant(fakeNk(false), SECRET, CLASS_ID, now);

  const [payload, mac] = grant.split('.');
  const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
  decoded.classId = '00000000-0000-4000-8000-000000000000';
  const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${mac}`;

  const result = verifyJoinGrant(tampered, SECRET, now);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'bad_signature');
});

test('an expired grant is refused', () => {
  const now = Math.floor(Date.now() / 1000);
  const grant = mintJoinGrant(fakeNk(false), SECRET, CLASS_ID, now - JOIN_GRANT_TTL_SECONDS - 1);

  const result = verifyJoinGrant(grant, SECRET, now);
  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'expired');
});

test('a grant that is not two dot-separated parts is refused before anything is decoded', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const malformed of ['', 'onepart', 'a.b.c']) {
    const result = verifyJoinGrant(malformed, SECRET, now);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.reason, 'malformed');
  }
});
