#!/usr/bin/env node
// Create the first staff invite.
//
// Every other invite is issued by somebody who already holds authority. The
// first one cannot be, so it is written here — directly to the database, by a
// person with a shell on the server, which is the only credential that exists
// before any account does.
//
// This replaces the previous instruction to grant roles with raw SQL. The
// difference is not convenience: this writes an *invite*, so the first
// administrator's account is created through the same redemption path as every
// other, with the same audit row at the end of it. An UPDATE against
// lenterra_account_profile leaves no trace of who ran it or why.
//
//   node scripts/bootstrap-admin.mjs                       # platform staff
//   node scripts/bootstrap-admin.mjs --role school_admin --school <uuid>
//   node scripts/bootstrap-admin.mjs --school-name "SMP Negeri 1 Ende" --district Ende
//
// The code it prints is the whole secret. It is single-use and expires.

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const GRANTABLE = ['teacher', 'school_admin', 'staff'];

function connectionConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'nakama',
    user: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'localdev',
  };
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * Rejection sampling rather than modulo.
 *
 * 256 is not a multiple of 32 only by luck here — it is — but the same code
 * gets copied to an alphabet where it is not, and a biased invite code is a
 * smaller keyspace than the one written down in the design.
 */
function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH * 2);
  globalThis.crypto.getRandomValues(bytes);

  let code = '';
  for (let i = 0; code.length < CODE_LENGTH && i < bytes.length; i += 1) {
    const value = bytes[i];
    if (value >= 256 - (256 % ALPHABET.length)) continue;
    code += ALPHABET[value % ALPHABET.length];
  }
  return code.length === CODE_LENGTH ? code : generateCode();
}

async function main() {
  const role = arg('role', 'staff');
  if (!GRANTABLE.includes(role)) {
    console.error(`--role must be one of ${GRANTABLE.join(', ')}`);
    process.exit(1);
  }

  const hours = Number(arg('expires-in-hours', '168'));
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    console.error('--expires-in-hours must be between 1 and 720');
    process.exit(1);
  }

  const client = new pg.Client(connectionConfig());
  await client.connect();

  try {
    let schoolId = arg('school');
    const schoolName = arg('school-name');

    if (!schoolId && schoolName) {
      // Creating the school here as well, because a school administrator with
      // no school to administer cannot do anything at all, and making somebody
      // run two commands to reach a working state is how one of them gets
      // forgotten.
      schoolId = randomUUID();
      await client.query(
        `INSERT INTO lenterra_school (id, name, district, province) VALUES ($1, $2, $3, $4)`,
        [schoolId, schoolName, arg('district', 'Unknown'), arg('province', 'NTT')],
      );
      console.log(`created school ${schoolName} (${schoolId})`);
    }

    if (role !== 'staff' && !schoolId) {
      console.error(
        `--role ${role} needs a school: pass --school <uuid> or --school-name "<name>"`,
      );
      process.exit(1);
    }

    const code = generateCode();
    const rows = await client.query(
      `INSERT INTO lenterra_staff_invite (id, code, role, school_id, issued_by, expires_at)
       VALUES ($1, $2, $3, $4, NULL, now() + ($5 || ' hours')::interval)
       RETURNING code, expires_at`,
      [randomUUID(), code, role, schoolId, String(hours)],
    );

    const invite = rows.rows[0];
    console.log('');
    console.log(`  invite code   ${invite.code}`);
    console.log(`  role          ${role}`);
    console.log(`  school        ${schoolId ?? '(none — platform staff)'}`);
    console.log(`  expires       ${invite.expires_at.toISOString()}`);
    console.log('');
    console.log('  Single-use. Enter it on the dashboard sign-in screen.');
    console.log('');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
