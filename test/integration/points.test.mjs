/**
 * The points ledger.
 *
 * Points buy real things — training, certification, a place on a board a whole
 * class sees — so the ledger is the part of the system with an incentive to
 * attack it, and the attacker is a fourteen-year-old with a lot of time and an
 * offline queue that retries.
 *
 * Two properties, and they pull against each other. Every piece of work must be
 * paid for exactly once however many times it is submitted. And replaying the
 * same mission must be allowed — a student re-attempting something they found
 * hard is doing the thing the product is for — while paying so much less than
 * progressing that grinding is a worse strategy than learning.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { call, classroom, connect, disconnect, signIn, sql } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { fixtures } = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'replays.json'), 'utf8'));

const winning = fixtures.find((f) => f.expected.valid && f.expected.outcome === 'success');

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
  if (!catalogVersion || !winning) return (t.skip('no published catalog or fixture'), true);
  return false;
}

function attemptFrom(fixture, over = {}) {
  return {
    missionId: fixture.replay.missionId,
    missionContentVersion: fixture.replay.missionContentVersion,
    catalogVersion,
    gameId: fixture.game,
    replay: fixture.replay,
    claimedOutcome: fixture.replay.claimedOutcome,
    durationMs: 47000,
    clientStartedAt: new Date().toISOString(),
    deviceSeq: 1,
    hintShown: false,
    hintUsed: false,
    playedOffline: false,
    twoPlayer: false,
    coreVersion: '0.1.0',
    ...over,
  };
}

const submit = (token, attempt, key = randomUUID()) =>
  call(token, 'v1.attempt.submit', { idempotencyKey: key, attempt });

async function balance(userId) {
  const { rows } = await sql(
    `SELECT COALESCE(sum(delta), 0)::int AS total FROM lenterra_points_ledger WHERE user_id = $1`,
    [userId],
  );
  return rows[0].total;
}

describe('awarding', () => {
  test('a first win pays, and pays once', async (t) => {
    if (skipUnlessReady(t)) return;

    const fresh = await signIn();
    const before = await balance(fresh.userId);

    const res = await submit(fresh.token, attemptFrom(winning));
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.ok(res.data.pointsAwarded.length > 0, 'a first win paid nothing');

    const after = await balance(fresh.userId);
    assert.ok(after > before, 'the ledger did not move');

    // The same idempotency key again: this is the dropped-response retry that
    // happens constantly in the field.
    const again = await submit(fresh.token, attemptFrom(winning), res.data.attemptId);
    assert.ok(again.ok);
    assert.equal(await balance(fresh.userId), after, 'a retry paid twice');
  });

  test('replaying a mission already beaten pays much less than beating it first', async (t) => {
    if (skipUnlessReady(t)) return;

    const fresh = await signIn();

    const first = await submit(fresh.token, attemptFrom(winning, { deviceSeq: 1 }));
    assert.ok(first.ok, JSON.stringify(first.error));
    const firstTotal = first.data.pointsAwarded.reduce((sum, a) => sum + a.delta, 0);

    const repeat = await submit(fresh.token, attemptFrom(winning, { deviceSeq: 2 }));
    assert.ok(repeat.ok, JSON.stringify(repeat.error));
    const repeatTotal = repeat.data.pointsAwarded.reduce((sum, a) => sum + a.delta, 0);

    // Allowed, because re-attempting something hard is the thing the product is
    // for. Cheap, because otherwise the best strategy is to replay mission one
    // for an afternoon instead of learning anything.
    assert.ok(
      repeatTotal < firstTotal,
      `a replay paid ${repeatTotal} against a first win's ${firstTotal}`,
    );
  });

  test('a losing attempt pays nothing', async (t) => {
    if (skipUnlessReady(t)) return;

    const losing = fixtures.find((f) => f.expected.valid && f.expected.outcome === 'failure');
    if (!losing) return t.skip('no losing fixture');

    const fresh = await signIn();
    const res = await submit(fresh.token, attemptFrom(losing));
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.pointsAwarded.length, 0);
    assert.equal(await balance(fresh.userId), 0);
  });

  test('a rejected attempt pays nothing', async (t) => {
    if (skipUnlessReady(t)) return;

    const tampered = fixtures.find((f) => !f.expected.valid);
    if (!tampered) return t.skip('no tampered fixture');

    const fresh = await signIn();
    const res = await submit(fresh.token, attemptFrom(tampered));
    if (res.ok) assert.equal(res.data.pointsAwarded.length, 0);

    assert.equal(await balance(fresh.userId), 0, 'a rejected replay was paid for');
  });

  test('the ledger is append-only — every award names its source', async (t) => {
    if (skipUnlessReady(t)) return;

    const fresh = await signIn();
    await submit(fresh.token, attemptFrom(winning));

    const { rows } = await sql(
      `SELECT reason, source_type, source_id, idempotency_key
       FROM lenterra_points_ledger WHERE user_id = $1`,
      [fresh.userId],
    );
    assert.ok(rows.length > 0);

    for (const row of rows) {
      // A ledger entry nobody can trace back to an event is a number a teacher
      // cannot explain to a student who asks where their points went.
      assert.ok(row.reason, 'an award with no reason');
      assert.ok(row.source_type, 'an award with no source');
      assert.ok(row.idempotency_key, 'an award that could be made twice');
    }
  });
});

describe('spending', () => {
  test('redeeming more than the balance is refused', async (t) => {
    if (skipUnlessReady(t)) return;

    const fresh = await signIn();
    const res = await call(fresh.token, 'v1.reward.redeem', {
      rewardId: 'anything',
      idempotencyKey: randomUUID(),
    });

    assert.equal(res.ok, false, 'an empty balance bought something');
  });
});

describe('reading', () => {
  test('the history a student sees matches the ledger behind it', async (t) => {
    if (skipUnlessReady(t)) return;

    const fresh = await signIn();
    await submit(fresh.token, attemptFrom(winning));

    const res = await call(fresh.token, 'v1.points.history', { limit: 50 });
    assert.ok(res.ok, JSON.stringify(res.error));

    const shown = (res.data.entries ?? []).reduce((sum, e) => sum + e.delta, 0);
    const actual = await balance(fresh.userId);

    // The profile header, the board, and this list are all derived from the
    // same rows. Two of them disagreeing is what the demo did, and it is what
    // makes a student stop believing any of the numbers.
    assert.equal(res.data.balance ?? shown, actual);
  });

  test('a userId in the request does not select somebody else’s ledger', async (t) => {
    if (skipUnlessReady(t)) return;

    // The handler reads `c.userId` and never the request, which is the correct
    // design and also the kind of thing a later refactor makes configurable
    // "for the teacher view" without noticing what it opened.
    const earner = await signIn();
    await submit(earner.token, attemptFrom(winning));
    const earned = await balance(earner.userId);
    assert.ok(earned > 0, 'the fixture earner should have points to steal');

    const nosy = await signIn();
    const res = await call(nosy.token, 'v1.points.history', {
      userId: earner.userId,
      limit: 10,
    });

    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.balance, 0, 'a request field selected another student’s ledger');
    assert.equal(res.data.entries.length, 0);
  });
});
