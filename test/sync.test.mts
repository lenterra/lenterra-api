/**
 * Draining an offline outbox.
 *
 * `sync.push` is the only channel a student's offline work travels through, and
 * it carries four kinds of item. The integration suite pushes `attempt` and
 * nothing else, so `check`, `lesson` and `event` reached the server by a route
 * no test had ever taken — including the one that grades answers.
 *
 * Two properties are worth more than the rest, because both are about work a
 * child has already done and cannot do again:
 *
 * **One bad item never sinks the batch.** A student on a village connection may
 * be pushing a fortnight of play. If a single malformed item failed the whole
 * request, the client would retry the same batch forever and none of it would
 * ever land. Each item reports its own status; the client clears exactly the
 * applied and duplicate ones.
 *
 * **Order is the order it was lived in.** Mastery is path-dependent — the same
 * attempts applied in a different sequence produce a different number — so the
 * batch is sorted by `deviceSeq` rather than by however the JSON happened to
 * arrive.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Q } from '../modules/src/db/queries.ts';
import { MAX_BATCH_ITEMS, syncPush, type SyncItem } from '../modules/src/rpc/sync.ts';
import { fakeCtx, refusal, stub, type Responder } from './fake-nk.mts';

const ME = '88888888-8888-4888-8888-888888888888';
const NOW = Date.parse('2026-03-01T09:00:00.000Z');

const CHECK_KEY = {
  passMark: 0.7,
  skillWeights: { 'algo.sequencing': 1 },
  items: [{ itemId: 'i1', correct: 'b', explainKey: 'course.c1.i1.confuses-order' }],
};

/** The summary every push ends with, plus the whole check-grading path. */
function stubs(over: [string, Responder][] = []): [string, Responder][] {
  return [
    [Q.streakRead, () => [{ current_days: 3 }]],
    [Q.pointsBalance, () => [{ balance: 120 }]],

    [Q.checkByKey, () => []],
    [Q.catalogPull, () => [{ body: { 'check.c1.l1': CHECK_KEY } }]],
    [Q.checkAttemptNumber, () => [{ n: 1 }]],
    [Q.checkInsert, () => [{ id: 'row' }]],
    [Q.masteryForUser, () => []],
    [Q.masterySourceKeys, () => []],
    [Q.masteryEventInsert, () => [{ id: 'ev' }]],
    [Q.masteryUpsert, () => [{ id: 'up' }]],
    [Q.pointsAward, () => [{ id: 'pt' }]],
    [Q.lessonComplete, () => [{}]],
    [Q.eventInsert, () => [{}]],
    [Q.attemptByKey, () => []],
    ...over,
  ];
}

const item = (over: Partial<SyncItem> & { kind: SyncItem['kind'] }): SyncItem => ({
  idempotencyKey: `k-${over.kind}`,
  deviceSeq: 1,
  payload: {},
  ...over,
});

const checkItem = (over: Partial<SyncItem> = {}): SyncItem =>
  item({
    kind: 'check',
    idempotencyKey: 'k-check',
    payload: {
      checkId: 'check.c1.l1',
      courseId: 'course.c1',
      lessonId: 'lesson.c1.l1',
      catalogVersion: 'v1',
      answers: [{ itemId: 'i1', answer: 'b' }],
    },
    ...over,
  });

/**
 * A well-formed attempt. Every field is required, so a partial object is a
 * rejection rather than a default — deliberately, since a missing `hintUsed`
 * silently read as `false` would inflate the mastery it produces.
 */
const attemptPayload = {
  missionId: 'congklak.m01',
  missionContentVersion: 1,
  catalogVersion: 'v1',
  gameId: 'congklak',
  replay: { moves: [] },
  claimedOutcome: 'success',
  durationMs: 90_000,
  clientStartedAt: '2026-02-28T10:00:00.000Z',
  deviceSeq: 1,
  hintShown: false,
  hintUsed: false,
  playedOffline: true,
  twoPlayer: false,
  coreVersion: '1.0.0',
};

const push = (fake: ReturnType<typeof fakeCtx>, items: SyncItem[]) =>
  syncPush(fake.ctx, { batchId: 'batch-1', items });

