/**
 * The staff-invite handlers: the only door into the dashboard.
 *
 * `test/schema.test.mjs` proves the table refuses a duplicate code and a
 * school-less teacher, and `test/grant.test.mts` proves a class grant cannot be
 * presented as a staff grant. Neither touches the handlers, and the handlers
 * are where the rules actually live — who may issue what, to which school,
 * against whom, and what a spent code does the second time.
 *
 * An account created through here can read every child in a school. The tests
 * below are ordered by what that account could do if a check were missing:
 * granting yourself a role you do not hold, reaching another school, and
 * reusing a code somebody else already spent.
 *
 * These run under Node against a fake `nk` (test/fake-nk.mts). They prove the
 * decisions, not the SQL — see that file for where the line sits.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Q } from '../modules/src/db/queries.ts';
import {
  adminStaffInvite,
  adminStaffInviteList,
  adminStaffInviteRevoke,
  staffGrant,
  staffJoin,
} from '../modules/src/rpc/staff.ts';
import { fakeCtx, refusal, stub, type Responder } from './fake-nk.mts';

const SECRET = 'a-join-grant-secret-of-at-least-32-characters';
const ENV = { JOIN_GRANT_HMAC_SECRET: SECRET };

const SCHOOL_A = '11111111-1111-4111-8111-111111111111';
const SCHOOL_B = '22222222-2222-4222-8222-222222222222';
const INVITE_ID = '33333333-3333-4333-8333-333333333333';
const ISSUER = '44444444-4444-4444-8444-444444444444';
const CALLER = '55555555-5555-4555-8555-555555555555';
const OTHER_TEACHER = '66666666-6666-4666-8666-666666666666';

/** A profile row as `Q.profileByUser` returns it. */
function profileRow(over: Record<string, unknown> = {}) {
  return {
    user_id: ISSUER,
    role: 'school_admin',
    display_name: 'Bu Sari',
    friend_code: 'ABC123',
    school_id: SCHOOL_A,
    locale: 'id',
    auth_strategy: 'staff_code',
    onboarded: true,
    has_wallet: false,
    equipped_avatar_color: null,
    equipped_board_skin: null,
    equipped_title: null,
    ...over,
  };
}

const asProfile = (over: Record<string, unknown> = {}): Responder => () => [profileRow(over)];

// ---------------------------------------------------------------------------
// Issuing — nobody may create authority they do not already hold
// ---------------------------------------------------------------------------

