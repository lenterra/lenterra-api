/**
 * A fake `nk` for testing handlers without a server.
 *
 * The integration suite needs a real Nakama and a real Postgres, and Nakama
 * publishes no arm64 image — so on the machine this was written on, every
 * handler in `modules/src/rpc/` was reachable by no test at all. That is the
 * wrong place for a gap: those files are where every authorisation decision
 * lives, and an authorisation bug does not announce itself.
 *
 * **What this proves and what it does not.** It exercises handler logic — which
 * branch a role takes, which error a refusal produces, what is written and in
 * what order. It does not execute SQL, so it cannot prove a statement is valid,
 * that a predicate matches the rows intended, or that a `RETURNING` clause is
 * atomic under a race. Those are the province of `test/schema.test.mjs` against
 * real Postgres and of `test/integration/`, and this file is not a substitute
 * for either.
 *
 * **Queries are matched by identity, not by text.** A handler is bound to the
 * exact `Q.someName` constant it uses, so renaming or rewriting a query breaks
 * the test loudly instead of silently falling through to a default. A fake that
 * matched on a substring would keep passing while the handler talked to a query
 * that no longer existed, which is the specific way this kind of harness rots.
 */

import { randomUUID } from 'node:crypto';

import type { Ctx } from '../modules/src/lib/ctx.ts';

/** A canned answer for one statement. */
export type Responder = (params: readonly unknown[]) => Record<string, unknown>[];

export interface FakeOptions {
  /** Keyed by the `Q.*` constant itself. */
  queries?: Map<string, Responder>;
  userId?: string;
  now?: number;
  env?: Record<string, string>;
  /**
   * Make `nk.accountDeleteId` throw, as it does for an id Nakama does not know.
   *
   * The deletion sweep catches per-account failures on purpose — one bad row
   * must not stop the rest of a retention run — which means a fake that could
   * not fail would make that catch untestable, and a swallowed error look like
   * a success.
   */
  deleteFails?: boolean;
}

export interface Fake {
  ctx: Ctx;
  /** Nakama user ids passed to `accountDeleteId`, in order. */
  deleted: string[];
  /** Every statement that reached the fake, in order. */
  calls: { sql: string; params: readonly unknown[]; kind: 'query' | 'exec' }[];
  /** How many times one statement was issued. */
  countOf(sql: string): number;
  /** The params of the first call to one statement, or undefined. */
  paramsOf(sql: string): readonly unknown[] | undefined;
}

/**
 * Statements every handler touches incidentally.
 *
 * Rate limiting and the audit log are on the path of nearly every RPC and are
 * almost never what a test is about. Left unstubbed they would each need
 * repeating in every case; stubbed here they stay overridable, because a test
 * *about* the rate limit needs to say so.
 */
function ambientDefaults(Q: Record<string, string>): Map<string, Responder> {
  const defaults = new Map<string, Responder>();
  defaults.set(Q.rateLimitBump as string, () => [{ count: 1 }]);
  defaults.set(Q.rateLimitRead as string, () => [{ count: 0 }]);
  defaults.set(Q.rateLimitBumpExec as string, () => []);
  defaults.set(Q.auditInsert as string, () => []);
  return defaults;
}

export function fakeCtx(Q: Record<string, string>, options: FakeOptions = {}): Fake {
  const responders = ambientDefaults(Q);
  if (options.queries) {
    options.queries.forEach((responder, sql) => responders.set(sql, responder));
  }

  const calls: Fake['calls'] = [];
  const deleted: string[] = [];

  const run = (kind: 'query' | 'exec') => (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params, kind });

    const responder = responders.get(sql);
    if (!responder) {
      // Naming the statement is the whole point: the failure a fake normally
      // produces is an empty result three frames later, which reads as "the row
      // was not found" rather than "nobody said what this query returns".
      const name = Object.keys(Q).find((key) => Q[key] === sql) ?? '<not a Q constant>';
      throw new Error(
        `unstubbed statement Q.${name}\n` +
          `  A handler issued a query this test did not provide an answer for.\n` +
          `  Add it to the queries map, or assert on the refusal that should have ` +
          `happened before the handler got this far.\n\n${sql.trim().slice(0, 200)}`,
      );
    }

    const rows = responder(params);
    return kind === 'exec' ? { rowsAffected: rows.length } : rows;
  };

  const nk = {
    sqlQuery: run('query'),
    sqlExec: run('exec'),
    uuidv4: () => randomUUID(),
    stringToBinary: (value: string) => {
      const buffer = Buffer.from(value, 'utf8');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    binaryToString: (data: ArrayBuffer) => Buffer.from(data).toString('utf8'),
    base64UrlEncode: (value: string | ArrayBuffer) =>
      (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).toString(
        'base64url',
      ),
    /**
     * Deleting an account. Records rather than performs, so a test can assert
     * on *which* accounts a retention sweep removed — the number alone would
     * pass just as well if it deleted the wrong ones.
     */
    accountDeleteId: (userId: string) => {
      if (options.deleteFails) throw new Error('no such account');
      deleted.push(userId);
    },
    hmacSha256Hash: (input: string, key: string) => {
      // Only `mintGrant` reaches this, and only to prove a grant was produced.
      // `test/grant.test.mts` is where the wire format is actually checked,
      // against node:crypto on one side and the verifier on the other.
      const mac = Buffer.from(`${key}:${input}`);
      return mac.buffer.slice(mac.byteOffset, mac.byteOffset + mac.byteLength);
    },
  } as unknown as nkruntime.Nakama;

  const ctx = {
    ctx: { env: options.env ?? {} } as unknown as nkruntime.Context,
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as nkruntime.Logger,
    nk,
    userId: options.userId ?? '00000000-0000-4000-8000-000000000001',
    now: options.now ?? Date.parse('2026-03-01T09:00:00.000Z'),
    rpc: 'test',
  } as Ctx;

  return {
    ctx,
    calls,
    deleted,
    countOf: (sql) => calls.filter((call) => call.sql === sql).length,
    paramsOf: (sql) => calls.find((call) => call.sql === sql)?.params,
  };
}

/** Sugar: build the queries map without repeating `new Map` in every test. */
export function stub(entries: [string, Responder][]): Map<string, Responder> {
  return new Map(entries);
}

/** The shape a handler's thrown error has, for asserting on a refusal. */
export function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return { code: err.code ?? 'UNKNOWN', message: err.message ?? String(error) };
  }
  throw new Error('expected the handler to refuse, and it returned instead');
}
