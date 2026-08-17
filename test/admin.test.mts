/**
 * Housekeeping, and the two doors into it.
 *
 * Retention used to run only when somebody pressed a button on the dashboard.
 * A privacy notice that promises deletion after thirty days cannot be kept by a
 * person remembering, and the failure mode is the quiet one: nothing breaks, it
 * just looks like nothing happened, and the data that should be gone is still
 * there.
 *
 * So there are now two routes to identical work. What has to be true of them is
 * narrow and worth pinning down: they must do the same thing, the scheduled one
 * must not require a session it cannot have, and the dashboard one must still
 * refuse anybody who is not staff.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Q } from '../modules/src/db/queries.ts';
import { adminPurge, adminPurgeScheduled } from '../modules/src/rpc/admin.ts';
import { fakeCtx, refusal, stub, type Responder } from './fake-nk.mts';

const STAFF = '44444444-4444-4444-8444-444444444444';

const staffProfile: Responder = () => [
  {
    user_id: STAFF,
    role: 'staff',
    display_name: 'Admin',
    friend_code: 'ADM123',
    school_id: null,
    locale: 'id',
    auth_strategy: 'staff_code',
    onboarded: true,
    has_wallet: false,
    equipped_avatar_color: null,
    equipped_board_skin: null,
    equipped_title: null,
  },
];

const housekeeping: [string, Responder][] = [
  [Q.purgeJti, () => [{ id: 1 }, { id: 2 }]],
  [Q.idempotencyPurge, () => [{ id: 1 }]],
  [Q.rateLimitPurge, () => []],
  [Q.deletionDue, () => []],
];

describe('adminPurge', () => {
  test('staff may run it, and it reports what it removed', () => {
    const fake = fakeCtx(Q, {
      userId: STAFF,
      queries: stub([[Q.profileByUser, staffProfile], ...housekeeping]),
    });

    const result = adminPurge(fake.ctx) as { authJti: number; trigger: string };

    assert.equal(result.authJti, 2);
    assert.equal(result.trigger, 'dashboard');
  });

  test('a teacher may not run it', () => {
    const fake = fakeCtx(Q, {
      userId: STAFF,
      queries: stub([
        [Q.profileByUser, () => [{ ...staffProfile([])[0], role: 'teacher' }]],
        ...housekeeping,
      ]),
    });

    assert.equal(refusal(() => adminPurge(fake.ctx)).code, 'FORBIDDEN');
    // Deleting accounts must not begin before the refusal.
    assert.equal(fake.countOf(Q.deletionDue), 0);
  });

  test('a student may not run it', () => {
    const fake = fakeCtx(Q, {
      userId: STAFF,
      queries: stub([
        [Q.profileByUser, () => [{ ...staffProfile([])[0], role: 'student' }]],
        ...housekeeping,
      ]),
    });
    assert.equal(refusal(() => adminPurge(fake.ctx)).code, 'FORBIDDEN');
  });
});

describe('adminPurgeScheduled', () => {
  test('runs without a session, because a timer has none', () => {
    // Reached with the runtime HTTP key rather than a token. Requiring a
    // profile here would mean the scheduler needed a staff account, which means
    // a long-lived credential on disk for an account that can read every child
    // in every school.
    const fake = fakeCtx(Q, { userId: '', queries: stub(housekeeping) });

    const result = adminPurgeScheduled(fake.ctx) as { trigger: string };

    assert.equal(result.trigger, 'scheduled');
    assert.equal(fake.countOf(Q.profileByUser), 0, 'it must not need a profile to exist');
  });

  test('does exactly what the dashboard route does', () => {
    // The two must not drift. A deletion carried out by a timer and one
    // carried out by a person are the same deletion.
    const byHand = fakeCtx(Q, {
      userId: STAFF,
      queries: stub([[Q.profileByUser, staffProfile], ...housekeeping]),
    });
    const byTimer = fakeCtx(Q, { userId: '', queries: stub(housekeeping) });

    const a = adminPurge(byHand.ctx) as Record<string, unknown>;
    const b = adminPurgeScheduled(byTimer.ctx) as Record<string, unknown>;

    assert.deepEqual({ ...a, trigger: null }, { ...b, trigger: null });

    // Same statements, in the same order.
    const statements = (fake: typeof byHand) =>
      fake.calls.map((c) => c.sql).filter((sql) => sql !== Q.profileByUser);
    assert.deepEqual(statements(byHand), statements(byTimer));
  });

  test('records which route asked, so an audit can tell them apart', () => {
    const fake = fakeCtx(Q, { userId: '', queries: stub(housekeeping) });
    adminPurgeScheduled(fake.ctx);

    const audited = fake.paramsOf(Q.auditInsert) as unknown[];
    assert.ok(
      JSON.stringify(audited).includes('scheduled'),
      'the audit row must say a timer ran it',
    );
  });

  const withDue = (rows: { id: string; user_id: string }[]): [string, Responder][] => [
    [Q.purgeJti, () => []],
    [Q.idempotencyPurge, () => []],
    [Q.rateLimitPurge, () => []],
    [Q.deletionDue, () => rows],
    [Q.deletionMarkExecuted, () => [{ id: 'marked' }]],
  ];

  test('deletes the accounts that are due, and only those', () => {
    const fake = fakeCtx(Q, {
      userId: '',
      queries: stub(
        withDue([
          { id: 'req-1', user_id: 'user-1' },
          { id: 'req-2', user_id: 'user-2' },
        ]),
      ),
    });

    const result = adminPurgeScheduled(fake.ctx) as { accountsDeleted: number };

    assert.equal(result.accountsDeleted, 2);
    // Which accounts, not how many. A count alone passes just as well when the
    // wrong rows are deleted, and this is the one operation with no undo.
    assert.deepEqual(fake.deleted, ['user-1', 'user-2']);
  });

  test('a run with nothing due deletes nothing', () => {
    const fake = fakeCtx(Q, { userId: '', queries: stub(withDue([])) });

    assert.equal((adminPurgeScheduled(fake.ctx) as { accountsDeleted: number }).accountsDeleted, 0);
    assert.deepEqual(fake.deleted, []);
  });

  test('an account Nakama cannot delete is not counted as deleted', () => {
    // The sweep catches per-account failures so one bad row does not stop the
    // rest of a run. What must not happen is the request being marked executed
    // anyway — that would record a deletion that never happened, against a
    // thirty-day promise, and nothing would ever retry it.
    const fake = fakeCtx(Q, {
      userId: '',
      deleteFails: true,
      queries: stub(withDue([{ id: 'req-1', user_id: 'user-1' }])),
    });

    const result = adminPurgeScheduled(fake.ctx) as { accountsDeleted: number };

    assert.equal(result.accountsDeleted, 0);
    assert.equal(
      fake.countOf(Q.deletionMarkExecuted),
      0,
      'a failed deletion must stay outstanding, so the next run tries again',
    );
  });
});
