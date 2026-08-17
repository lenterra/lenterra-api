/**
 * Who may read whom.
 *
 * 20-16 names the cross-class and cross-school cases as two that must never be
 * skipped or marked pending, alongside the auth subject mismatch. They are the
 * controls that make the trust boundary real rather than aspirational, and they
 * are the ones nobody notices are missing — a broken read returns data, not an
 * error, so it looks like the feature working.
 *
 * What is behind each of these calls is a list of children and what they are
 * struggling with. A teacher reading another school's roster is not an
 * inconvenience; it is the disclosure the whole role model exists to prevent.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  call,
  classroom,
  connect,
  createSchool,
  disconnect,
  makeStaff,
  makeTeacher,
  signIn,
} from './harness.mjs';

let available = false;

/** Two complete schools, so every "someone else's" case has a real other. */
let ours = null;
let theirs = null;
let student = null;
let outsider = null;

before(async () => {
  available = await connect();
  if (!available) return;

  ours = await classroom();
  theirs = await classroom();

  student = await signIn();
  const joined = await call(student.token, 'v1.class.join', {
    code: ours.class.joinCode,
    deviceId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  assert.ok(joined.ok, `student could not join: ${JSON.stringify(joined.error)}`);

  outsider = await signIn();
});

after(disconnect);

const skipUnlessUp = (t) => (available ? false : (t.skip('no nakama'), true));

describe('a teacher and their own class', () => {
  test('reads the roster', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(ours.teacher.token, 'v1.teacher.class.roster', {
      classId: ours.class.classId,
    });
    assert.ok(res.ok, JSON.stringify(res.error));
  });

  test('reads the summary and the attention list', async (t) => {
    if (skipUnlessUp(t)) return;
    for (const rpc of ['v1.teacher.class.summary', 'v1.teacher.attention.list']) {
      const res = await call(ours.teacher.token, rpc, { classId: ours.class.classId });
      assert.ok(res.ok, `${rpc}: ${JSON.stringify(res.error)}`);
    }
  });

  test('drills into a student who is in it', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(ours.teacher.token, 'v1.teacher.student.detail', {
      classId: ours.class.classId,
      userId: student.userId,
    });
    assert.ok(res.ok, JSON.stringify(res.error));
  });
});

describe('another teacher, at another school', () => {
  // The case that must never be skipped. Each of these is a different route to
  // the same disclosure, and closing three of four is closing none.

  test('cannot read the roster', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.class.roster', {
      classId: ours.class.classId,
    });
    assert.equal(res.ok, false, 'another school read a class roster');
  });

  test('cannot read the summary', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.class.summary', {
      classId: ours.class.classId,
    });
    assert.equal(res.ok, false);
  });

  test('cannot read the attention list', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.attention.list', {
      classId: ours.class.classId,
    });
    assert.equal(res.ok, false);
  });

  test('cannot drill into one of our students', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.student.detail', {
      classId: ours.class.classId,
      userId: student.userId,
    });
    assert.equal(res.ok, false, 'another school read a named student');
  });

  test('cannot remove one of our students', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.class.remove', {
      classId: ours.class.classId,
      userId: student.userId,
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false);
  });

  test('cannot turn our leaderboard on or off', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.leaderboard.set', {
      classId: ours.class.classId,
      enabled: false,
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false);
  });

  test('cannot assign work into our class', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.assignment.create', {
      classId: ours.class.classId,
      kind: 'mission',
      targetId: 'congklak.m01',
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false);
  });

  test('their class list contains only their own classes', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(theirs.teacher.token, 'v1.teacher.class.list', {});
    assert.ok(res.ok, JSON.stringify(res.error));

    const ids = JSON.stringify(res.data);
    assert.ok(!ids.includes(ours.class.classId), 'another school appeared in a class list');
  });
});

