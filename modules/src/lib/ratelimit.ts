/**
 * Fixed-window rate limiting (20-04 "Rate limits").
 *
 * The limits exist to stop brute force and runaway retries, not to shape
 * traffic, so a fixed window is sufficient and far cheaper than a sliding one
 * inside a synchronous VM.
 *
 * The class-join limit is the one that matters most: a six-character code from
 * a 26-symbol alphabet is guessable in bulk, and the thing behind it is a list
 * of children.
 */

import { rateLimited } from './errors';
import type { Ctx } from './ctx';
import { Q } from '../db/queries';

export interface RateLimit {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
  /**
   * Count only rejected calls. Used for class-join, where legitimate students
   * retry a mistyped code and only failures indicate an attack.
   */
  failuresOnly?: boolean;
}

export const LIMITS: Record<string, RateLimit> = {
  'v1.class.join': { limit: 5, windowSeconds: 600, failuresOnly: true },
  // Reachable with no account at all, so this one is counted rather than
  // failures-only: an unauthenticated handler that only counts its failures
  // can be called without limit as long as the caller holds one valid code.
  'v1.class.grant': { limit: 20, windowSeconds: 600 },
  // Tighter than the class limits in both directions. A staff code is longer
  // and single-use, so a legitimate holder needs one or two attempts, while
  // what is behind it is authority over a school's children rather than a seat
  // in one class.
  'v1.staff.join': { limit: 3, windowSeconds: 600, failuresOnly: true },
  'v1.staff.grant': { limit: 10, windowSeconds: 600 },
  // Adding an email happens once per account. Anything beyond a handful of
  // attempts is somebody working through a list of addresses.
  'v1.account.upgrade': { limit: 5, windowSeconds: 3600 },
  'v1.attempt.submit': { limit: 60, windowSeconds: 60 },
  'v1.sync.push': { limit: 20, windowSeconds: 60 },
  'v1.catalog.pull': { limit: 30, windowSeconds: 3600 },
  'v1.teacher.class.summary': { limit: 60, windowSeconds: 60 },
  'v1.friend.searchByCode': { limit: 20, windowSeconds: 60 },
  // Tight, because both are identity-adjacent in opposite directions: deleting
  // an account is irreversible, and a report queue that can be flooded is a
  // queue in which the real report is the one nobody reaches.
  'v1.account.delete.request': { limit: 3, windowSeconds: 3600 },
  'v1.moderation.report': { limit: 10, windowSeconds: 3600 },
};

function windowStart(now: number, windowSeconds: number): string {
  const bucketMs = windowSeconds * 1000;
  return new Date(Math.floor(now / bucketMs) * bucketMs).toISOString();
}

/**
 * @param subject Overrides the caller's user id. The class-join limit keys on a
 *   device identifier because it is reachable before an account exists.
 */
export function checkRateLimit(c: Ctx, name: string, limit: RateLimit, subject?: string): void {
  if (limit.failuresOnly) return; // counted by recordFailure instead

  const bucket = `${name}:${subject ?? c.userId}`;
  const start = windowStart(c.now, limit.windowSeconds);

  const rows = c.nk.sqlQuery(Q.rateLimitBump, [bucket, start]);
  const count = rows.length > 0 ? Number((rows[0] as { count: number }).count) : 1;

  if (count > limit.limit) {
    const bucketMs = limit.windowSeconds * 1000;
    const retryAfterMs = bucketMs - (c.now % bucketMs);
    throw rateLimited(retryAfterMs);
  }
}

/** Count a failed attempt against a failures-only limit. */
export function recordFailure(c: Ctx, name: string, subject: string): void {
  const limit = LIMITS[name];
  if (!limit) return;

  const bucket = `${name}:fail:${subject}`;
  const start = windowStart(c.now, limit.windowSeconds);
  c.nk.sqlExec(Q.rateLimitBumpExec, [bucket, start]);
}

/** Throw if a failures-only limit has already been exceeded. */
export function assertFailureBudget(c: Ctx, name: string, subject: string): void {
  const limit = LIMITS[name];
  if (!limit || !limit.failuresOnly) return;

  const bucket = `${name}:fail:${subject}`;
  const start = windowStart(c.now, limit.windowSeconds);

  const rows = c.nk.sqlQuery(Q.rateLimitRead, [bucket, start]);
  const count = rows.length > 0 ? Number((rows[0] as { count: number }).count) : 0;

  if (count >= limit.limit) {
    const bucketMs = limit.windowSeconds * 1000;
    throw rateLimited(bucketMs - (c.now % bucketMs));
  }
}
