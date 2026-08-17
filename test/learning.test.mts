/**
 * Grading a course check.
 *
 * This handler decides whether a child's answer was right. It had no test of
 * any kind — not here, not in the integration suite, which pushes only
 * `attempt` items — so every property below was, until now, a property nothing
 * had ever checked.
 *
 * The one that matters most is the first: **the client's claim is not
 * consulted**. The device grades offline against shipped digests so a student
 * sees a result and an explanation the moment they answer, and that provisional
 * grade is deliberately forgeable — the digest is not a secret and says so.
 * What stops a forged grade from becoming a real one is that this function
 * regrades from the answer key and persists only its own result. If that ever
 * stopped being true it would not look like a bug; it would look like a
 * generation of students who had all mastered everything.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Q } from '../modules/src/db/queries.ts';
import { checkSubmit } from '../modules/src/rpc/learning.ts';
import { fakeCtx, refusal, stub, type Responder } from './fake-nk.mts';

const ME = '77777777-7777-4777-8777-777777777777';

/**
 * A two-item key with a 0.7 pass mark, so one right out of two is 0.5 and
 * fails. Both thresholds are exercised without a third item.
 */
const KEY = {
  passMark: 0.7,
  skillWeights: { 'algo.sequencing': 0.6, 'comp.counting': 0.4 },
  items: [
    { itemId: 'i1', correct: 'b', explainKey: 'course.c1.i1.confuses-order' },
    { itemId: 'i2', correct: [1, 2], explainKey: 'course.c1.i2.off-by-one' },
  ],
};

const RIGHT = [
  { itemId: 'i1', answer: 'b' },
  { itemId: 'i2', answer: [1, 2] },
];

const HALF = [
  { itemId: 'i1', answer: 'b' },
  { itemId: 'i2', answer: [2, 1] },
];

const req = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'k-1',
  checkId: 'check.c1.l1',
  courseId: 'course.c1',
  lessonId: 'lesson.c1.l1',
  catalogVersion: 'v1',
  answers: RIGHT,
  ...over,
});

/** Everything a first-time, successful grade touches. */
function stubs(over: [string, Responder][] = []): [string, Responder][] {
  return [
    [Q.checkByKey, () => []],
    [Q.catalogPull, () => [{ body: { 'check.c1.l1': KEY } }]],
    [Q.checkAttemptNumber, () => [{ n: 1 }]],
    [Q.checkInsert, () => [{ id: 'row' }]],
    [Q.masteryForUser, () => []],
    [Q.masterySourceKeys, () => []],
    [Q.masteryEventInsert, () => [{ id: 'ev' }]],
    [Q.masteryUpsert, () => [{ id: 'up' }]],
    [Q.pointsAward, () => [{ id: 'pt' }]],
    [Q.lessonComplete, () => [{}]],
    ...over,
  ];
}

describe('checkSubmit — the grade is the server\'s', () => {
  test('grades from the answer key, whatever the client believed', () => {
    // The payload carries no grade at all, by design: there is no field for the
    // client to lie in. This asserts the shape stays that way — a `score` or
    // `passed` accepted from the request would be the whole vulnerability.
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    const result = checkSubmit(fake.ctx, req({ score: 1, passed: true, answers: HALF }));

    assert.equal(result.score, 0.5);
    assert.equal(result.passed, false);
  });

  test('a full-marks answer passes and a half-marks answer does not', () => {
    const pass = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });
    assert.equal(checkSubmit(pass.ctx, req()).passed, true);

    const fail = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });
    assert.equal(checkSubmit(fail.ctx, req({ answers: HALF })).passed, false);
  });

  test('an answer in a different key order is still correct', () => {
    // Both sides are canonicalised before comparison. Without that, a client
    // that serialised an object with its keys in another order would watch a
    // correct answer turn wrong on sync, with nothing on screen to explain it.
    const key = {
      ...KEY,
      items: [{ itemId: 'i1', correct: { a: 1, b: 2 }, explainKey: 'e' }],
    };
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub(stubs([[Q.catalogPull, () => [{ body: { 'check.c1.l1': key } }]]])),
    });

    const result = checkSubmit(
      fake.ctx,
      req({ answers: [{ itemId: 'i1', answer: { b: 2, a: 1 } }] }),
    );

    assert.equal(result.passed, true);
  });

  test('an unanswered item is wrong, not skipped', () => {
    // `undefined` must score as incorrect rather than be dropped from the
    // denominator; otherwise skipping the hard question raises the mark.
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    const result = checkSubmit(fake.ctx, req({ answers: [{ itemId: 'i1', answer: 'b' }] }));

    assert.equal(result.score, 0.5);
    // Every item in the key is reported, answered or not, so the student sees
    // which one they left rather than a mark with no account of it.
    assert.equal(result.itemResults.length, 2);
    assert.deepEqual(
      result.itemResults.map((item) => item.correct),
      [true, false],
    );
  });

  test('never returns the correct answer, only whether the student found it', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    const result = checkSubmit(fake.ctx, req({ answers: HALF }));

    // The key is server-side content the client is refused by `v1.catalog.pull`.
    // Handing it back in the grade would defeat that on the second attempt.
    assert.equal(JSON.stringify(result).indexOf('"correct":"b"'), -1);
    for (const item of result.itemResults) {
      assert.equal(typeof item.correct, 'boolean');
      assert.ok(!Object.prototype.hasOwnProperty.call(item, 'answer'));
    }
  });
});