describe('adminStaffInvite', () => {
  const validReq = { role: 'teacher', idempotencyKey: 'k1' };

  test('a school administrator issues a teacher invite for their own school', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteExists, () => []],
        [
          Q.staffInviteCreate,
          () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
        ],
      ]),
    });

    const result = adminStaffInvite(fake.ctx, validReq) as {
      code: string;
      role: string;
      schoolId: string | null;
    };

    assert.equal(result.role, 'teacher');
    assert.equal(result.schoolId, SCHOOL_A, 'the issuer’s own school, not one they named');
    assert.equal(result.code.length, 10);
  });

  test('a school administrator cannot grant the staff role', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([[Q.profileByUser, asProfile()]]),
    });

    const err = refusal(() => adminStaffInvite(fake.ctx, { role: 'staff', idempotencyKey: 'k' }));

    assert.equal(err.code, 'FORBIDDEN');
    assert.equal(
      fake.countOf(Q.staffInviteCreate),
      0,
      'the refusal must happen before anything is written',
    );
  });

  test('a school administrator cannot invite into another school', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([[Q.profileByUser, asProfile()]]),
    });

    const err = refusal(() =>
      adminStaffInvite(fake.ctx, { role: 'teacher', schoolId: SCHOOL_B, idempotencyKey: 'k' }),
    );

    // Refused rather than silently rewritten to their own school. An issuer who
    // believes they invited somebody to school B, and did not, will hand over a
    // code that grants access somewhere they did not intend.
    assert.equal(err.code, 'FORBIDDEN');
    assert.equal(fake.countOf(Q.staffInviteCreate), 0);
  });

  test('naming your own school explicitly is allowed', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteExists, () => []],
        [
          Q.staffInviteCreate,
          () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
        ],
      ]),
    });

    assert.doesNotThrow(() =>
      adminStaffInvite(fake.ctx, { role: 'teacher', schoolId: SCHOOL_A, idempotencyKey: 'k' }),
    );
  });

  test('platform staff may issue for any school, and may grant staff', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile({ role: 'staff', school_id: null })],
        [Q.staffInviteExists, () => []],
        [
          Q.staffInviteCreate,
          () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
        ],
      ]),
    });

    const result = adminStaffInvite(fake.ctx, {
      role: 'school_admin',
      schoolId: SCHOOL_B,
      idempotencyKey: 'k',
    }) as { schoolId: string | null };

    assert.equal(result.schoolId, SCHOOL_B);
  });

  test('a teacher cannot issue invites at all', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([[Q.profileByUser, asProfile({ role: 'teacher' })]]),
    });

    assert.equal(refusal(() => adminStaffInvite(fake.ctx, validReq)).code, 'FORBIDDEN');
  });

  test('a student cannot issue invites', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([[Q.profileByUser, asProfile({ role: 'student', school_id: SCHOOL_A })]]),
    });

    assert.equal(refusal(() => adminStaffInvite(fake.ctx, validReq)).code, 'FORBIDDEN');
  });

  test('the role must be one an invite can confer', () => {
    for (const role of ['student', 'superuser', '']) {
      const fake = fakeCtx(Q, {
        userId: ISSUER,
        queries: stub([[Q.profileByUser, asProfile()]]),
      });
      const err = refusal(() => adminStaffInvite(fake.ctx, { role, idempotencyKey: 'k' }));
      assert.equal(err.code, 'INVALID_ARGUMENT', `role ${JSON.stringify(role)} must be refused`);
    }
  });

  test('a school administrator with no school cannot invite anybody', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([[Q.profileByUser, asProfile({ school_id: null })]]),
    });

    assert.equal(refusal(() => adminStaffInvite(fake.ctx, validReq)).code, 'INVALID_ARGUMENT');
  });

  test('expiry is bounded, and defaults to a working week', () => {
    const create = (hours?: number) => {
      const fake = fakeCtx(Q, {
        userId: ISSUER,
        queries: stub([
          [Q.profileByUser, asProfile()],
          [Q.staffInviteExists, () => []],
          [
            Q.staffInviteCreate,
            () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
          ],
        ]),
      });
      adminStaffInvite(fake.ctx, { role: 'teacher', idempotencyKey: 'k', expiresInHours: hours });
      return fake.paramsOf(Q.staffInviteCreate) as unknown[];
    };

    assert.equal(create()[6], '168', 'the default is one week');
    assert.equal(create(24)[6], '24');

    for (const hours of [0, -1, 721]) {
      const fake = fakeCtx(Q, {
        userId: ISSUER,
        queries: stub([[Q.profileByUser, asProfile()]]),
      });
      assert.equal(
        refusal(() =>
          adminStaffInvite(fake.ctx, {
            role: 'teacher',
            idempotencyKey: 'k',
            expiresInHours: hours,
          }),
        ).code,
        'INVALID_ARGUMENT',
        `${hours} hours must be refused`,
      );
    }
  });

  test('an issued code avoids one already in use', () => {
    let asked = 0;
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        // The first candidate collides; the second does not.
        [Q.staffInviteExists, () => (asked++ === 0 ? [{ id: 'taken' }] : [])],
        [
          Q.staffInviteCreate,
          () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
        ],
      ]),
    });

    adminStaffInvite(fake.ctx, { role: 'teacher', idempotencyKey: 'k' });
    assert.equal(asked, 2, 'a colliding code must be discarded rather than issued');
  });

  test('issuing is written to the audit log', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteExists, () => []],
        [
          Q.staffInviteCreate,
          () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
        ],
      ]),
    });

    adminStaffInvite(fake.ctx, { role: 'teacher', idempotencyKey: 'k' });
    assert.equal(fake.countOf(Q.auditInsert), 1, 'granting authority must leave a record');
  });
});

// ---------------------------------------------------------------------------
// Transfers — re-linking a teacher who lost their account
// ---------------------------------------------------------------------------

