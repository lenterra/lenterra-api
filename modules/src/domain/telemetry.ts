/**
 * Telemetry (TRD-OBS-001 … -004).
 *
 * The table and the insert existed from the first migration and nothing ever
 * called them, which meant every SMART target in 00-05 was unmeasured while the
 * features they describe were shipping. TRD-TEST-004 says a feature ships with
 * its telemetry; this is the half that makes that possible.
 *
 * Two properties are structural rather than conventions to remember:
 *
 *  - **An event can never fail a request.** Every emit is wrapped, and a
 *    failure increments a drop counter instead of propagating. A student
 *    losing a validated attempt because a metrics insert deadlocked would be
 *    an absurd trade.
 *  - **Props cannot carry PII.** Values are restricted to scalars and the
 *    known-unsafe key names are rejected outright, so the rule is enforced at
 *    the one place events are written rather than asked of every call site.
 *
 * Identity is carried by `user_id` alone, resolvable only inside the database.
 */

import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';

export type EventProps = Record<string, string | number | boolean | null>;

/**
 * Key names that must never appear in an event.
 *
 * Matched as substrings, so `studentEmail` and `email_address` are both caught.
 * This is a backstop, not the primary control — the primary control is that
 * every call site below passes ids and enums.
 */
const FORBIDDEN_KEY_PARTS = [
  'name',
  'email',
  'phone',
  'address',
  'wallet',
  'lat',
  'lng',
  'location',
  'device_id',
  'deviceid',
  'ip',
  'token',
  'secret',
  'code',
];

/** Keys that read as forbidden but are safe, because they are opaque ids. */
const ALLOWED_EXACT = ['missionId', 'skillNodeId', 'definitionId', 'achievementId', 'classId'];

let dropped = 0;

/** How many events were lost. Surfaced by the admin health check. */
export function droppedEvents(): number {
  return dropped;
}

export function isSafeKey(key: string): boolean {
  if (ALLOWED_EXACT.indexOf(key) >= 0) return true;
  const lower = key.toLowerCase();
  for (let i = 0; i < FORBIDDEN_KEY_PARTS.length; i++) {
    if (lower.indexOf(FORBIDDEN_KEY_PARTS[i] as string) >= 0) return false;
  }
  return true;
}

/**
 * Strip anything that must not be stored.
 *
 * Dropping the offending key rather than the whole event keeps the metric
 * usable while still refusing the value — losing a whole day of `attempt.validated`
 * because one call site added a bad prop would be the wrong failure.
 */
export function sanitize(props: EventProps): EventProps {
  const out: EventProps = {};
  const keys = Object.keys(props);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (!isSafeKey(key)) continue;
    const value = props[key];
    const type = typeof value;
    if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
      // Long strings are where free text hides. Ids and enums are short.
      if (type === 'string' && (value as string).length > 128) continue;
      out[key] = value as string | number | boolean | null;
    }
  }
  return out;
}

/**
 * Record a server-side event.
 *
 * Server-emitted wherever possible, so an offline or hostile client cannot
 * distort a metric by simply not sending one.
 */
export function emit(c: Ctx, name: string, props: EventProps, userId?: string): void {
  try {
    c.nk.sqlExec(Q.eventInsert, [
      userId ?? c.userId,
      name,
      JSON.stringify(sanitize(props)),
      new Date(c.now).toISOString(),
      null,
      null,
    ]);
  } catch (err) {
    // Deliberately swallowed. See the header: a metric is never worth a
    // student's work. The counter is what stops this being silent.
    dropped += 1;
    c.logger.warn('event insert failed: %s', String(err));
  }
}

/**
 * Record a client-reported event arriving through the outbox.
 *
 * `deviceSeq` is preserved because these can arrive two weeks late and out of
 * order, and ordering them by arrival time would misrepresent the session they
 * came from.
 */
export function emitClient(
  c: Ctx,
  name: string,
  props: EventProps,
  occurredAt: string,
  deviceSeq: number | null,
  clientVersion: string | null,
): void {
  try {
    c.nk.sqlExec(Q.eventInsert, [
      c.userId,
      name,
      JSON.stringify(sanitize(props)),
      occurredAt,
      deviceSeq,
      clientVersion,
    ]);
  } catch (err) {
    dropped += 1;
    c.logger.warn('client event insert failed: %s', String(err));
  }
}