describe('checkSubmit — what it writes', () => {
  test('stores the graded score, not the submitted one', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    checkSubmit(fake.ctx, req({ answers: HALF, playedOffline: true }));

    const params = fake.paramsOf(Q.checkInsert) as unknown[];
    assert.equal(params[1], ME, 'attributed to the caller, never to a user id in the payload');
    assert.equal(params[7], 0.5);
    assert.equal(params[8], false);
    assert.equal(params[10], true, 'playedOffline is recorded as sent');
    assert.equal(params[11], 'k-1');
  });

  test('records mastery evidence as a check, from a distinct source', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    const result = checkSubmit(fake.ctx, req());

    // Two weighted nodes, so two evidence rows and two upserts.
    assert.equal(fake.countOf(Q.masteryEventInsert), 2);
    assert.equal(fake.countOf(Q.masteryUpsert), 2);
    assert.equal(result.masteryChanges.length, 2);

    const event = fake.paramsOf(Q.masteryEventInsert) as unknown[];
    assert.equal(event[3], 'check', 'sourceType — the multi-source cap counts on this');
  });

  test('a pass awards points and completes the lesson', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    const result = checkSubmit(fake.ctx, req());

    assert.deepEqual(result.pointsAwarded, [{ delta: 8, reason: 'check.passed' }]);
    assert.equal(fake.countOf(Q.lessonComplete), 1);
    assert.deepEqual(fake.paramsOf(Q.lessonComplete), [ME, 'course.c1', 'lesson.c1.l1']);
  });

  test('a fail awards nothing and completes nothing', () => {
    // A failed check still moves mastery — a wrong answer is evidence — but it
    // must not unlock the lesson or pay out.
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    const result = checkSubmit(fake.ctx, req({ answers: HALF }));

    assert.deepEqual(result.pointsAwarded, []);
    assert.equal(fake.countOf(Q.lessonComplete), 0);
    assert.equal(fake.countOf(Q.pointsAward), 0);
    assert.ok(result.masteryChanges.length > 0);
  });

  test('the points key is per result, so two passes of one check both pay', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    checkSubmit(fake.ctx, req());

    const award = fake.paramsOf(Q.pointsAward) as unknown[];
    assert.equal(award[3], 'check.passed');
    assert.equal(award[4], 'check');
    assert.equal(award[6], `check.passed:${award[5]}`, 'keyed on the result id it belongs to');
  });

  test('the attempt number comes from the database, not from the client', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub(stubs([[Q.checkAttemptNumber, () => [{ n: 4 }]]])),
    });

    const result = checkSubmit(fake.ctx, req({ attemptNumber: 1 }));

    assert.equal(result.attemptNumber, 4);
    assert.deepEqual(fake.paramsOf(Q.checkAttemptNumber), [ME, 'check.c1.l1']);
  });

  test('defaults to attempt 1 when the counter returns nothing', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub(stubs([[Q.checkAttemptNumber, () => []]])),
    });

    assert.equal(checkSubmit(fake.ctx, req()).attemptNumber, 1);
  });
});

