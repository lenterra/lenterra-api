# Deployment

The API runs on one VPS as four containers behind Caddy, at
`lenterra-api.faizath.com`. The site and the teacher dashboard are static and go
to Cloudflare Pages from the `lenterra-web` repository; nothing here serves
them.

## What is exposed

Exactly one thing: Caddy, on 80 and 443. Postgres, Nakama, and the verifier
publish no ports at all and talk over the compose network.

| | Where | Reached by |
|---|---|---|
| Caddy | `:80`, `:443` | the internet |
| Nakama | `nakama:7350` | Caddy, at `/` |
| Verifier | `verifier:8787` | Caddy, at `/verifier/*` |
| Postgres | `postgres:5432` | Nakama and the verifier |
| Nakama console | `nakama:7351` | an SSH tunnel, and nothing else |

The console is a full administrative interface over children's records. It is
unpublished by compose *and* refused by Caddy, so exposing it takes two
deliberate changes rather than one forgotten line.

## First deploy

On the server, with Docker and a checkout:

```bash
cp docker/.env.prod.example docker/.env.prod
# Generate every secret here, not on a laptop:
openssl rand -hex 32
```

Fill in each value. Nothing has a default — the compose file uses `${VAR:?}`, so
a blank one stops the stack rather than running on a placeholder from a public
repository. `deploy.mjs` checks the same thing before touching anything, so a
missing secret costs you a message rather than a half-started stack.

Point an A record at the host **before** the first deploy. Caddy asks Let's
Encrypt for a certificate on start, and a domain that does not resolve yet
means a failed challenge and a rate limit to wait out.

```bash
npm ci
npm run deploy -- --publish
```

Then create the first administrator, once:

```bash
npm run bootstrap:admin -- --role staff
```

That prints a single-use invite code. Redeem it on the dashboard sign-in
screen; every account after it is invited from inside the product, with an
audit row behind each.

## Ordinary deploys

```bash
git pull
npm ci
npm run deploy
```

The order inside is the reason the script exists:

1. build the runtime modules — Nakama mounts `modules/build`, and a stale
   bundle is the one failure that looks like a working deploy
2. check the bundle is goja-safe and the content validates
3. start Postgres and Nakama, and **wait** — Nakama runs its own `migrate up`,
   which creates `users`, which every `lenterra_*` table references
4. apply the lenterra migrations
5. start the verifier and Caddy, and wait for health

Doing this by hand in the wrong order fails with a foreign-key error that says
nothing about ordering.

`--no-build` skips step 1 for a configuration-only change. `--publish` also
publishes the content catalog, which is deliberately *not* part of an ordinary
deploy: a catalog version bump invalidates what every device has cached, and
that should not happen incidentally while fixing a server bug.

## Content

```bash
npm run deploy -- --publish        # build, migrate, deploy, publish
```

Until a catalog is published, `v1.catalog.manifest` returns nothing and no
student sees a lesson. Publishing is idempotent — an unchanged catalog produces
the same version hash and no new rows.

## Checking it

```bash
curl -s https://lenterra-api.faizath.com/verifier/health
docker compose -f docker/docker-compose.prod.yml logs -f nakama
```

`/verifier/health` reports whether code sign-in is configured and whether
thirdweb is set up. `codeSignIn: false` means `JOIN_GRANT_HMAC_SECRET` or
`NAKAMA_HTTP_KEY` is missing, and no student can join a class.

The console, when you need it:

```bash
ssh -L 7351:localhost:7351 <host>
# then open http://localhost:7351
```

## Secrets, and rotating them

`ASSERTION_HMAC_SECRET` is shared by the verifier and the Nakama modules and by
nothing else. Rotation accepts two at once:

1. set `ASSERTION_HMAC_SECRET_PREVIOUS` to the outgoing value
2. set `ASSERTION_HMAC_SECRET` to the new one
3. deploy
4. after two minutes — longer than any assertion lives — clear `_PREVIOUS` and
   deploy again

Replacing it in one step fails every sign-in in flight, which during a class
onboarding session means thirty students at once.

`JOIN_GRANT_HMAC_SECRET` has no rotation window: Nakama signs grants with it and
the verifier checks them, and both restart together. Grants live five minutes,
so change it when nobody is joining.

## Backups

The database is the product. Everything else in this stack can be rebuilt from
the repository in minutes; a lost `pgdata` volume is a lost term of children's
work, and there is no other copy.

```bash
docker compose -f docker/docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > lenterra-$(date +%F).sql.gz
```

Take one before every deploy that includes a migration, and keep them somewhere
that is not this machine. **A backup nobody has restored is a hypothesis** —
restore one into a scratch database and run `npm run test:schema` against it
before you need to do it under pressure.

## Retention

`v1.admin.purge` deletes accounts whose deletion request has passed its thirty
days, and clears expired sign-in and rate-limit records. It runs when somebody
presses the button on the dashboard's administration page.

That is a person remembering, which is not good enough for a promise in a
privacy notice. Until it is scheduled, put it in a cron on the host — the RPC
needs a staff session, so the honest interim is a calendar reminder rather than
a script with credentials in it.

## What this does not do

- **No zero-downtime deploy.** `docker compose up -d` restarts Nakama, which
  drops sessions for a few seconds. Clients retry, and offline play is
  unaffected — but do not deploy during a lesson.
- **No horizontal scale.** One Nakama, one Postgres. A pilot is hundreds of
  students, not thousands, and a second node would need a shared session store
  and a load balancer that understands websockets.
- **No secret manager.** Secrets live in `docker/.env.prod`, readable by root on
  the host. That is proportionate for one machine and stops being so the moment
  there are two.