describe('sync.push — the check kind', () => {
  test('grades a check pushed from the outbox', () => {
    // The route that had never been taken. `checkSubmit` has its own contract
    // tests; what this proves is that an item of kind `check` reaches it at all.
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [checkItem()]);

    assert.equal(res.results.length, 1);
    assert.equal(res.results[0]?.status, 'applied');
    assert.equal((res.results[0]?.data as { passed: boolean }).passed, true);
    assert.equal(fake.countOf(Q.checkInsert), 1);
  });

  test('the batch key becomes the grade\'s idempotency key', () => {
    // Not a detail. The client dedupes on the key it generated; if the server
    // stored a different one, a retried batch would grade and pay twice.
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    push(fake, [checkItem({ idempotencyKey: 'device-key-42' })]);

    const params = fake.paramsOf(Q.checkInsert) as unknown[];
    assert.equal(params[11], 'device-key-42');
    assert.deepEqual(fake.paramsOf(Q.checkByKey), ['device-key-42']);
  });

  test('a check already graded comes back as duplicate, not applied', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      now: NOW,
      queries: stub(
        stubs([[Q.checkByKey, () => [{ score: 1, passed: true, attempt_number: 1 }]]]),
      ),
    });

    const res = push(fake, [checkItem()]);

    assert.equal(res.results[0]?.status, 'duplicate');
    assert.equal(fake.countOf(Q.checkInsert), 0, 'and it is not graded a second time');
  });

  test('a malformed check payload is rejected without touching the others', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [
      checkItem({ idempotencyKey: 'bad', deviceSeq: 1, payload: { checkId: 'check.c1.l1' } }),
      item({ kind: 'lesson', idempotencyKey: 'good', deviceSeq: 2, payload: { courseId: 'c', lessonId: 'l' } }),
    ]);

    assert.equal(res.results[0]?.status, 'rejected');
    assert.equal(res.results[0]?.error?.code, 'INVALID_ARGUMENT');
    assert.equal(res.results[1]?.status, 'applied');
  });
});

describe('sync.push — the lesson kind', () => {
  test('marks a lesson complete', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [
      item({ kind: 'lesson', payload: { courseId: 'course.c1', lessonId: 'lesson.c1.l1' } }),
    ]);

    assert.equal(res.results[0]?.status, 'applied');
    assert.deepEqual(fake.paramsOf(Q.lessonComplete), [ME, 'course.c1', 'lesson.c1.l1']);
  });

  test('a lesson already completed is a duplicate, not an error', () => {
    // `ON CONFLICT DO NOTHING` affects no rows the second time. Reporting that
    // as a rejection would leave it in the outbox forever.
    const fake = fakeCtx(Q, {
      userId: ME,
      now: NOW,
      queries: stub(stubs([[Q.lessonComplete, () => []]])),
    });

    const res = push(fake, [
      item({ kind: 'lesson', payload: { courseId: 'course.c1', lessonId: 'lesson.c1.l1' } }),
    ]);

    assert.equal(res.results[0]?.status, 'duplicate');
  });

  test('completion is attributed to the caller, never to the payload', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    push(fake, [
      item({
        kind: 'lesson',
        payload: { userId: 'someone-else', courseId: 'course.c1', lessonId: 'lesson.c1.l1' },
      }),
    ]);

    assert.equal((fake.paramsOf(Q.lessonComplete) as unknown[])[0], ME);
  });

  test('a lesson without its ids is refused', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [item({ kind: 'lesson', payload: { courseId: 'course.c1' } })]);

    assert.equal(res.results[0]?.status, 'rejected');
    assert.match(res.results[0]?.error?.message ?? '', /lessonId/);
  });
});

describe('sync.push — the event kind', () => {
  test('records an event with the device sequence and client version', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = syncPush(fake.ctx, {
      batchId: 'b',
      clientVersion: '1.4.0',
      items: [
        item({
          kind: 'event',
          deviceSeq: 7,
          payload: {
            name: 'lesson.opened',
            occurredAt: '2026-02-28T10:00:00.000Z',
            props: { lessonId: 'l1' },
          },
        }),
      ],
    });

    assert.equal(res.results[0]?.status, 'applied');
    const params = fake.paramsOf(Q.eventInsert) as unknown[];
    assert.equal(params[0], ME);
    assert.equal(params[1], 'lesson.opened');
    assert.equal(params[2], JSON.stringify({ lessonId: 'l1' }));
    assert.equal(params[3], '2026-02-28T10:00:00.000Z');
    assert.equal(params[4], 7);
    assert.equal(params[5], '1.4.0');
  });

  test('defaults the client version rather than storing undefined', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    push(fake, [item({ kind: 'event', payload: { name: 'app.opened' } })]);

    assert.equal((fake.paramsOf(Q.eventInsert) as unknown[])[5], 'unknown');
  });

  test('an event with no props stores an empty object, not null', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    push(fake, [item({ kind: 'event', payload: { name: 'app.opened' } })]);

    assert.equal((fake.paramsOf(Q.eventInsert) as unknown[])[2], '{}');
  });

  test('a nameless event is refused', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [item({ kind: 'event', payload: { occurredAt: 'x' } })]);

    assert.equal(res.results[0]?.status, 'rejected');
    assert.equal(fake.countOf(Q.eventInsert), 0);
  });
});