describe('checkSubmit — replays', () => {
  test('a repeated key returns the stored grade and writes nothing', () => {
    // The offline outbox retries. Without this, a student on a bad connection
    // would be graded three times and paid three times for one check.
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.checkByKey, () => [{ score: 0.5, passed: false, attempt_number: 2 }]],
      ]),
    });

    const result = checkSubmit(fake.ctx, req());

    assert.deepEqual(result, {
      score: 0.5,
      passed: false,
      attemptNumber: 2,
      itemResults: [],
      masteryChanges: [],
      pointsAwarded: [],
    });
    assert.equal(fake.countOf(Q.checkInsert), 0);
    assert.equal(fake.countOf(Q.pointsAward), 0);
    assert.equal(fake.countOf(Q.masteryEventInsert), 0);
  });

  test('the replay is detected before the catalog is read', () => {
    // Deliberate ordering: a replay must be answerable even if the catalog
    // version it was graded against has since been superseded. The stub map
    // omits `catalogPull`, so reaching it fails the test by name.
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.checkByKey, () => [{ score: 1, passed: true, attempt_number: 1 }]]]),
    });

    assert.equal(checkSubmit(fake.ctx, req()).passed, true);
  });
});

describe('checkSubmit — refusals', () => {
  test('an unpublished answer key is a not-found, not a zero', () => {
    // Grading against a missing key must never silently score 0. That would
    // record a failure the student did not earn, and mastery is not reversible
    // by re-answering.
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub(stubs([[Q.catalogPull, () => []]])),
    });

    const error = refusal(() => checkSubmit(fake.ctx, req()));

    assert.equal(error.code, 'NOT_FOUND');
    assert.match(error.message, /not published/);
    assert.equal(fake.countOf(Q.checkInsert), 0);
  });

  test('a check id absent from the published part is refused', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub(stubs([[Q.catalogPull, () => [{ body: { other: KEY } }]]])),
    });

    const error = refusal(() => checkSubmit(fake.ctx, req()));

    assert.equal(error.code, 'NOT_FOUND');
    assert.match(error.message, /Unknown check/);
  });

  test('a part with no body at all is refused rather than throwing', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub(stubs([[Q.catalogPull, () => [{}]]])),
    });

    assert.equal(refusal(() => checkSubmit(fake.ctx, req())).code, 'NOT_FOUND');
  });

  test('only the answers part is ever asked for', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    checkSubmit(fake.ctx, req());

    assert.deepEqual(fake.paramsOf(Q.catalogPull), ['v1', ['checks.answers']]);
  });

  test('each required field is refused when missing', () => {
    for (const field of ['idempotencyKey', 'checkId', 'courseId', 'lessonId', 'catalogVersion']) {
      const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });
      const error = refusal(() => checkSubmit(fake.ctx, req({ [field]: undefined })));

      assert.equal(error.code, 'INVALID_ARGUMENT', field);
      assert.match(error.message, new RegExp(field), `the refusal should name ${field}`);
    }
  });

  test('answers must be an array', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });

    assert.equal(refusal(() => checkSubmit(fake.ctx, req({ answers: 'b' }))).code, 'INVALID_ARGUMENT');
  });

  test('a hundred answers is the ceiling', () => {
    const oversized = [];
    for (let i = 0; i < 101; i++) oversized.push({ itemId: `i${i}`, answer: 'x' });

    const fake = fakeCtx(Q, { userId: ME, queries: stub(stubs()) });
    const error = refusal(() => checkSubmit(fake.ctx, req({ answers: oversized })));

    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /at most 100/);
  });

  test('validates before it reads anything', () => {
    // An empty stub map: any statement at all fails by name. A handler that
    // queried first would let a malformed payload cost a round trip, and on
    // this path the first query is keyed on the field being validated.
    const fake = fakeCtx(Q, { userId: ME, queries: stub([]) });

    assert.equal(
      refusal(() => checkSubmit(fake.ctx, req({ idempotencyKey: '' }))).code,
      'INVALID_ARGUMENT',
    );
    assert.equal(fake.calls.length, 0);
  });
});
