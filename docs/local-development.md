# Local development

## Quick start

```bash
cp .env.example .env      # fill in THIRDWEB_SECRET_KEY for real sign-in
npm install
npm run build             # shared core, then the Nakama module bundle
npm test                  # core, verifier, schema
```

## What runs where

The development machine for this project is aarch64 (Jetson/Tegra). That splits
the stack in a way worth knowing before you spend an afternoon on it.

| Layer | Locally on arm64 | Notes |
|---|---|---|
| `@lenterra/core` | ✅ | Plain Node, no containers |
| Verifier | ✅ | Plain Node |
| Module bundle | ✅ builds and is statically checked | `npm run guard:bundle` |
| PostgreSQL | ✅ native arm64 | `docker compose up postgres` |
| Schema and migrations | ✅ | `npm run test:schema` |
| **Nakama** | ❌ | amd64-only image; see below |

### Why Nakama does not run here

`registry.heroiclabs.com/heroiclabs/nakama:3.22.0` publishes **amd64 only**.
With `binfmt`/`qemu-x86_64` installed, the container starts and then dies:

```
SIGSEGV: segmentation violation
runtime.netpoll(...)
    runtime/netpoll_epoll.go:166
```

This is Go's scheduler and epoll handling under QEMU user-mode emulation, not a
configuration problem, and there is no flag that fixes it. Building Nakama from
source for arm64 would work but needs a Go toolchain that is not installed here.

**So:** RPC handler and auth hook behaviour is verified in CI on amd64 runners
(`.github/workflows/ci.yml`). Everything else is verified locally. The layer
that cannot run locally is the thin glue the testing strategy already assigns to
integration tests — but it does mean a mistake in a hook costs a CI round trip
rather than a container restart, so read those diffs carefully.

If you are on an amd64 machine, `npm run dev:up` brings up the whole stack and
none of the above applies to you.

## Schema tests

They need a reachable PostgreSQL and create their own throwaway database:

```bash
docker compose -f docker/docker-compose.yml up -d postgres
npm run test:schema
```

They stand in a minimal `users` table for the one Nakama owns, holding exactly
the columns our foreign keys reference. That is enough to prove the DDL is valid
and the constraints hold. With no database reachable the tests skip rather than
fail, so `npm test` still passes on a bare checkout.

## The build loop

```bash
npm run build:core        # tsc → packages/core/dist
npm run build:modules     # rollup → modules/build/index.js
npm run guard:bundle      # fail on anything goja cannot execute
npm run guard:deps        # fail if the core grows a dependency or reads a clock
```

`guard:bundle` is worth running before every push. A transitive dependency
reaching for a Node built-in breaks Nakama at **server start**, not at compile
time, and the guard turns that into a failed check instead of a dead server.

## Seeding

```bash
npm run seed
```

One school, three classes, ninety students, six weeks of attempts. It writes
directly into `users`, which production code never does, and refuses to run
against a non-local database. It exists because the teacher dashboard cannot be
built against an empty table and there is no pilot cohort yet.
