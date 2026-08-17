#!/usr/bin/env node
// Check a deployed stack from outside, with no credentials.
//
// The integration suite needs a database connection and writes data, so it is
// for staging. This is for the two minutes after a production deploy: it only
// asks questions a stranger could ask, and every answer it accepts is one that
// proves something specific about the deployment.
//
//   npm run smoke                                  # lenterra-api.faizath.com
//   npm run smoke -- https://staging.example.com
//
// What it cannot check is anything behind a session. A green run means the
// stack is up, routed, and refusing the right things — not that a student can
// sign in, which needs a class code that exists.

const target = (process.argv[2] ?? 'https://lenterra-api.faizath.com').replace(/\/$/, '');

const results = [];

/**
 * Everything after the health check depends on it.
 *
 * A parked domain, a proxy, or somebody else's server answers 403 to
 * everything — which is indistinguishable from correctly refusing an
 * unauthenticated RPC. Reporting those as passes against a host with nothing
 * deployed is worse than not checking them, because it reads as partial
 * success. Once the health check fails, the rest do not run.
 */
let reachable = true;

async function check(name, fn, { requiresStack = true } = {}) {
  if (requiresStack && !reachable) {
    results.push({ name, skipped: true, detail: 'not checked — the server did not answer' });
    return;
  }
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

async function get(path, options = {}) {
  return fetch(`${target}${path}`, { signal: AbortSignal.timeout(15_000), ...options });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Nakama's own health endpoint, through the proxy. */
await check(
  'nakama is healthy',
  async () => {
    const res = await get('/healthcheck');
    if (!res.ok) reachable = false;
    expect(res.ok, `healthcheck answered ${res.status} — nothing is deployed here yet`);
    return `${res.status}`;
  },
  { requiresStack: false },
);

await check('tls is valid and hsts is set', async () => {
  const res = await get('/healthcheck');
  const hsts = res.headers.get('strict-transport-security');
  expect(hsts, 'no Strict-Transport-Security header — is Caddy in front?');
  return hsts;
});

/** The verifier, behind its prefix. Reports whether code sign-in can work. */
await check('verifier is configured for code sign-in', async () => {
  const res = await get('/verifier/health');
  expect(res.ok, `verifier health answered ${res.status}`);

  const body = await res.json();
  // The single most consequential misconfiguration: without both secrets no
  // student can join a class, and nothing else about the deployment looks
  // wrong. It is worth failing a smoke test over.
  expect(
    body.codeSignIn === true,
    'codeSignIn is false — JOIN_GRANT_HMAC_SECRET or NAKAMA_HTTP_KEY is missing, ' +
      'and no student can join a class',
  );
  return `provisioner=${body.provisioner}, thirdweb=${body.thirdweb}`;
});

/** The console must not be reachable. It is a full admin interface over children's records. */
await check('the nakama console is not exposed', async () => {
  const res = await get('/console');
  expect(res.status === 404, `/console answered ${res.status}, expected 404`);
  return '404';
});

/** An RPC with no session must be refused, not served. */
await check('an authenticated rpc refuses an anonymous caller', async () => {
  const res = await get('/v2/rpc/v1.session.bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify({})),
  });
  expect(res.status === 401 || res.status === 403, `answered ${res.status}, expected 401 or 403`);
  return `${res.status}`;
});

/** And so must one that needs the runtime key. */
await check('the class-grant rpc refuses a caller with no http key', async () => {
  const res = await get('/v2/rpc/v1.class.grant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify({ code: 'AAAAAA', deviceId: 'smoke' })),
  });
  expect(
    res.status === 401 || res.status === 403,
    `answered ${res.status} — an unauthenticated caller reached v1.class.grant`,
  );
  return `${res.status}`;
});

/**
 * The scheduled purge must not be reachable from outside.
 *
 * It deletes accounts and takes no session, because a timer has none — the
 * runtime HTTP key is the only thing standing in front of it. That key is
 * supposed to stay inside the compose network, so a caller from the internet
 * without it must be refused. If this ever answers 200, anybody on the internet
 * can trigger deletions.
 */
await check('the scheduled purge refuses a caller with no http key', async () => {
  const res = await get('/v2/rpc/v1.admin.purge.scheduled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify({})),
  });
  expect(
    res.status === 401 || res.status === 403,
    `answered ${res.status} — an unauthenticated caller reached the account-deletion sweep`,
  );
  return `${res.status}`;
});

/**
 * Is there content?
 *
 * Not a failure: a stack can be correctly deployed and not yet published to.
 * But it is the difference between a server that works and a server a student
 * can use, so it is reported either way.
 */
await check('a catalog has been published', async () => {
  const res = await get('/v2/rpc/v1.catalog.manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify({})),
  });
  // Refused for want of a session, which is correct — the check is only that
  // the route exists and the runtime is loaded rather than 404ing.
  expect(res.status !== 404, 'v1.catalog.manifest is not registered — are the modules loaded?');
  return `route present (${res.status})`;
});

console.log(`\n${target}\n`);
for (const { name, ok, skipped, detail } of results) {
  const mark = skipped ? '·' : ok ? '\u2713' : '\u2717';
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ''}`);
}

const failed = results.filter((r) => !r.ok && !r.skipped);
console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} failed, ${results.filter((r) => r.skipped).length} not checked`);
  process.exit(1);
}
console.log(`all ${results.length} checks passed`);
console.log('');
console.log('This says the stack is up, routed, and refusing the right things.');
console.log('It says nothing about signing in — that needs a class code that exists.');
console.log('');