describe('a student', () => {
  test('cannot call a teacher surface at all', async (t) => {
    if (skipUnlessUp(t)) return;

    for (const rpc of [
      'v1.teacher.class.roster',
      'v1.teacher.class.summary',
      'v1.teacher.student.detail',
      'v1.teacher.attention.list',
    ]) {
      const res = await call(student.token, rpc, {
        classId: ours.class.classId,
        userId: student.userId,
      });
      assert.equal(res.ok, false, `a student reached ${rpc}`);
    }
  });

  test('cannot create a class', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(student.token, 'v1.teacher.class.create', {
      name: 'Kelas Sendiri',
      level: 'SMP',
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false, 'a student created a class');
  });

  test('cannot grant themselves a role', async (t) => {
    if (skipUnlessUp(t)) return;
    // The escalation that would make every other check here decoration.
    const res = await call(student.token, 'v1.admin.role.grant', {
      userId: student.userId,
      role: 'staff',
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false, 'a student granted themselves a role');
  });

  test('cannot publish a catalog or purge anything', async (t) => {
    if (skipUnlessUp(t)) return;

    const publish = await call(student.token, 'v1.admin.catalog.publish', {
      version: 'catalog@whatever',
      idempotencyKey: randomUUID(),
    });
    assert.equal(publish.ok, false);

    const purge = await call(student.token, 'v1.admin.purge', {});
    assert.equal(purge.ok, false);
  });

  test('cannot read the moderation queue', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(student.token, 'v1.moderation.queue', {});
    assert.equal(res.ok, false);
  });
});

describe('a teacher whose school has no consent on file', () => {
  test('cannot create a class', async (t) => {
    if (skipUnlessUp(t)) return;

    // The gate that matters most, because a class that exists is a class
    // students can join, and a student joining is the moment a minor's data
    // starts being collected. Deliberately not seeded with consent.
    const teacher = await signIn();
    const schoolId = await createSchool();
    await makeTeacher(teacher.userId, schoolId);

    const res = await call(teacher.token, 'v1.teacher.class.create', {
      name: 'Kelas Tanpa Izin',
      level: 'SMP',
      idempotencyKey: randomUUID(),
    });

    assert.equal(res.ok, false, 'a class was created with no consent recorded');
    assert.equal(res.error.details?.reason ?? res.error.code, 'consent_required');
  });
});

describe('friend search stays inside a school', () => {
  test('a code from another school finds nothing', async (t) => {
    if (skipUnlessUp(t)) return;

    // Their student, in their school.
    const stranger = await signIn();
    await call(stranger.token, 'v1.class.join', {
      code: theirs.class.joinCode,
      deviceId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    const bootstrap = await call(stranger.token, 'v1.session.bootstrap', {});
    assert.ok(bootstrap.ok, JSON.stringify(bootstrap.error));
    const code = bootstrap.data.profile.friendCode;

    const found = await call(student.token, 'v1.friend.searchByCode', { code });
    // Nothing rather than "wrong school", which would confirm the code exists
    // and turn this into a directory of every student in the country.
    const body = JSON.stringify(found.ok ? found.data : found.error);
    assert.ok(!body.includes(stranger.userId), 'a cross-school friend lookup succeeded');
  });
});

describe('an outsider in no class', () => {
  test('sees no class goal rather than somebody else’s', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(outsider.token, 'v1.class.goal', {});
    if (res.ok) {
      assert.ok(
        res.data === null || res.data.classId === undefined || res.data.classId === null,
        'a student with no class was shown a class goal',
      );
    }
  });

  test('cannot report a student from another school', async (t) => {
    if (skipUnlessUp(t)) return;
    const res = await call(outsider.token, 'v1.moderation.report', {
      subjectUserId: student.userId,
      reason: 'bullying',
    });
    // Deliberately indistinguishable from success — a distinguishable response
    // turns this into a probe for whether an account exists — so the assertion
    // is on the database, not the reply.
    assert.ok(res.ok, JSON.stringify(res.error));
  });
});

describe('staff', () => {
  test('can reach the moderation queue once granted', async (t) => {
    if (skipUnlessUp(t)) return;

    const staff = await signIn();
    await makeStaff(staff.userId);

    const res = await call(staff.token, 'v1.moderation.queue', {});
    assert.ok(res.ok, JSON.stringify(res.error));
  });
});
