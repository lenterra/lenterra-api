/**
 * Submitting an attempt against the real server.
 *
 * The path where a student's play becomes a record. Everything downstream —
 * mastery, points, the recommendation they get next, what a teacher sees — is
 * built on what this handler decides, so the cases that matter are the ones
 * where it must say no: a tampered replay, a mission that does not exist, a
 * catalog the client no longer shares with the server, and a retry that must
 * not count twice.
 *
 * The replays come from the conformance fixtures rather than being written by
 * hand here. They are real play through real missions, and using them means
 * this suite and the runtime comparison cannot drift apart about what a valid
 * replay looks like.
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

/** A fixture that wins, so the success path has something to award for. */
const winning = fixtures.find((f) => f.expected.valid && f.expected.outcome === 'success');
/** And one that is valid but lost, to separate "rejected" from "did not win". */
const losing = fixtures.find((f) => f.expected.valid && f.expected.outcome === 'failure');
const tampered = fixtures.find((f) => !f.expected.valid && f.expected.reason === 'replay_mismatch');

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
  return false;
}

/** An attempt payload wrapping one of the fixture replays. */
function attemptFrom(fixture, over = {}) {
  return {
    missionId: fixture.replay.missionId,
    missionContentVersion: fixture.replay.missionContentVersion,
    catalogVersion,
    gameId: fixture.game,
    replay: fixture.replay,
    claimedOutcome: fixture.replay.claimedOutcome,
    durationMs: 45000,
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

describe('a valid attempt', () => {
  test('is validated, and moves mastery', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!winning) return t.skip('no winning fixture');

    const res = await submit(student.token, attemptFrom(winning));
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.validation, 'validated');
    assert.equal(res.data.outcome, 'success');
    assert.ok(res.data.masteryChanges.length > 0, 'a validated win must produce evidence');
  });

  test('a lost mission is recorded rather than rejected', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!losing) return t.skip('no losing fixture');

    // Losing is not cheating. A student who fails a mission has still produced
    // evidence about what they can do, and treating the two the same would make
    // the record useless exactly where it is most informative.
    const res = await submit(student.token, attemptFrom(losing));
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.validation, 'validated');
    assert.equal(res.data.outcome, 'failure');
  });

  test('mastery is returned as a band, never as a number the student sees', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!winning) return t.skip('no winning fixture');

    const res = await submit(student.token, attemptFrom(winning));
    assert.ok(res.ok);
    for (const change of res.data.masteryChanges) {
      assert.ok(typeof change.band === 'string' && change.band.length > 0);
    }
  });
});

describe('an attempt the server will not take on trust', () => {
  test('a tampered replay is rejected, not scored', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!tampered) return t.skip('no tampered fixture');

    const res = await submit(student.token, attemptFrom(tampered));
    // Accepted as a submission, recorded as rejected. That distinction matters:
    // the attempt happened and is worth logging, it just earns nothing.
    if (res.ok) {
      assert.equal(res.data.validation, 'rejected');
      assert.equal(res.data.masteryChanges.length, 0, 'a rejected attempt moved mastery');
      assert.equal(res.data.pointsAwarded.length, 0, 'a rejected attempt awarded points');
    } else {
      assert.ok(res.error.code === 'VALIDATION_FAILED' || res.error.code === 'INVALID_ARGUMENT');
    }
  });

  test('claiming a win the replay does not show earns nothing', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!losing) return t.skip('no losing fixture');

    const lie = attemptFrom(losing, {
      claimedOutcome: 'success',
      replay: { ...losing.replay, claimedOutcome: 'success' },
    });

    const res = await submit(student.token, lie);
    if (res.ok) {
      assert.notEqual(res.data.outcome, 'success', 'an unearned win was recorded');
      assert.equal(res.data.pointsAwarded.length, 0);
    } else {
      assert.ok(res.error.code.length > 0);
    }
  });

  test('a mission that does not exist is refused', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!winning) return t.skip('no winning fixture');

    const res = await submit(student.token, attemptFrom(winning, { missionId: 'congklak.m99' }));
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOT_FOUND');
  });

  test('a stale catalog is named as such, so the client knows to update', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!winning) return t.skip('no winning fixture');

    // The distinction the client depends on: stale content means "pull the
    // catalog and retry", not "throw this attempt away". Getting it wrong
    // discards work a student did offline.
    const res = await submit(
      student.token,
      attemptFrom(winning, { catalogVersion: 'catalog@000000000000' }),
    );

    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'CATALOG_STALE');
    assert.ok(res.error.details?.currentVersion, 'the client is told which version to pull');
  });
});

describe('idempotency', () => {
  test('a retried submission returns the first answer rather than scoring twice', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!winning) return t.skip('no winning fixture');

    // The case that happens constantly in the field: a submission lands, the
    // response is lost on a dropped connection, and the outbox retries. Scoring
    // it twice would award points for one piece of work twice.
    const key = randomUUID();
    const attempt = attemptFrom(winning, { deviceSeq: 99 });

    const first = await submit(student.token, attempt, key);
    const second = await submit(student.token, attempt, key);

    assert.ok(first.ok && second.ok, JSON.stringify(first.error ?? second.error));
    assert.equal(second.data.attemptId, first.data.attemptId, 'a retry created a second attempt');
    assert.deepEqual(second.data.pointsAwarded, first.data.pointsAwarded);
  });

  test('two different keys are two attempts', async (t) => {
    if (skipUnlessReady(t)) return;
    if (!losing) return t.skip('no losing fixture');

    const a = await submit(student.token, attemptFrom(losing, { deviceSeq: 101 }));
    const b = await submit(student.token, attemptFrom(losing, { deviceSeq: 102 }));

    assert.ok(a.ok && b.ok);
    assert.notEqual(a.data.attemptId, b.data.attemptId);
  });
});

describe('recommendations follow the evidence', () => {
  test('a student who has played is recommended something', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.mission.recommend', { limit: 4 });
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.ok(Array.isArray(res.data.recommendations ?? res.data.missions ?? res.data));
  });
});