describe('sync.push — the device clock is not trusted', () => {
  /**
   * A phone with a wrong date is ordinary, not exotic — a cheap device that has
   * been flat for a week comes back in 1970. An event stream ordered by that
   * clock is worse than no event stream, because it looks like data.
   */
  const occurredAt = (value: unknown): string => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });
    push(fake, [item({ kind: 'event', payload: { name: 'e', occurredAt: value } })]);
    return (fake.paramsOf(Q.eventInsert) as unknown[])[3] as string;
  };

  test('a plausible timestamp is kept', () => {
    assert.equal(occurredAt('2026-02-28T10:00:00.000Z'), '2026-02-28T10:00:00.000Z');
  });

  test('a future timestamp is pulled back to now', () => {
    assert.equal(occurredAt('2030-01-01T00:00:00.000Z'), '2026-03-01T09:00:00.000Z');
  });

  test('anything older than the offline window is pulled back to now', () => {
    assert.equal(occurredAt('1970-01-01T00:00:00.000Z'), '2026-03-01T09:00:00.000Z');
  });

  test('an unparseable or non-string timestamp falls back to now', () => {
    assert.equal(occurredAt('not a date'), '2026-03-01T09:00:00.000Z');
    assert.equal(occurredAt(1740000000000), '2026-03-01T09:00:00.000Z');
    assert.equal(occurredAt(undefined), '2026-03-01T09:00:00.000Z');
  });

  test('the edge of the window is kept, just past it is not', () => {
    const inside = new Date(NOW - 89 * 86400000).toISOString();
    assert.equal(occurredAt(inside), inside);
    assert.equal(occurredAt(new Date(NOW - 91 * 86400000).toISOString()), '2026-03-01T09:00:00.000Z');
  });
});

describe('sync.push — the attempt kind', () => {
  test('an attempt already recorded comes back as duplicate', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      now: NOW,
      queries: stub(
        stubs([
          [
            Q.attemptByKey,
            () => [
              { id: 'a1', validation_status: 'validated', outcome: 'success', rejection_reason: null },
            ],
          ],
        ]),
      ),
    });

    const res = push(fake, [item({ kind: 'attempt', payload: attemptPayload })]);

    assert.equal(res.results[0]?.status, 'duplicate');
    assert.equal((res.results[0]?.data as { attemptId: string }).attemptId, 'a1');
  });

  test('a rejected attempt keeps its recorded reason', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      now: NOW,
      queries: stub(
        stubs([
          [
            Q.attemptByKey,
            () => [
              {
                id: 'a2',
                validation_status: 'rejected',
                outcome: 'failure',
                rejection_reason: 'malformed_replay',
              },
            ],
          ],
        ]),
      ),
    });

    const data = push(fake, [item({ kind: 'attempt', payload: attemptPayload })]).results[0]?.data as {
      validation: string;
      rejectionReason: string;
    };

    assert.equal(data.validation, 'rejected');
    assert.equal(data.rejectionReason, 'malformed_replay');
  });

  test('a malformed attempt is rejected rather than recorded', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [item({ kind: 'attempt', payload: { claimedOutcome: 'won' } })]);

    assert.equal(res.results[0]?.status, 'rejected');
    assert.equal(res.results[0]?.error?.code, 'INVALID_ARGUMENT');
  });
});