describe('adminStaffInvite, transferring an account', () => {
  const transferReq = {
    role: 'teacher',
    transfersFrom: OTHER_TEACHER,
    idempotencyKey: 'k',
  };

  const forTransfer = (targetOver: Record<string, unknown>) => {
    let call = 0;
    return fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        // First read is the issuer's own profile, second is the transfer target.
        [Q.profileByUser, () => [profileRow(call++ === 0 ? {} : targetOver)]],
        [Q.staffInviteExists, () => []],
        [
          Q.staffInviteCreate,
          () => [{ id: INVITE_ID, code: 'ABCDEFGHJK', expires_at: '2026-03-08T09:00:00Z' }],
        ],
      ]),
    });
  };

  test('a teacher in the same school may be transferred', () => {
    const fake = forTransfer({ role: 'teacher', school_id: SCHOOL_A });
    assert.doesNotThrow(() => adminStaffInvite(fake.ctx, transferReq));
    assert.equal((fake.paramsOf(Q.staffInviteCreate) as unknown[])[5], OTHER_TEACHER);
  });

  test('a teacher in another school may not', () => {
    const fake = forTransfer({ role: 'teacher', school_id: SCHOOL_B });
    assert.equal(refusal(() => adminStaffInvite(fake.ctx, transferReq)).code, 'FORBIDDEN');
    assert.equal(fake.countOf(Q.staffInviteCreate), 0);
  });

  test('a student account cannot be transferred from', () => {
    // Otherwise an administrator could name any child and hand somebody a code
    // that adopts that child's account.
    const fake = forTransfer({ role: 'student', school_id: SCHOOL_A });
    assert.equal(refusal(() => adminStaffInvite(fake.ctx, transferReq)).code, 'CONFLICT');
  });

  test('an account that does not exist is refused', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [
          Q.profileByUser,
          (params) => (params[0] === ISSUER ? [profileRow()] : []),
        ],
      ]),
    });
    assert.equal(refusal(() => adminStaffInvite(fake.ctx, transferReq)).code, 'NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// v1.staff.grant — reachable with no account
// ---------------------------------------------------------------------------

describe('staffGrant', () => {
  const inviteRow = {
    id: INVITE_ID,
    role: 'teacher',
    school_id: SCHOOL_A,
    school_name: 'SMP Negeri 1',
  };

  test('a valid code mints a grant and names what it is for', () => {
    const fake = fakeCtx(Q, {
      env: ENV,
      queries: stub([[Q.staffInviteByCode, () => [inviteRow]]]),
    });

    const result = staffGrant(fake.ctx, { code: 'abcdefghjk', deviceId: 'device-1' });

    assert.ok(result.grant.length > 0);
    assert.equal(result.role, 'teacher');
    assert.equal(result.schoolName, 'SMP Negeri 1');
    assert.equal(
      (fake.paramsOf(Q.staffInviteByCode) as unknown[])[0],
      'ABCDEFGHJK',
      'codes are read down a phone line, so case cannot matter',
    );
  });

  test('minting writes nothing', () => {
    const fake = fakeCtx(Q, {
      env: ENV,
      queries: stub([[Q.staffInviteByCode, () => [inviteRow]]]),
    });

    staffGrant(fake.ctx, { code: 'ABCDEFGHJK', deviceId: 'device-1' });

    const writes = fake.calls.filter(
      (call) => call.kind === 'exec' && call.sql !== Q.rateLimitBumpExec,
    );
    assert.deepEqual(writes, [], 'a grant must not spend or alter the invite');
  });

  test('an unknown code is refused, and counted against the join budget', () => {
    const fake = fakeCtx(Q, {
      env: ENV,
      queries: stub([[Q.staffInviteByCode, () => []]]),
    });

    assert.equal(
      refusal(() => staffGrant(fake.ctx, { code: 'ZZZZZZZZZZ', deviceId: 'device-1' })).code,
      'NOT_FOUND',
    );
    // Guessing here must not be free, or the failure budget on the redemption
    // side can be bypassed by probing this handler instead.
    assert.equal(fake.countOf(Q.rateLimitBumpExec), 1);
  });

  test('a spent, revoked, or expired code is indistinguishable from an unknown one', () => {
    // `Q.staffInviteByCode` filters those out in SQL, so the handler sees an
    // empty result for all four cases and cannot leak which it was.
    const messages = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const fake = fakeCtx(Q, { env: ENV, queries: stub([[Q.staffInviteByCode, () => []]]) });
      messages.add(refusal(() => staffGrant(fake.ctx, { code: 'AAAAAAAAAA', deviceId: 'd' })).message);
    }
    assert.equal(messages.size, 1, 'one answer for every kind of invalid code');
  });

  test('a missing signing secret is unavailable, not a server error', () => {
    const fake = fakeCtx(Q, { env: {}, queries: stub([[Q.staffInviteByCode, () => [inviteRow]]]) });

    const err = refusal(() => staffGrant(fake.ctx, { code: 'ABCDEFGHJK', deviceId: 'd' }));
    assert.equal(err.code, 'UNAVAILABLE');
    assert.equal(
      fake.countOf(Q.staffInviteByCode),
      0,
      'a misconfigured server must not consult the code at all',
    );
  });

  test('the rate limit is checked before the code is', () => {
    const fake = fakeCtx(Q, {
      env: ENV,
      queries: stub([
        [Q.rateLimitBump, () => [{ count: 999 }]],
        [Q.staffInviteByCode, () => [inviteRow]],
      ]),
    });

    assert.equal(
      refusal(() => staffGrant(fake.ctx, { code: 'ABCDEFGHJK', deviceId: 'd' })).code,
      'RATE_LIMITED',
    );
    assert.equal(fake.countOf(Q.staffInviteByCode), 0);
  });

  test('an exhausted join budget stops grants too', () => {
    // The two handlers share one budget on purpose: three failed redemptions
    // must not be resettable by switching to the grant endpoint.
    const fake = fakeCtx(Q, {
      env: ENV,
      queries: stub([
        [Q.rateLimitRead, () => [{ count: 3 }]],
        [Q.staffInviteByCode, () => [inviteRow]],
      ]),
    });

    assert.equal(
      refusal(() => staffGrant(fake.ctx, { code: 'ABCDEFGHJK', deviceId: 'd' })).code,
      'RATE_LIMITED',
    );
    assert.equal(fake.countOf(Q.staffInviteByCode), 0);
  });

  test('a caller with neither a device id nor an account is refused', () => {
    const fake = fakeCtx(Q, { env: ENV, userId: '', queries: stub([]) });
    assert.equal(refusal(() => staffGrant(fake.ctx, { code: 'ABCDEFGHJK' })).code, 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------
// v1.staff.join — redemption
// ---------------------------------------------------------------------------

describe('staffJoin', () => {
  const redeemed = {
    id: INVITE_ID,
    role: 'teacher',
    school_id: SCHOOL_A,
    transfers_from: null,
  };

  test('a valid code confers the role from the database, not from the request', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [redeemed]],
        [Q.profileGrantStaff, () => [{ role: 'teacher', school_id: SCHOOL_A }]],
        [Q.schoolById, () => [{ name: 'SMP Negeri 1' }]],
      ]),
    });

    const result = staffJoin(fake.ctx, {
      code: 'ABCDEFGHJK',
      idempotencyKey: 'k',
      // A client naming a role it would like. It must be ignored entirely.
      ...({ role: 'staff' } as object),
    });

    assert.equal(result.role, 'teacher');
    assert.equal(result.schoolId, SCHOOL_A);
    assert.equal((fake.paramsOf(Q.profileGrantStaff) as unknown[])[1], 'teacher');
  });

  test('redemption is one statement, so a race has exactly one winner', () => {
    // The predicate lives in SQL rather than in a read-then-write here. This
    // asserts the shape the atomicity depends on; that the predicate actually
    // holds under concurrency is proved in test/schema.test.mjs against real
    // Postgres.
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [redeemed]],
        [Q.profileGrantStaff, () => [{ role: 'teacher', school_id: SCHOOL_A }]],
        [Q.schoolById, () => [{ name: 'SMP' }]],
      ]),
    });

    staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' });

    assert.equal(fake.countOf(Q.staffInviteById), 0, 'no read-then-write');
    assert.equal(fake.countOf(Q.staffInviteByCode), 0);
    assert.equal(fake.countOf(Q.staffInviteRedeem), 1);
  });

  test('a second caller on the same code gets nothing', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([[Q.staffInviteRedeem, () => []]]),
    });

    assert.equal(
      refusal(() => staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' })).code,
      'NOT_FOUND',
    );
    assert.equal(fake.countOf(Q.profileGrantStaff), 0, 'no role is written for a spent code');
    assert.equal(fake.countOf(Q.rateLimitBumpExec), 1, 'and the attempt is counted');
  });

  test('an exhausted failure budget refuses before the code is read', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.rateLimitRead, () => [{ count: 3 }]],
        [Q.staffInviteRedeem, () => [redeemed]],
      ]),
    });

    assert.equal(
      refusal(() => staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' })).code,
      'RATE_LIMITED',
    );
    assert.equal(fake.countOf(Q.staffInviteRedeem), 0);
  });

  test('a redeemed invite with no profile does not silently succeed', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [redeemed]],
        [Q.profileGrantStaff, () => []],
      ]),
    });

    assert.equal(
      refusal(() => staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' })).code,
      'NOT_FOUND',
    );
  });

  test('joining is audited', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [redeemed]],
        [Q.profileGrantStaff, () => [{ role: 'teacher', school_id: SCHOOL_A }]],
        [Q.schoolById, () => [{ name: 'SMP' }]],
      ]),
    });

    staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' });
    assert.equal(fake.countOf(Q.auditInsert), 1);
  });

  test('a transfer moves the classes and demotes the old account', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [{ ...redeemed, transfers_from: OTHER_TEACHER }]],
        [Q.profileGrantStaff, () => [{ role: 'teacher', school_id: SCHOOL_A }]],
        [Q.classTransferOwner, () => [{ id: 'c1' }, { id: 'c2' }]],
        [Q.setRole, () => []],
        [Q.schoolById, () => [{ name: 'SMP' }]],
      ]),
    });

    const result = staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' });

    assert.equal(result.classesTransferred, 2);
    // Demoted, not deleted: the old account keeps its own rows and simply stops
    // teaching. Two accounts must not be able to teach one class.
    assert.deepEqual(fake.paramsOf(Q.setRole), [OTHER_TEACHER, 'student']);
    assert.equal(fake.countOf(Q.auditInsert), 2, 'the transfer is audited separately');
  });

  test('a transfer of nothing is not an error', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [{ ...redeemed, transfers_from: OTHER_TEACHER }]],
        [Q.profileGrantStaff, () => [{ role: 'teacher', school_id: SCHOOL_A }]],
        [Q.classTransferOwner, () => []],
        [Q.setRole, () => []],
        [Q.schoolById, () => [{ name: 'SMP' }]],
      ]),
    });

    assert.equal(staffJoin(fake.ctx, { code: 'A', idempotencyKey: 'k' }).classesTransferred, 0);
  });

  test('a school-less staff invite reports no school rather than looking one up', () => {
    const fake = fakeCtx(Q, {
      userId: CALLER,
      queries: stub([
        [Q.staffInviteRedeem, () => [{ ...redeemed, role: 'staff', school_id: null }]],
        [Q.profileGrantStaff, () => [{ role: 'staff', school_id: null }]],
      ]),
    });

    const result = staffJoin(fake.ctx, { code: 'ABCDEFGHJK', idempotencyKey: 'k' });
    assert.equal(result.schoolName, null);
    assert.equal(fake.countOf(Q.schoolById), 0);
  });
});

