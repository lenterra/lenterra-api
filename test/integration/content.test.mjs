/**
 * Publishing, promoting, and rolling back a catalog.
 *
 * Content ships without a deploy, which is the point — a mission with a
 * confusing brief should be fixable in an afternoon, not in a release. The
 * consequence is that the catalog is a live thing students are mid-mission
 * against, so the properties that matter are about *transitions*: exactly one
 * version is current at any moment, a rollback is one step rather than a
 * runbook, and a client on yesterday's catalog is told to update rather than
 * having its work thrown away.
 *
 * That last one is the whole reason `CATALOG_STALE` is its own error code. A
 * student who played three missions offline against v1 and syncs after v2 lands
 * must not lose them; the client pulls and retries. Collapsing that into a
 * generic failure loses a fortnight of work quietly.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { call, connect, disconnect, makeStaff, signIn, sql } from './harness.mjs';

let available = false;
let staff = null;
let student = null;
let current = null;

before(async () => {
  available = await connect();
  if (!available) return;

  staff = await signIn();
  await makeStaff(staff.userId);

  student = await signIn();
  const bootstrap = await call(student.token, 'v1.session.bootstrap', {});
  current = bootstrap.ok ? bootstrap.data.catalog.currentVersion : null;
});

after(disconnect);

function skipUnlessReady(t) {
  if (!available) return (t.skip('no nakama'), true);
  if (!current) return (t.skip('no published catalog'), true);
  return false;
}

describe('the manifest a client reads', () => {
  test('names the current version and what to pull', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.catalog.manifest', {});
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.version, current);
    assert.ok((res.data.parts ?? []).length > 0, 'a manifest with no parts is not usable');
  });

  test('every part carries a checksum, so a truncated download is detectable', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.catalog.manifest', {});
    assert.ok(res.ok);
    for (const part of res.data.parts) {
      assert.ok(part.sha256 && part.sha256.length === 64, `${part.part} has no usable checksum`);
      assert.ok(part.bytes > 0, `${part.part} reports no size`);
    }
  });

  test('a client already on the current version is told there is nothing to do', async (t) => {
    if (skipUnlessReady(t)) return;

    // A student paying by the megabyte must not re-download a catalog they
    // already hold because the manifest could not say so.
    const res = await call(student.token, 'v1.catalog.manifest', { haveVersion: current });
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.equal(res.data.version, current);
  });
});

describe('pulling', () => {
  test('a part of the current version is served', async (t) => {
    if (skipUnlessReady(t)) return;

    const manifest = await call(student.token, 'v1.catalog.manifest', {});
    assert.ok(manifest.ok);
    const part = manifest.data.parts[0];

    const res = await call(student.token, 'v1.catalog.pull', {
      version: current,
      part: part.part,
    });
    assert.ok(res.ok, JSON.stringify(res.error));
    assert.ok(res.data.body ?? res.data.content ?? res.data.data, 'the part came back empty');
  });

  test('a part of a version that was never published is not', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.catalog.pull', {
      version: 'catalog@000000000000',
      part: 'missions',
    });
    assert.equal(res.ok, false);
  });
});

describe('publishing and promoting', () => {
  test('only staff may promote', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.admin.catalog.publish', {
      version: current,
      promote: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false, 'a student promoted a catalog version');
  });

  test('promoting an unknown version is refused rather than creating one', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(staff.token, 'v1.admin.catalog.publish', {
      version: 'catalog@deadbeefcafe',
      promote: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.ok, false);
  });

  test('exactly one version is current, before and after a promotion', async (t) => {
    if (skipUnlessReady(t)) return;

    const count = async () => {
      const { rows } = await sql(
        `SELECT count(*)::int AS n FROM lenterra_catalog_version WHERE status = 'current'`,
      );
      return rows[0].n;
    };

    assert.equal(await count(), 1, 'the catalog had no single current version to begin with');

    const res = await call(staff.token, 'v1.admin.catalog.publish', {
      version: current,
      promote: true,
      idempotencyKey: randomUUID(),
    });
    assert.ok(res.ok, JSON.stringify(res.error));

    // A half-finished promotion is not a state that can exist — the database
    // guarantees it rather than the handler remembering to.
    assert.equal(await count(), 1);
  });

  test('a rollback is one promotion of the previous version', async (t) => {
    if (skipUnlessReady(t)) return;

    // Staged as a draft rather than promoted, which is the point of the split:
    // content can be reviewed against a real server before a student sees it.
    // Copies the current version's manifest and parts so the staged draft is a
    // real catalog rather than an empty one — promoting an empty version would
    // pass this test while leaving a student with no missions.
    const staged = `catalog@${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await sql(
      `INSERT INTO lenterra_catalog_version (version, status, manifest, published_at)
       SELECT $1, 'draft', manifest, now()
       FROM lenterra_catalog_version WHERE version = $2`,
      [staged, current],
    );
    await sql(
      `INSERT INTO lenterra_catalog_part (version, part, sha256, bytes, body)
       SELECT $1, part, sha256, bytes, body
       FROM lenterra_catalog_part WHERE version = $2`,
      [staged, current],
    );

    const promoted = await call(staff.token, 'v1.admin.catalog.publish', {
      version: staged,
      promote: true,
      idempotencyKey: randomUUID(),
    });
    assert.ok(promoted.ok, JSON.stringify(promoted.error));

    const afterPromote = await call(student.token, 'v1.catalog.manifest', {});
    assert.equal(afterPromote.data.version, staged);
    assert.ok(afterPromote.data.parts.length > 0, 'the promoted version served no content');

    // The moment a rollback is needed is the moment nobody wants to read a
    // runbook, so it is the same call against the older version.
    const rolledBack = await call(staff.token, 'v1.admin.catalog.publish', {
      version: current,
      promote: true,
      idempotencyKey: randomUUID(),
    });
    assert.ok(rolledBack.ok, JSON.stringify(rolledBack.error));

    const afterRollback = await call(student.token, 'v1.catalog.manifest', {});
    assert.equal(afterRollback.data.version, current, 'rollback did not restore the old catalog');

    await sql(`DELETE FROM lenterra_catalog_version WHERE version = $1`, [staged]);
  });
});

describe('a client on the wrong version', () => {
  test('is told to update rather than having its work discarded', async (t) => {
    if (skipUnlessReady(t)) return;

    const res = await call(student.token, 'v1.attempt.submit', {
      idempotencyKey: randomUUID(),
      attempt: {
        missionId: 'congklak.m01',
        missionContentVersion: 1,
        catalogVersion: 'catalog@000000000000',
        gameId: 'congklak',
        replay: { moves: [] },
        claimedOutcome: 'failure',
        durationMs: 1000,
        clientStartedAt: new Date().toISOString(),
        deviceSeq: 1,
        hintShown: false,
        hintUsed: false,
        playedOffline: true,
        twoPlayer: false,
        coreVersion: '0.1.0',
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'CATALOG_STALE');
    // Naming the version is what turns "retry later" into "pull this, then
    // retry" — without it the client can only guess and back off.
    assert.equal(res.error.details.currentVersion, current);
  });
});