describe('sync.push — the batch itself', () => {
  test('applies in deviceSeq order, not arrival order', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [
      item({ kind: 'lesson', idempotencyKey: 'third', deviceSeq: 30, payload: { courseId: 'c', lessonId: 'l3' } }),
      item({ kind: 'lesson', idempotencyKey: 'first', deviceSeq: 10, payload: { courseId: 'c', lessonId: 'l1' } }),
      item({ kind: 'lesson', idempotencyKey: 'second', deviceSeq: 20, payload: { courseId: 'c', lessonId: 'l2' } }),
    ]);

    assert.deepEqual(
      res.results.map((r) => r.idempotencyKey),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(
      fake.calls.filter((call) => call.sql === Q.lessonComplete).map((call) => call.params[2]),
      ['l1', 'l2', 'l3'],
    );
  });

  test('sorts numerically, so 10 does not precede 2', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [
      item({ kind: 'lesson', idempotencyKey: 'ten', deviceSeq: 10, payload: { courseId: 'c', lessonId: 'l' } }),
      item({ kind: 'lesson', idempotencyKey: 'two', deviceSeq: 2, payload: { courseId: 'c', lessonId: 'l' } }),
    ]);

    assert.deepEqual(
      res.results.map((r) => r.idempotencyKey),
      ['two', 'ten'],
    );
  });

  test('one rejection does not stop the rest — a fortnight of work still lands', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [
      item({ kind: 'lesson', idempotencyKey: 'a', deviceSeq: 1, payload: { courseId: 'c', lessonId: 'l1' } }),
      item({ kind: 'lesson', idempotencyKey: 'b', deviceSeq: 2, payload: {} }),
      checkItem({ idempotencyKey: 'c', deviceSeq: 3 }),
      item({ kind: 'event', idempotencyKey: 'd', deviceSeq: 4, payload: { name: 'e' } }),
    ]);

    assert.deepEqual(
      res.results.map((r) => r.status),
      ['applied', 'rejected', 'applied', 'applied'],
    );
  });

  test('an unknown kind is rejected by name, not applied by accident', () => {
    // The default arm. A future client version inventing a kind must be told
    // no, rather than have its item silently disappear into a success.
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [item({ kind: 'homework' as SyncItem['kind'] })]);

    assert.equal(res.results[0]?.status, 'rejected');
    assert.equal(res.results[0]?.error?.code, 'INVALID_ARGUMENT');
    assert.match(res.results[0]?.error?.message ?? '', /Unknown sync item kind/);
  });

  test('an item with no key still reports a result, labelled by position', () => {
    // Otherwise the client could not match results back to items and would not
    // know which one to drop.
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [item({ kind: 'lesson', idempotencyKey: undefined as unknown as string })]);

    assert.equal(res.results[0]?.status, 'rejected');
    assert.equal(res.results[0]?.idempotencyKey, 'unknown-0');
  });

  test('the batch id is required', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const error = refusal(() => syncPush(fake.ctx, { batchId: '', items: [] }));

    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /batchId/);
  });

  test('an oversized batch is refused whole, and nothing in it is applied', () => {
    // The one case where failing the batch is right: past the ceiling the
    // request is not a drain, it is a way to hold a connection open.
    const items = [];
    for (let i = 0; i <= MAX_BATCH_ITEMS; i++) {
      items.push(item({ kind: 'lesson', idempotencyKey: `k${i}`, deviceSeq: i }));
    }

    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });
    const error = refusal(() => push(fake, items));

    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, new RegExp(`at most ${MAX_BATCH_ITEMS}`));
    assert.equal(fake.calls.length, 0);
  });

  test('an empty batch is a valid heartbeat, not an error', () => {
    // The client pushes on reconnect whether or not it has anything queued.
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, []);

    assert.deepEqual(res.results, []);
    assert.equal(res.summary.points, 120);
  });

  test('the summary is read after the items, so it reflects them', () => {
    const fake = fakeCtx(Q, { userId: ME, now: NOW, queries: stub(stubs()) });

    const res = push(fake, [checkItem()]);

    assert.deepEqual(res.summary, { points: 120, streakDays: 3, rank: null });
    assert.equal(res.serverTime, '2026-03-01T09:00:00.000Z');

    const order = fake.calls.map((call) => call.sql);
    assert.ok(
      order.indexOf(Q.checkInsert) < order.indexOf(Q.pointsBalance),
      'the balance must be read after the awards, or a push always reports the previous total',
    );
  });

  test('a student with no streak row reads as zero days, not as an error', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      now: NOW,
      queries: stub(stubs([[Q.streakRead, () => []], [Q.pointsBalance, () => []]])),
    });

    assert.deepEqual(push(fake, []).summary, { points: 0, streakDays: 0, rank: null });
  });
});