// ---------------------------------------------------------------------------
// Listing and revoking
// ---------------------------------------------------------------------------

describe('adminStaffInviteList', () => {
  const row = {
    id: INVITE_ID,
    code: 'ABCDEFGHJK',
    role: 'teacher',
    school_id: SCHOOL_A,
    transfers_from: null,
    created_at: '2026-03-01T09:00:00Z',
    expires_at: '2026-03-08T09:00:00Z',
    redeemed_at: null,
    revoked_at: null,
    redeemed_by_name: null,
  };

  test('a school administrator sees only their own school, whatever they ask for', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteList, () => [row]],
      ]),
    });

    adminStaffInviteList(fake.ctx, { schoolId: SCHOOL_B });
    assert.deepEqual(fake.paramsOf(Q.staffInviteList), [SCHOOL_A]);
  });

  test('platform staff asking for nothing see every school', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile({ role: 'staff', school_id: null })],
        [Q.staffInviteList, () => [row]],
      ]),
    });

    adminStaffInviteList(fake.ctx, {});
    assert.deepEqual(fake.paramsOf(Q.staffInviteList), [null]);
  });

  test('status is derived, and expiry is judged against the server clock', () => {
    const statusOf = (over: Record<string, unknown>, now: string) => {
      const fake = fakeCtx(Q, {
        userId: ISSUER,
        now: Date.parse(now),
        queries: stub([
          [Q.profileByUser, asProfile()],
          [Q.staffInviteList, () => [{ ...row, ...over }]],
        ]),
      });
      return (adminStaffInviteList(fake.ctx, {}) as { invites: { status: string }[] }).invites[0]
        .status;
    };

    assert.equal(statusOf({}, '2026-03-02T09:00:00Z'), 'open');
    assert.equal(statusOf({}, '2026-03-09T09:00:00Z'), 'expired');
    assert.equal(statusOf({ redeemed_at: '2026-03-02T09:00:00Z' }, '2026-03-02T10:00:00Z'), 'redeemed');
    assert.equal(statusOf({ revoked_at: '2026-03-02T09:00:00Z' }, '2026-03-02T10:00:00Z'), 'revoked');
    // A code that was spent and then expired reads as spent: what happened to
    // it is more useful than what would have happened had it not been.
    assert.equal(
      statusOf({ redeemed_at: '2026-03-02T09:00:00Z' }, '2026-03-09T09:00:00Z'),
      'redeemed',
    );
  });

  test('a teacher cannot list invites', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([[Q.profileByUser, asProfile({ role: 'teacher' })]]),
    });
    assert.equal(refusal(() => adminStaffInviteList(fake.ctx, {})).code, 'FORBIDDEN');
  });
});

