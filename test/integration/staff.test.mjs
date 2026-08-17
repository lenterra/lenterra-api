/**
 * The staff-invite chain, end to end against a real Nakama.
 *
 * `v1.staff.grant` was the only registered RPC in the system exercised by
 * nothing at all — not by a client, not by a test. The verifier calls it, and
 * the verifier lives in the same repository but a different process, so no
 * suite crossed the boundary.
 *
 * `test/staff.test.mts` now covers the handlers against a fake `nk`, which
 * proves the decisions. This file proves the three things that fake cannot:
 *
 *  - the SQL is valid and its predicates match the rows intended
 *  - the redemption really is atomic, by racing two callers at one code
 *  - the whole chain fits together — grant, provision, authenticate, join —
 *    across two processes and the HTTP envelope between them
 *
 * Runs only where Nakama does. It has no arm64 image, so this is CI or a
 * deployment reached through `TEST_NAKAMA_URL`.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { BASE, call, callAnonymous, connect, disconnect, signIn, sql } from './harness.mjs';

let available = false;
let staff = null;
let schoolId = null;

before(async () => {
  available = await connect();
  if (!available) return;

  // A platform staff account, seeded through SQL. There is deliberately no RPC
  // that promotes a caller, so this is the only way in — and adding one for the
  // tests would create the escalation route the design removes.
  staff = await signIn();
  await sql(`UPDATE lenterra_account_profile SET role = 'staff' WHERE user_id = $1`, [
    staff.userId,
  ]);

  schoolId = randomUUID();
  await sql(`INSERT INTO lenterra_school (id, name, district, province) VALUES ($1,$2,'Uji','NTT')`, [
    schoolId,
    `SMP Uji ${randomUUID().slice(0, 8)}`,
  ]);
});

after(disconnect);

/** Issue an invite as the seeded staff account and return the code. */
async function issue(over = {}) {
  const created = await call(staff.token, 'v1.admin.staff.invite', {
    role: 'teacher',
    schoolId,
    idempotencyKey: randomUUID(),
    ...over,
  });
  if (!created.ok) throw new Error(`invite failed: ${JSON.stringify(created.error)}`);
  return created.data;
}

