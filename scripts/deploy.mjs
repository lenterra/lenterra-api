#!/usr/bin/env node
// Deploy the API stack. Run on the server, from a checkout.
//
// The order matters and is the reason this exists rather than a README step:
//
//   1. build the runtime modules, because Nakama mounts `modules/build` and a
//      stale bundle is the one failure that looks like a working deploy
//   2. check the bundle is goja-safe, because a syntax error Nakama cannot
//      parse takes the runtime down rather than the request
//   3. bring up Postgres and Nakama, and wait — Nakama runs its own
//      `migrate up`, which creates `users`, which our tables reference
//   4. apply the lenterra migrations
//   5. bring up the rest and wait for health
//
// Running these by hand in the wrong order fails with a foreign-key error that
// says nothing about ordering.
//
//   node scripts/deploy.mjs              # build, migrate, up
//   node scripts/deploy.mjs --no-build   # config-only change
//   node scripts/deploy.mjs --publish    # also publish the content catalog

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = join(root, 'docker/docker-compose.prod.yml');
const envFile = join(root, 'docker/.env.prod');

const skipBuild = process.argv.includes('--no-build');
const publish = process.argv.includes('--publish');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return (result.stdout ?? '') + (result.stderr ?? '');
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/**
 * Load `docker/.env.prod` into this process.
 *
 * Compose reads it for the containers; this script reads it too, because the
 * migration and publish steps build a connection string from the same
 * credentials. One file, so the two cannot disagree about the password.
 */
function loadEnv() {
  if (!existsSync(envFile)) {
    fail(
      `docker/.env.prod not found.\n` +
        `Copy docker/.env.prod.example to docker/.env.prod and fill it in.\n` +
        `Generate each secret on this machine: openssl rand -hex 32`,
    );
  }

  const missing = [];
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
    if (value === '' && !key.endsWith('_PREVIOUS') && !OPTIONAL.has(key)) missing.push(key);
  }

  if (missing.length > 0) {
    fail(
      `These are empty in docker/.env.prod and the stack will not start:\n  ${missing.join('\n  ')}`,
    );
  }

  // Checked here as well as by the verifier, so it is caught before anything
  // is brought up rather than by a container that restarts in a loop.
  if ((process.env.ASSERTION_HMAC_SECRET ?? '').length < 32) {
    fail('ASSERTION_HMAC_SECRET must be at least 32 characters');
  }
}

/** Values that are legitimately blank: only the optional wallet path. */
const OPTIONAL = new Set(['THIRDWEB_SECRET_KEY', 'ASSERTION_HMAC_SECRET_PREVIOUS']);

async function waitFor(label, check, timeoutMs = 300_000) {
  const started = Date.now();
  process.stdout.write(`waiting for ${label} `);
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      console.log(' ok');
      return true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.log(' timed out');
  return false;
}

const dc = (...args) => ['compose', '-f', compose, '--env-file', envFile, ...args];

/**
 * Run one of this repository's scripts against the stack's database.
 *
 * Postgres publishes no port — that is the point of the production compose —
 * so a script on the host cannot reach it. This joins the compose network
 * instead, with the checkout mounted, and uses a plain Node image rather than
 * one of the service images: the verifier's image installs production
 * dependencies only, and both of these scripts need `pg` from the root
 * dev dependencies.
 *
 * The compose project is named, so the network name is predictable rather than
 * derived from whatever the directory happens to be called.
 */
function inNetwork(script, ...args) {
  const url = `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`;
  return run('docker', [
    'run',
    '--rm',
    '--network',
    'lenterra-prod_default',
    '-e',
    `DATABASE_URL=${url}`,
    '-v',
    `${root}:/app`,
    '-w',
    '/app',
    'node:22-alpine',
    'node',
    script,
    ...args,
  ]);
}

function healthy(service) {
  const id = capture('docker', dc('ps', '-q', service)).trim();
  if (!id) return false;
  return capture('docker', ['inspect', '-f', '{{.State.Health.Status}}', id]).trim() === 'healthy';
}

async function main() {
  loadEnv();

  if (!skipBuild) {
    console.log('\n== building the runtime modules ==');
    // Nakama mounts modules/build. Deploying without this is deploying the
    // previous release's server logic against the current release's data.
    if (run('npm', ['run', 'build']) !== 0) fail('build failed');
    if (run('npm', ['run', 'guard:bundle']) !== 0) fail('bundle guard failed');
    if (run('npm', ['run', 'content:validate']) !== 0) fail('content validation failed');
  }

  console.log('\n== starting the database and server ==');
  // Nakama's own `migrate up` runs in its entrypoint and creates `users`,
  // which every lenterra_* table references.
  if (run('docker', dc('up', '-d', '--build', 'postgres', 'nakama')) !== 0) {
    fail('could not start postgres and nakama');
  }

  if (!(await waitFor('nakama', () => healthy('nakama')))) {
    console.error('\nlast 40 lines:');
    run('docker', dc('logs', '--tail', '40', 'nakama'));
    fail('nakama did not become healthy');
  }

  console.log('\n== applying migrations ==');
  if (inNetwork('scripts/migrate.mjs') !== 0) fail('migrations failed');

  console.log('\n== starting the verifier and proxy ==');
  if (run('docker', dc('up', '-d', '--build')) !== 0) fail('could not start the stack');

  if (!(await waitFor('verifier', () => healthy('verifier')))) {
    run('docker', dc('logs', '--tail', '40', 'verifier'));
    fail('verifier did not become healthy');
  }

  if (publish) {
    console.log('\n== publishing content ==');
    // Separate from the deploy by default. Content and code move on different
    // schedules, and a catalog version bump invalidates what every device has
    // cached — not something to do incidentally while fixing a server bug.
    if (inNetwork('scripts/content-publish.mjs', '--promote') !== 0) {
      fail('content publish failed');
    }
  }

  const domain = process.env.LENTERRA_API_DOMAIN;
  console.log(`\ndeployed. https://${domain}`);
  console.log('');
  console.log('  check     curl -s https://' + domain + '/verifier/health');
  console.log('  logs      docker compose -f docker/docker-compose.prod.yml logs -f nakama');
  console.log('  console   ssh -L 7351:localhost:7351 <this-host>   (then open localhost:7351)');
  console.log('');
  console.log('  First administrator, once:');
  console.log('    npm run bootstrap:admin -- --role staff');
  console.log('');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