describe('adminStaffInviteRevoke', () => {
  test('an open invite is revoked and audited', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteById, () => [{ school_id: SCHOOL_A }]],
        [Q.staffInviteRevoke, () => [{ id: INVITE_ID }]],
      ]),
    });

    assert.equal(
      (adminStaffInviteRevoke(fake.ctx, { inviteId: INVITE_ID, idempotencyKey: 'k' }) as {
        revoked: boolean;
      }).revoked,
      true,
    );
    assert.equal(fake.countOf(Q.auditInsert), 1);
  });

  test('another school’s invite cannot be revoked by guessing its id', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteById, () => [{ school_id: SCHOOL_B }]],
      ]),
    });

    assert.equal(
      refusal(() => adminStaffInviteRevoke(fake.ctx, { inviteId: INVITE_ID, idempotencyKey: 'k' }))
        .code,
      'FORBIDDEN',
    );
    assert.equal(fake.countOf(Q.staffInviteRevoke), 0);
  });

  test('platform staff may revoke any invite', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile({ role: 'staff', school_id: null })],
        [Q.staffInviteById, () => [{ school_id: SCHOOL_B }]],
        [Q.staffInviteRevoke, () => [{ id: INVITE_ID }]],
      ]),
    });

    assert.doesNotThrow(() =>
      adminStaffInviteRevoke(fake.ctx, { inviteId: INVITE_ID, idempotencyKey: 'k' }),
    );
  });

  test('an invite that does not exist is not found', () => {
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteById, () => []],
      ]),
    });

    assert.equal(
      refusal(() => adminStaffInviteRevoke(fake.ctx, { inviteId: INVITE_ID, idempotencyKey: 'k' }))
        .code,
      'NOT_FOUND',
    );
  });

  test('revoking a spent invite is a conflict, not a silent success', () => {
    // An administrator revoking a code because they believe it is still live
    // needs to learn that somebody already used it.
    const fake = fakeCtx(Q, {
      userId: ISSUER,
      queries: stub([
        [Q.profileByUser, asProfile()],
        [Q.staffInviteById, () => [{ school_id: SCHOOL_A }]],
        [Q.staffInviteRevoke, () => []],
      ]),
    });

    assert.equal(
      refusal(() => adminStaffInviteRevoke(fake.ctx, { inviteId: INVITE_ID, idempotencyKey: 'k' }))
        .code,
      'CONFLICT',
    );
  });
});