describe('the staff invite chain', () => {
  test('an invite is issued, granted, and redeemed', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();
    assert.equal(invite.role, 'teacher');
    // The alphabet excludes 0/O and 1/I, because the code is read down a phone
    // line. A loose /[A-Z2-9]/ would pass a code containing exactly those.
    assert.match(invite.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/, 'ten unambiguous glyphs');

    // The verifier's door: unauthenticated, reached with the runtime HTTP key.
    const granted = await callAnonymous('v1.staff.grant', {
      code: invite.code,
      deviceId: `test-${randomUUID()}`,
    });
    assert.equal(granted.ok, true, JSON.stringify(granted.error));
    assert.ok(granted.data.grant.length > 0);
    assert.equal(granted.data.role, 'teacher', 'the role is shown before anybody commits');
    assert.ok(granted.data.schoolName, 'and so is the school, so a mistyped code is caught');

    // A grant must not spend the invite. Somebody who abandons the flow here
    // has to be able to start it again with the same code.
    const again = await callAnonymous('v1.staff.grant', {
      code: invite.code,
      deviceId: `test-${randomUUID()}`,
    });
    assert.equal(again.ok, true, 'minting a grant must not consume the invite');

    // Redeem it on a fresh account, which is what the verifier's assertion
    // would have produced.
    const teacher = await signIn();
    const joined = await call(teacher.token, 'v1.staff.join', {
      code: invite.code,
      idempotencyKey: randomUUID(),
    });

    assert.equal(joined.ok, true, JSON.stringify(joined.error));
    assert.equal(joined.data.role, 'teacher');
    assert.equal(joined.data.schoolId, schoolId);

    const { rows } = await sql(
      `SELECT role, school_id, auth_strategy FROM lenterra_account_profile WHERE user_id = $1`,
      [teacher.userId],
    );
    assert.equal(rows[0].role, 'teacher', 'the role is actually written, not merely returned');
    assert.equal(rows[0].school_id, schoolId);
    assert.equal(rows[0].auth_strategy, 'staff_code');
  });

  test('two accounts racing one code leave exactly one teacher', async (t) => {
    if (!available) return t.skip('no nakama');

    // The property the whole design rests on, and the one a fake `nk` cannot
    // test: single-use is enforced by a predicate inside the UPDATE, so this
    // has to run against a real database with two callers genuinely in flight.
    const invite = await issue();
    const [a, b] = await Promise.all([signIn(), signIn()]);

    const results = await Promise.all([
      call(a.token, 'v1.staff.join', { code: invite.code, idempotencyKey: randomUUID() }),
      call(b.token, 'v1.staff.join', { code: invite.code, idempotencyKey: randomUUID() }),
    ]);

    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, 'exactly one caller may redeem a staff code');

    const { rows } = await sql(
      `SELECT role FROM lenterra_account_profile WHERE user_id = ANY($1::uuid[]) AND role = 'teacher'`,
      [[a.userId, b.userId]],
    );
    assert.equal(rows.length, 1, 'and only one of them holds the role');
  });

  test('a spent code is refused, and says nothing about why', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();
    const first = await signIn();
    assert.equal(
      (await call(first.token, 'v1.staff.join', { code: invite.code, idempotencyKey: randomUUID() }))
        .ok,
      true,
    );

    const spent = await callAnonymous('v1.staff.grant', {
      code: invite.code,
      deviceId: `test-${randomUUID()}`,
    });
    const unknown = await callAnonymous('v1.staff.grant', {
      code: 'ZZZZZZZZZZ',
      deviceId: `test-${randomUUID()}`,
    });

    assert.equal(spent.ok, false);
    assert.equal(unknown.ok, false);
    // Identical, deliberately. Telling them apart lets somebody with a list of
    // guesses learn which codes were ever issued, and an issued code names a
    // school.
    assert.equal(spent.error.code, unknown.error.code);
    assert.equal(spent.error.message, unknown.error.message);
  });

  test('an expired code is refused', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();
    await sql(`UPDATE lenterra_staff_invite SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      invite.inviteId,
    ]);

    const granted = await callAnonymous('v1.staff.grant', {
      code: invite.code,
      deviceId: `test-${randomUUID()}`,
    });
    assert.equal(granted.ok, false, 'an expired invite must not mint a grant');

    const teacher = await signIn();
    const joined = await call(teacher.token, 'v1.staff.join', {
      code: invite.code,
      idempotencyKey: randomUUID(),
    });
    assert.equal(joined.ok, false, 'nor be redeemable directly');
  });

  test('a revoked code is refused', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();
    const revoked = await call(staff.token, 'v1.admin.staff.invite.revoke', {
      inviteId: invite.inviteId,
      idempotencyKey: randomUUID(),
    });
    assert.equal(revoked.ok, true, JSON.stringify(revoked.error));

    const teacher = await signIn();
    const joined = await call(teacher.token, 'v1.staff.join', {
      code: invite.code,
      idempotencyKey: randomUUID(),
    });
    assert.equal(joined.ok, false, 'revoking has to actually close the door');
  });

  test('revoking a spent invite is refused rather than silently accepted', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();
    const teacher = await signIn();
    await call(teacher.token, 'v1.staff.join', {
      code: invite.code,
      idempotencyKey: randomUUID(),
    });

    const revoked = await call(staff.token, 'v1.admin.staff.invite.revoke', {
      inviteId: invite.inviteId,
      idempotencyKey: randomUUID(),
    });
    // An administrator revoking a code they believe is live needs to learn that
    // somebody already used it.
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error.code, 'CONFLICT');
  });

  test('a school administrator cannot reach another school', async (t) => {
    if (!available) return t.skip('no nakama');

    const otherSchool = randomUUID();
    await sql(
      `INSERT INTO lenterra_school (id, name, district, province) VALUES ($1,$2,'Uji','NTT')`,
      [otherSchool, `SMP Lain ${randomUUID().slice(0, 8)}`],
    );

    const admin = await signIn();
    await sql(
      `UPDATE lenterra_account_profile SET role = 'school_admin', school_id = $2 WHERE user_id = $1`,
      [admin.userId, schoolId],
    );

    const crossSchool = await call(admin.token, 'v1.admin.staff.invite', {
      role: 'teacher',
      schoolId: otherSchool,
      idempotencyKey: randomUUID(),
    });
    assert.equal(crossSchool.ok, false, 'inviting into another school must be refused');
    assert.equal(crossSchool.error.code, 'FORBIDDEN');

    const escalate = await call(admin.token, 'v1.admin.staff.invite', {
      role: 'staff',
      schoolId,
      idempotencyKey: randomUUID(),
    });
    assert.equal(escalate.ok, false, 'nobody may grant authority they do not hold');
    assert.equal(escalate.error.code, 'FORBIDDEN');

    // And the listing is scoped whatever they ask for.
    const listed = await call(admin.token, 'v1.admin.staff.invite.list', {
      schoolId: otherSchool,
    });
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    for (const invite of listed.data.invites) {
      assert.equal(invite.schoolId, schoolId, 'a school admin only ever sees their own school');
    }
  });

  test('a teacher cannot issue invites', async (t) => {
    if (!available) return t.skip('no nakama');

    const teacher = await signIn();
    await sql(
      `UPDATE lenterra_account_profile SET role = 'teacher', school_id = $2 WHERE user_id = $1`,
      [teacher.userId, schoolId],
    );

    const attempt = await call(teacher.token, 'v1.admin.staff.invite', {
      role: 'teacher',
      schoolId,
      idempotencyKey: randomUUID(),
    });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.error.code, 'FORBIDDEN');
  });

  test('a student cannot issue or list invites', async (t) => {
    if (!available) return t.skip('no nakama');

    const student = await signIn();

    for (const rpc of ['v1.admin.staff.invite', 'v1.admin.staff.invite.list']) {
      const attempt = await call(student.token, rpc, {
        role: 'teacher',
        schoolId,
        idempotencyKey: randomUUID(),
      });
      assert.equal(attempt.ok, false, `${rpc} must refuse a student`);
      assert.equal(attempt.error.code, 'FORBIDDEN');
    }
  });

  test('the code of a spent invite is no longer readable', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();
    const teacher = await signIn();
    await call(teacher.token, 'v1.staff.join', {
      code: invite.code,
      idempotencyKey: randomUUID(),
    });

    const listed = await call(staff.token, 'v1.admin.staff.invite.list', { schoolId });
    assert.equal(listed.ok, true);

    const row = listed.data.invites.find((i) => i.id === invite.inviteId);
    assert.ok(row, 'the invite is still listed, so its history survives');
    assert.equal(row.status, 'redeemed');
    // An open code is returned so an administrator who lost it can recover it.
    // A spent one has no such use, and a code in a response is a code in a log.
    assert.equal(row.code, null);
  });

  test('the grant rpc is unreachable without the runtime key', async (t) => {
    if (!available) return t.skip('no nakama');

    const invite = await issue();

    // `callAnonymous` supplies the HTTP key; this deliberately does not. The
    // handler is registered as unauthenticated, so the key is the only thing
    // between the internet and a code oracle.
    const response = await fetch(`${BASE}/v2/rpc/v1.staff.grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify({ code: invite.code, deviceId: 'no-key' })),
    });

    assert.ok(
      response.status === 401 || response.status === 403,
      `answered ${response.status} — an unauthenticated caller reached v1.staff.grant`,
    );
  });
});
