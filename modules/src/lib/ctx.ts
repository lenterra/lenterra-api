/**
 * The handler context.
 *
 * Everything a handler is allowed to reach — the runtime, the caller, and the
 * server's own clock — arrives here rather than being read from globals.
 * `now` is captured once per request so two writes inside one handler cannot
 * land on different sides of a second boundary.
 */

import { LenterraError } from './errors';

export interface Ctx {
  ctx: nkruntime.Context;
  logger: nkruntime.Logger;
  nk: nkruntime.Nakama;
  /** Nakama user id. Never a client-supplied value. */
  userId: string;
  /** Server time, epoch milliseconds. Client clocks are informational only. */
  now: number;
  /** The RPC name, for logging and idempotency records. */
  rpc: string;
}

/**
 * Server time.
 *
 * Every timestamp that matters is generated here or by Postgres `now()`. A
 * device clock can be wrong by hours — students set them, phones are shared,
 * and an offline batch can arrive days later — so client times are stored for
 * diagnosis and never used for ordering or scoring (20-09).
 */
export function serverNow(): number {
  return Date.now();
}

export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Whole days between two epoch-millisecond instants, in UTC. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / 86400000);
}

/** UTC calendar date, for streak crediting. */
export function utcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function requireString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LenterraError('INVALID_ARGUMENT', `${field} is required`);
  }
  if (value.length > maxLength) {
    throw new LenterraError('INVALID_ARGUMENT', `${field} is too long`);
  }
  return value;
}

export function optionalString(value: unknown, field: string, maxLength = 512): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, maxLength);
}

export function requireInt(value: unknown, field: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
    throw new LenterraError('INVALID_ARGUMENT', `${field} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new LenterraError('INVALID_ARGUMENT', `${field} must be at least ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new LenterraError('INVALID_ARGUMENT', `${field} must be at most ${max}`);
  }
  return value;
}

export function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LenterraError('INVALID_ARGUMENT', `${field} must be a boolean`);
  }
  return value;
}

export function requireArray<T>(value: unknown, field: string, maxLength: number): T[] {
  if (Object.prototype.toString.call(value) !== '[object Array]') {
    throw new LenterraError('INVALID_ARGUMENT', `${field} must be an array`);
  }
  const array = value as T[];
  if (array.length > maxLength) {
    throw new LenterraError('INVALID_ARGUMENT', `${field} may hold at most ${maxLength} items`);
  }
  return array;
}
