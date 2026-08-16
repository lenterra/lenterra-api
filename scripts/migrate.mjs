#!/usr/bin/env node
// Applies migrations/*.sql in order, once each, and records what it applied.
//
// Runs AFTER `nakama migrate up` — our tables reference users(id), which
// Nakama creates. dev-up.mjs enforces that order.
//
// Re-running is a no-op (E1.3). A file whose contents changed after being
// applied is an error, not a silent skip: editing an applied migration is how
// staging and production quietly diverge.

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'migrations');

const TRACKING = `
  CREATE TABLE IF NOT EXISTS lenterra_migration (
    filename   TEXT PRIMARY KEY,
    sha256     TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

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

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error('no migrations found in', migrationsDir);
    process.exit(1);
  }

  const client = new pg.Client(connectionConfig());
  await client.connect();

  try {
    await client.query(TRACKING);
    const { rows } = await client.query('SELECT filename, sha256 FROM lenterra_migration');
    const applied = new Map(rows.map((r) => [r.filename, r.sha256]));

    let ran = 0;
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const hash = sha256(sql);
      const prior = applied.get(file);

      if (prior === hash) {
        console.log(`  = ${file} (already applied)`);
        continue;
      }
      if (prior && prior !== hash) {
        throw new Error(
          `${file} was already applied but its contents changed.\n` +
            `Applied migrations are immutable — add a new numbered file instead.`,
        );
      }

      process.stdout.write(`  + ${file} … `);
      await client.query(sql);
      await client.query(
        'INSERT INTO lenterra_migration (filename, sha256) VALUES ($1, $2)',
        [file, hash],
      );
      console.log('ok');
      ran += 1;
    }

    console.log(ran === 0 ? 'schema already current' : `applied ${ran} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nmigration failed:', err.message);
  process.exit(1);
});
