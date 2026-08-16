import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256, canonicalJson, hashValue, timingSafeEqual, utf8Bytes } from '../dist/hash.js';

// The hand-written SHA-256 exists because goja has no crypto. These tests
// check it against Node's implementation, which is the only way to know the
// hand-written one is right — and a wrong hash would reject every honest
// offline attempt.

test('sha256 matches the published vectors', () => {
  assert.equal(
    sha256(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('sha256 matches node:crypto across lengths and block boundaries', () => {
  // 55/56/57 and 63/64/65 straddle the padding boundaries, which is where a
  // hand-rolled implementation goes wrong.
  const lengths = [1, 2, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200, 1000];
  for (const length of lengths) {
    let input = '';
    for (let i = 0; i < length; i++) input += String.fromCharCode(97 + (i % 26));
    assert.equal(sha256(input), createHash('sha256').update(input).digest('hex'), `length ${length}`);
  }
});

test('sha256 handles non-ASCII and surrogate pairs', () => {
  for (const input of ['lumbung', 'biji · menembak', 'Keamanan Siber 🇮🇩', '日本語', '👨‍👩‍👧']) {
    assert.equal(
      sha256(input),
      createHash('sha256').update(input, 'utf8').digest('hex'),
      JSON.stringify(input),
    );
  }
});

test('utf8Bytes matches Buffer for multi-byte input', () => {
  const input = 'a£€𝄞';
  assert.deepEqual(utf8Bytes(input), Array.from(Buffer.from(input, 'utf8')));
});

test('canonicalJson is insensitive to key insertion order', () => {
  const a = { pits: [0, 7, 7], toMove: 1, finished: false };
  const b = { finished: false, toMove: 1, pits: [0, 7, 7] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashValue(a), hashValue(b));
});

test('canonicalJson preserves array order', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test('canonicalJson drops undefined members but keeps null', () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test('canonicalJson rejects non-finite numbers rather than emitting null', () => {
  // A NaN in a game state is a bug that should surface, not silently become
  // a null that hashes consistently and hides the problem.
  assert.throws(() => canonicalJson({ x: NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ x: Infinity }), /non-finite/);
});

test('canonicalJson is stable for nested structures', () => {
  const value = { z: [{ b: 1, a: 2 }], a: { d: 4, c: 3 } };
  assert.equal(canonicalJson(value), '{"a":{"c":3,"d":4},"z":[{"a":2,"b":1}]}');
});

test('timingSafeEqual compares content and length', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});
