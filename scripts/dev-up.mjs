#!/usr/bin/env node
// Brings up the local stack in the one order that works, and reports why if it
// does not (E1.2: a working stack in under five minutes).
//
// The ordering constraint is real: our tables reference users(id), which
// Nakama creates during its own `migrate up`. Running the lenterra migrations
// first fails with a confusing foreign-key error, so this script waits for
// Nakama to be healthy before applying them.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = join(root, 'docker/docker-compose.yml');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return (result.stdout ?? '') + (result.stderr ?? '');
}

function loadEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) {
    console.log('no .env found — falling back to the defaults in docker-compose.yml');
    console.log('copy .env.example to .env before pointing this at anything real\n');
    return;
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

async function waitFor(label, check, timeoutMs = 180_000) {
  const started = Date.now();
  process.stdout.write(`waiting for ${label} `);
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      console.log(' ok');
      return true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log(' timed out');
  return false;
}

async function main() {
  loadEnv();

  // The modules bundle is mounted into Nakama. Without it the server starts and
  // registers nothing, which looks like a broken server rather than a missing
  // build step.
  if (!existsSync(join(root, 'modules/build/index.js'))) {
    console.log('building the Nakama modules first…');
    if (run('npm', ['run', 'build']) !== 0) process.exit(1);
  }

  console.log('starting postgres and nakama…');
  if (run('docker', ['compose', '-f', compose, 'up', '-d', 'postgres', 'nakama']) !== 0) {
    console.error('\ndocker compose failed. Is the Docker daemon running?');
    process.exit(1);
  }

  const nakamaReady = await waitFor('nakama', () => {
    const status = capture('docker', ['compose', '-f', compose, 'ps', '--format', 'json', 'nakama']);
    return status.includes('healthy') || status.includes('running');
  });
  if (!nakamaReady) {
    console.error('\nnakama did not come up. Logs:\n');
    run('docker', ['compose', '-f', compose, 'logs', '--tail', '50', 'nakama']);
    process.exit(1);
  }

  // Nakama owns `users`; give its own migration a moment to land before ours
  // reference it.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log('\napplying lenterra migrations…');
  if (run('node', [join(root, 'scripts/migrate.mjs')]) !== 0) {
    console.error('\nmigrations failed — the schema is not ready');
    process.exit(1);
  }

  console.log('\nstack is up:');
  console.log('  nakama api      http://localhost:7350');
  console.log('  nakama console  http://localhost:7351   (loopback only)');
  console.log('  postgres        localhost:5432');
  console.log('\n  npm run dev:reload   rebuild modules and restart nakama');
  console.log('  npm run dev:logs     follow nakama logs');
  console.log('  npm run seed         load synthetic pilot data');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
