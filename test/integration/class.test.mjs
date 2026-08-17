/**
 * Joining a class, and the class-code sign-in chain end to end.
 *
 * The join code is the one identifier a stranger can guess, and what is behind
 * it is a list of children. So the interesting cases here are all refusals: an
 * unknown code, an expired one, a full class, and a code from a class the
 * caller was never given. The one acceptance case is what a teacher does at the
 * start of a lesson thirty-two times in ten minutes, so it also has to be
 * cheap and repeatable.
 *
 * The grant chain is exercised through the same door the verifier uses — an
 * unauthenticated RPC reached with the runtime HTTP key — because that is the
 * only way a student with no account can be given one.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

import {
  call,
  callAnonymous,
  classroom,
  connect,
  disconnect,
  signIn,
  sql,
} from './harness.mjs';

const JOIN_GRANT_SECRET = process.env.JOIN_GRANT_HMAC_SECRET ?? '';

let available = false;
let room = null;

before(async () => {
  available = await connect();
  if (available) room = await classroom();
});

after(disconnect);

const skipUnlessUp = (t) => (available ? false : (t.skip('no nakama'), true));

const join = (token, code, extra = {}) =>
  call(token, 'v1.class.join', {
    code,
    deviceId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...extra,
  });

describe('v1.class.join', () => {
  test('a valid code puts the student in the class and attaches the school', async (t) => {
    if (skipUnlessUp(t)) return;

    const student = await signIn();
    const res = await join(student.token, room.class.joinCode);
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.class.id, room.class.classId);

    const bootstrap = await call(student.token, 'v1.session.bootstrap', {});
    assert.ok(bootstrap.ok);
    assert.equal(bootstrap.data.class.id, room.class.classId);
    assert.ok(bootstrap.data.profile.schoolId, 'joining must attach the school');
  });

  test('an unknown code and an expired code are indistinguishable', async (t) => {
    if (skipUnlessUp(t)) return;

    // Telling them apart would let somebody enumerate which codes ever existed.
    const expired = await classroom();
    await sql(`UPDATE lenterra_class SET join_code_expires_at = now() - interval '1 day' WHERE id = $1`, [
      expired.class.classId,
    ]);

    const unknownRes = await join((await signIn()).token, 'ZZZZZZ');
    const expiredRes = await join((await signIn()).token, expired.class.joinCode);

    assert.equal(unknownRes.ok, false);
    assert.equal(expiredRes.ok, false);
    assert.equal(unknownRes.error.code, expiredRes.error.code);
    assert.equal(unknownRes.error.message, expiredRes.error.message);
  });

  test('a full class refuses the next student', async (t) => {
    if (skipUnlessUp(t)) return;

    const full = await classroom();
    await sql(`UPDATE lenterra_class SET max_members = 0 WHERE id = $1`, [full.class.classId]);

    const res = await join((await signIn()).token, full.class.joinCode);
    assert.equal(res.ok, false);
    assert.equal(res.error.details?.reason, 'class_full');
  });

  test('rejoining is idempotent rather than a second membership', async (t) => {
    if (skipUnlessUp(t)) return;

    const student = await signIn();
    assert.ok((await join(student.token, room.class.joinCode)).ok);
    assert.ok((await join(student.token, room.class.joinCode)).ok);

    const { rows } = await sql(
      `SELECT count(*)::int AS n FROM lenterra_class_member WHERE class_id = $1 AND user_id = $2`,
      [room.class.classId, student.userId],
    );
    assert.equal(rows[0].n, 1, 'rejoining created a second membership row');
  });

  test('a display name that publishes a phone number is refused', async (t) => {
    if (skipUnlessUp(t)) return;

    // A display name is visible to a whole class, so a child who puts their
    // number in it has published it to everyone.
    const res = await join((await signIn()).token, room.class.joinCode, {
      displayName: 'Ani 081234567890',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.details?.reason, 'contains_contact');
  });

  test('repeated wrong codes are rate-limited per device', async (t) => {
    if (skipUnlessUp(t)) return;

    const student = await signIn();
    const deviceId = randomUUID();

    let limited = false;
    for (let i = 0; i < 8; i += 1) {
      const res = await call(student.token, 'v1.class.join', {
        code: `WRONG${i}`,
        deviceId,
        idempotencyKey: randomUUID(),
      });
      if (!res.ok && res.error.code === 'RATE_LIMITED') {
        limited = true;
        break;
      }
    }

    assert.ok(limited, 'a six-character code was guessable without limit');
  });
});

describe('v1.class.grant — the class-code sign-in chain', () => {
  test('a valid code yields a grant naming the class', async (t) => {
    if (skipUnlessUp(t)) return;

    const res = await callAnonymous('v1.class.grant', {
      code: room.class.joinCode,
      deviceId: randomUUID(),
    });

    assert.ok(res.ok, JSON.stringify(res.error));
    assert.ok(res.data.grant.includes('.'), 'a grant is payload.mac');
    assert.ok(res.data.className.length > 0, 'the student confirms the class before committing');
    assert.ok(res.data.schoolName.length > 0);
  });

  test('the grant verifies under the shared secret and names the right class', async (t) => {
    if (skipUnlessUp(t)) return;
    if (!JOIN_GRANT_SECRET) return t.skip('JOIN_GRANT_HMAC_SECRET not set');

    const res = await callAnonymous('v1.class.grant', {
      code: room.class.joinCode,
      deviceId: randomUUID(),
    });
    assert.ok(res.ok);

    const [payload, mac] = res.data.grant.split('.');
    const expected = createHmac('sha256', JOIN_GRANT_SECRET).update(payload).digest('base64url');
    assert.equal(mac, expected, 'goja and node disagree about the grant MAC');

    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.equal(grant.classId, room.class.classId);
    assert.ok(grant.exp > grant.iat);
  });

  test('two students in one class never receive the same seed', async (t) => {
    if (skipUnlessUp(t)) return;
    if (!JOIN_GRANT_SECRET) return t.skip('JOIN_GRANT_HMAC_SECRET not set');

    // The property TRD-AUTH-004 turns on. A seed derived from the code would
    // give every student in a class the same identity, and let any one of them
    // provision any classmate's.
    const seeds = new Set();
    for (let i = 0; i < 5; i += 1) {
      const res = await callAnonymous('v1.class.grant', {
        code: room.class.joinCode,
        deviceId: randomUUID(),
      });
      assert.ok(res.ok);
      const grant = JSON.parse(
        Buffer.from(res.data.grant.split('.')[0], 'base64url').toString('utf8'),
      );
      seeds.add(grant.seed);
    }

    assert.equal(seeds.size, 5);
  });

  test('it writes nothing — a stolen code cannot create accounts', async (t) => {
    if (skipUnlessUp(t)) return;

    const { rows: before } = await sql(
      `SELECT count(*)::int AS n FROM lenterra_class_member WHERE class_id = $1`,
      [room.class.classId],
    );

    for (let i = 0; i < 3; i += 1) {
      await callAnonymous('v1.class.grant', {
        code: room.class.joinCode,
        deviceId: randomUUID(),
      });
    }

    const { rows: after } = await sql(
      `SELECT count(*)::int AS n FROM lenterra_class_member WHERE class_id = $1`,
      [room.class.classId],
    );
    assert.equal(after[0].n, before[0].n, 'the grant handler wrote to the database');
  });

  test('an unknown code yields no grant', async (t) => {
    if (skipUnlessUp(t)) return;

    const res = await callAnonymous('v1.class.grant', {
      code: 'ZZZZZZ',
      deviceId: randomUUID(),
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NOT_FOUND');
  });

  test('a request with no device identifier is refused', async (t) => {
    if (skipUnlessUp(t)) return;

    // Without one there is nothing to rate-limit against, and an unlimited
    // guessing channel against a six-character code is the one failure this
    // handler must not have.
    const res = await callAnonymous('v1.class.grant', { code: room.class.joinCode });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_ARGUMENT');
  });
});

describe('reclaim', () => {
  test('a request transfers nothing until a teacher approves', async (t) => {
    if (skipUnlessUp(t)) return;

    // A returning student on a new device. They see masked names, pick one, and
    // keep playing on the fresh account while the teacher decides.
    const original = await signIn();
    await join(original.token, room.class.joinCode, { displayName: 'Yosef Tanu' });
    await sql(`UPDATE lenterra_account_profile SET auth_strategy = 'class_code' WHERE user_id = $1`, [
      original.userId,
    ]);

    const returning = await signIn();
    const joined = await join(returning.token, room.class.joinCode);
    assert.ok(joined.ok, JSON.stringify(joined.error));

    const candidates = joined.data.existingProfiles ?? [];
    const mine = candidates.find((candidate) => candidate.maskedName.startsWith('Y'));
    assert.ok(mine, 'a returning student was offered no candidate to recognise');
    assert.ok(!JSON.stringify(candidates).includes(original.userId), 'a user id leaked in a candidate');

    const requested = await call(returning.token, 'v1.class.reclaim.request', {
      classId: room.class.classId,
      reclaimToken: mine.reclaimToken,
      idempotencyKey: randomUUID(),
    });
    assert.ok(requested.ok, JSON.stringify(requested.error));
    assert.equal(requested.data.status, 'pending');

    // Nothing moved. The old account still holds its own identity.
    const { rows } = await sql(
      `SELECT wallet_address FROM lenterra_account_profile WHERE user_id = $1`,
      [original.userId],
    );
    assert.equal(rows[0].wallet_address, original.address);
  });

  test('a token from one class cannot be presented against another', async (t) => {
    if (skipUnlessUp(t)) return;

    const other = await classroom();
    const student = await signIn();
    await join(student.token, room.class.joinCode);

    const joined = await join(student.token, room.class.joinCode);
    const candidate = (joined.data.existingProfiles ?? [])[0];
    if (!candidate) return t.skip('no candidate to borrow a token from');

    const res = await call(student.token, 'v1.class.reclaim.request', {
      classId: other.class.classId,
      reclaimToken: candidate.reclaimToken,
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false, 'a reclaim token crossed classes');
  });
});
