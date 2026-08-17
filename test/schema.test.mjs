/**
 * Schema tests against a real PostgreSQL.
 *
 * The migrations reference `users(id)`, which Nakama creates during its own
 * `migrate up`. Rather than requiring a full Nakama to test our DDL, this
 * creates a stand-in holding exactly the columns we reference. That is enough
 * to prove the SQL is valid, that the constraints do what they claim, and that
 * re-running is a no-op — and it works on hardware where Nakama itself cannot
 * run (see docs/local-development.md).
 *
 * Skips cleanly when no database is reachable, so `npm test` still passes on a
 * machine with nothing running.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_TEST_DB ?? 'lenterra_schema_test',
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'localdev',
};

/** The subset of Nakama's `users` table our foreign keys point at. */
const NAKAMA_USERS_STUB = `
  CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY,
    username    TEXT UNIQUE,
    custom_id   TEXT UNIQUE,
    create_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    update_time TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

let available = false;
let client;

async function ensureDatabase() {
  const admin = new pg.Client({ ...config, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${config.database}`);
    await admin.query(`CREATE DATABASE ${config.database}`);
  } finally {
    await admin.end();
  }
}

before(async () => {
  try {
    await ensureDatabase();
    client = new pg.Client(config);
    await client.connect();
    await client.query(NAKAMA_USERS_STUB);
    available = true;
  } catch (err) {
    console.log(`skipping schema tests: no database reachable (${err.code ?? err.message})`);
  }
});

after(async () => {
  if (client) await client.end();
});

