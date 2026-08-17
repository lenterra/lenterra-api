/**
 * Draining an offline outbox.
 *
 * A student plays on a bus with no signal for a fortnight and then walks past a
 * school wifi point. Everything they did arrives at once, out of a queue, some
 * of it duplicated by retries and possibly one item malformed by a bug fixed
 * three versions ago.
 *
 * The property that matters is that **one bad item never blocks the rest**.
 * Failing the whole batch would mean a single unparseable attempt holds a
 * fortnight of a child's work hostage forever, which is precisely the failure
 * offline-first exists to avoid — and it would be invisible, because the client
 * would keep retrying and the queue would keep looking busy.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { call, classroom, connect, disconnect, signIn } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { fixtures } = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'replays.json'), 'utf8'));

const playable = fixtures.filter((f) => f.expected.valid).slice(0, 6);

let available = false;
let student = null;
let catalogVersion = null;

before(async () => {
  available = await connect();
  if (!available) return;

  const room = await classroom();
  student = await signIn();
  await call(student.token, 'v1.class.join', {
    code: room.class.joinCode,
    deviceId: randomUUID(),
    idempotencyKey: randomUUID(),
  });

  const bootstrap = await call(student.token, 'v1.session.bootstrap', {});
  catalogVersion = bootstrap.ok ? bootstrap.data.catalog.currentVersion : null;
});

after(disconnect);

function skipUnlessReady(t) {
  if (!available) return (t.skip('no nakama'), true);
  if (!catalogVersion) return (t.skip('no published catalog'), true);
  if (playable.length < 4) return (t.skip('not enough fixtures'), true);
  return false;
}

function attemptItem(fixture, deviceSeq, key = randomUUID()) {
  return {
    kind: 'attempt',
    idempotencyKey: key,
    deviceSeq,
    payload: {
      missionId: fixture.replay.missionId,
      missionContentVersion: fixture.replay.missionContentVersion,
      catalogVersion,
      gameId: fixture.game,
      replay: fixture.replay,
      claimedOutcome: fixture.replay.claimedOutcome,
      durationMs: 41000,
      clientStartedAt: new Date().toISOString(),
      deviceSeq,
      hintShown: false,
      hintUsed: false,
      playedOffline: true,
      twoPlayer: false,
      coreVersion: '0.1.0',
    },
  };
}

const push = (items) =>
  call(student.token, 'v1.sync.push', { batchId: randomUUID(), items });

describe('v1.sync.push', () => {
  test('a clean batch applies every item', async (t) => {
    if (skipUnlessReady(t)) return;

    const items = playable.slice(0, 3).map((f, i) => attemptItem(f, 1000 + i));
    const res = await push(items);

    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.results.length, items.length);
    for (const result of res.data.results) {
      assert.equal(result.status, 'applied', JSON.stringify(result.error));
    }
  });

  test('one bad item does not take the rest with it', async (t) => {
    if (skipUnlessReady(t)) return;

    // The whole point. The malformed item sits in the middle, so a handler that
    // aborted on failure would also drop the good one behind it.
    const items = [
      attemptItem(playable[0], 2000),
      { kind: 'attempt', idempotencyKey: randomUUID(), deviceSeq: 2001, payload: { nonsense: true } },
      attemptItem(playable[1], 2002),
    ];

    const res = await push(items);
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.results.length, 3);

    assert.equal(res.data.results[0].status, 'applied');
    assert.equal(res.data.results[1].status, 'rejected');
    assert.equal(res.data.results[2].status, 'applied', 'a good item behind a bad one was dropped');
  });

  test('a rejected item says why, so the client knows whether to retry', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await push([
      { kind: 'attempt', idempotencyKey: randomUUID(), deviceSeq: 3000, payload: { nonsense: true } },
    ]);

    assert.ok(res.ok);
    const [result] = res.data.results;
    assert.equal(result.status, 'rejected');
    assert.ok(result.error?.code, 'a rejection with no code cannot be classified by the client');
    // A permanent rejection must be distinguishable from a transient one, or
    // the outbox either retries forever or discards work that would have landed.
    assert.notEqual(result.error.code, 'UNAVAILABLE');
  });

  test('a replayed batch reports duplicates rather than applying twice', async (t) => {
    if (skipUnlessReady(t)) return;

    const items = playable.slice(0, 2).map((f, i) => attemptItem(f, 4000 + i));

    const first = await push(items);
    const second = await push(items);

    assert.ok(first.ok && second.ok);
    for (const result of first.data.results) assert.equal(result.status, 'applied');
    for (const result of second.data.results) {
      assert.equal(result.status, 'duplicate', 'a resent batch was applied a second time');
    }
  });

  test('results come back in the order the items were sent', async (t) => {
    if (skipUnlessReady(t)) return;

    // The client matches results to queued items by position, so reordering
    // would clear the wrong entries — and the ones it failed to clear would be
    // resent forever while the ones it cleared wrongly would be lost.
    const items = playable.slice(0, 4).map((f, i) => attemptItem(f, 5000 + i));
    const res = await push(items);

    assert.ok(res.ok);
    assert.deepEqual(
      res.data.results.map((r) => r.idempotencyKey),
      items.map((i) => i.idempotencyKey),
    );
  });

  test('an oversized batch is refused rather than silently truncated', async (t) => {
    if (skipUnlessReady(t)) return;

    // Truncation would report success for items the server never saw, and the
    // client would clear them.
    const items = new Array(80).fill(null).map((_, i) => attemptItem(playable[0], 6000 + i));
    const res = await push(items);

    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_ARGUMENT');
  });

  test('an unknown item kind is rejected without failing the batch', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await push([
      { kind: 'telepathy', idempotencyKey: randomUUID(), deviceSeq: 7000, payload: {} },
      attemptItem(playable[0], 7001),
    ]);

    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.results[0].status, 'rejected');
    assert.equal(res.data.results[1].status, 'applied');
  });
});

describe('v1.sync.pull', () => {
  test('returns the student’s own mastery as bands', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.sync.pull', {});
    assert.ok(res.ok, JSON.stringify(res.error));

    for (const entry of res.data.mastery ?? []) {
      assert.ok(typeof entry.band === 'string');
      // A raw mastery value on the wire would eventually be rendered, and
      // PRD-ADPT-005 exists because a number invites comparison between
      // children in a way a band does not.
      assert.equal(entry.mastery, undefined, 'a raw mastery value reached the client');
    }
  });
});