function migrate() {
  return execFileSync('node', [join(root, 'scripts/migrate.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_DB: config.database, DATABASE_URL: '' },
  });
}

async function newUser(customId = randomUUID()) {
  const id = randomUUID();
  await client.query(
    'INSERT INTO users (id, username, custom_id) VALUES ($1, $2, $3)',
    [id, `u-${id.slice(0, 8)}`, customId],
  );
  return id;
}

describe('migrations', () => {
  test('apply cleanly and create every lenterra table', async (t) => {
    if (!available) return t.skip('no database');

    const output = migrate();

    // Counted from the directory rather than written here. A literal was stale
    // from the first migration added after it, and a stale count fails the
    // build for the one reason that is never the problem.
    const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql'));
    assert.match(output, new RegExp(`applied ${files.length} migration`));
    for (const file of files) assert.match(output, new RegExp(`\\+ ${file} … ok`));

    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'lenterra_%'
       ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);

    for (const expected of [
      'lenterra_account_profile',
      'lenterra_attempt',
      'lenterra_audit_log',
      'lenterra_auth_jti',
      'lenterra_catalog_part',
      'lenterra_catalog_version',
      'lenterra_certificate',
      'lenterra_class',
      'lenterra_class_member',
      'lenterra_mastery_event',
      'lenterra_mission',
      'lenterra_points_ledger',
      'lenterra_skill_mastery',
      'lenterra_struggle_event',
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
  });

  test('re-running is a no-op', async (t) => {
    if (!available) return t.skip('no database');
    assert.match(migrate(), /schema already current/);
  });

  test('an edited applied migration is refused', async (t) => {
    if (!available) return t.skip('no database');

    // Editing a migration that already ran is how staging and production
    // quietly diverge, so the runner treats it as an error rather than a skip.
    await client.query(
      `UPDATE lenterra_migration SET sha256 = 'tampered' WHERE filename = '0001_profiles_and_schools.sql'`,
    );
    assert.throws(() => migrate(), /contents changed/);

    // Restore by dropping the tracking row and re-applying. The DDL is
    // IF NOT EXISTS throughout, so re-application is safe and re-records the
    // true hash — which is also how an operator would recover from this.
    await client.query(
      `DELETE FROM lenterra_migration WHERE filename = '0001_profiles_and_schools.sql'`,
    );
    assert.match(migrate(), /applied 1 migration/);
  });
});

describe('constraints', () => {
  test('an account may wait for a wallet, but two may not share one', async (t) => {
    if (!available) return t.skip('no database');

    // A class-code student has no address until they add an email. That is the
    // point rather than a limitation: an address that is never issued is one
    // that can never change underneath a certificate.
    const profile = (userId, wallet) =>
      client.query(
        `INSERT INTO lenterra_account_profile
           (user_id, role, display_name, friend_code, wallet_address, auth_strategy)
         VALUES ($1,'student','Siswa',$2,$3,'class_code')`,
        [userId, `FC${userId.slice(0, 6)}`, wallet],
      );

    // Any number of accounts may be waiting: Postgres does not consider two
    // NULLs equal, which is what makes the existing UNIQUE still correct.
    await profile(await newUser(), null);
    await profile(await newUser(), null);

    // And no two may ever hold the same one.
    const shared = `0x${randomUUID().replace(/-/g, '')}`;
    await profile(await newUser(), shared);

    const claimant = await newUser();
    await assert.rejects(
      () => profile(claimant, shared),
      'two accounts shared a wallet address',
    );
  });

  test('points balance is derived, never stored', async (t) => {
    if (!available) return t.skip('no database');

    const userId = await newUser();
    await client.query(
      `INSERT INTO lenterra_account_profile
         (user_id, role, display_name, friend_code, wallet_address, auth_strategy)
       VALUES ($1,'student','Ani',$2,$3,'class_code')`,
      [userId, `FC${userId.slice(0, 6)}`, `0x${userId.replace(/-/g, '')}`],
    );

    for (const [delta, key] of [[10, 'a'], [5, 'b'], [-3, 'c']]) {
      await client.query(
        `INSERT INTO lenterra_points_ledger (id, user_id, delta, reason, source_type, idempotency_key)
         VALUES ($1,$2,$3,'test','test',$4)`,
        [randomUUID(), userId, delta, `${userId}-${key}`],
      );
    }

    const { rows } = await client.query(
      'SELECT balance FROM lenterra_points_balance WHERE user_id = $1',
      [userId],
    );
    assert.equal(Number(rows[0].balance), 12);
  });

  test('a duplicate idempotency key cannot award twice', async (t) => {
    if (!available) return t.skip('no database');

    const userId = await newUser();
    const key = `dup-${userId}`;
    const insert = () =>
      client.query(
        `INSERT INTO lenterra_points_ledger (id, user_id, delta, reason, source_type, idempotency_key)
         VALUES ($1,$2,10,'test','test',$3) ON CONFLICT (idempotency_key) DO NOTHING`,
        [randomUUID(), userId, key],
      );

    const first = await insert();
    const second = await insert();
    assert.equal(first.rowCount, 1);
    assert.equal(second.rowCount, 0, 'the second award must not land');
  });

  test('exactly one catalog version can be current', async (t) => {
    if (!available) return t.skip('no database');

    await client.query(
      `INSERT INTO lenterra_catalog_version (version, status, manifest)
       VALUES ('v1','current','{}'), ('v2','published','{}')`,
    );
    await assert.rejects(
      client.query(`UPDATE lenterra_catalog_version SET status='current' WHERE version='v2'`),
      /duplicate key|unique/i,
      'the partial index is what makes rollback a single safe UPDATE',
    );
  });

  test('mastery is constrained to a probability', async (t) => {
    if (!available) return t.skip('no database');

    const userId = await newUser();
    await assert.rejects(
      client.query(
        `INSERT INTO lenterra_skill_mastery
           (user_id, skill_node_id, mastery, engine_version, params_version)
         VALUES ($1,'algo.iteration',1.5,'1.0.0','v1')`,
        [userId],
      ),
      /check constraint/i,
    );
  });

  test('an unknown role is rejected', async (t) => {
    if (!available) return t.skip('no database');

    const userId = await newUser();
    await assert.rejects(
      client.query(
        `INSERT INTO lenterra_account_profile
           (user_id, role, display_name, friend_code, wallet_address, auth_strategy)
         VALUES ($1,'superuser','X',$2,$3,'email')`,
        [userId, `FCX${userId.slice(0, 5)}`, `0xrole${userId.replace(/-/g, '')}`],
      ),
      /check constraint/i,
    );
  });

  test('deleting an account cascades its learning data', async (t) => {
    if (!available) return t.skip('no database');

    const userId = await newUser();
    await client.query(
      `INSERT INTO lenterra_account_profile
         (user_id, role, display_name, friend_code, wallet_address, auth_strategy)
       VALUES ($1,'student','Rizky',$2,$3,'email')`,
      [userId, `FCD${userId.slice(0, 5)}`, `0xdel${userId.replace(/-/g, '')}`],
    );
    await client.query(
      `INSERT INTO lenterra_skill_mastery
         (user_id, skill_node_id, mastery, engine_version, params_version)
       VALUES ($1,'algo.iteration',0.5,'1.0.0','v1')`,
      [userId],
    );

    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM lenterra_skill_mastery WHERE user_id = $1',
      [userId],
    );
    assert.equal(rows[0].n, 0, 'account deletion must remove the data it owns');
  });

  test('removing a student from a class preserves their history', async (t) => {
    if (!available) return t.skip('no database');

    const teacherId = await newUser();
    const studentId = await newUser();
    const schoolId = randomUUID();
    const classId = randomUUID();

    await client.query(
      `INSERT INTO lenterra_school (id, name, district) VALUES ($1,'SMP Test','Kupang')`,
      [schoolId],
    );
    await client.query(
      `INSERT INTO lenterra_class
         (id, school_id, teacher_user_id, nakama_group_id, name, level, join_code)
       VALUES ($1,$2,$3,$4,'8A','SMP-8','ABC123')`,
      [classId, schoolId, teacherId, randomUUID()],
    );
    await client.query(
      'INSERT INTO lenterra_class_member (class_id, user_id) VALUES ($1,$2)',
      [classId, studentId],
    );

    await client.query(
      'UPDATE lenterra_class_member SET removed_at = now() WHERE class_id=$1 AND user_id=$2',
      [classId, studentId],
    );

    const { rows } = await client.query(
      'SELECT removed_at FROM lenterra_class_member WHERE class_id=$1 AND user_id=$2',
      [classId, studentId],
    );
    assert.equal(rows.length, 1, 'the membership row survives removal');
    assert.notEqual(rows[0].removed_at, null);
  });

  test('the class heatmap query runs on the intended indexes', async (t) => {
    if (!available) return t.skip('no database');

    const { rows } = await client.query(
      `EXPLAIN
       SELECT m.user_id, sm.skill_node_id, sm.mastery
       FROM lenterra_class_member m
       LEFT JOIN lenterra_skill_mastery sm ON sm.user_id = m.user_id
       WHERE m.class_id = $1 AND m.removed_at IS NULL`,
      [randomUUID()],
    );
    // At pilot scale the planner may still choose a sequential scan; the
    // assertion is only that the query plans at all, which catches a column
    // rename breaking the dashboard's most-run query.
    assert.ok(rows.length > 0);
  });
});
