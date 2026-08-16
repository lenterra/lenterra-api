/**
 * Coded errors (20-04).
 *
 * Handlers never throw across the RPC boundary. A thrown error surfaces as an
 * opaque server error, and a client on a bus with one bar of signal cannot tell
 * "your session expired" from "the server is broken" — one means re-
 * authenticate and keep the outbox, the other means back off and retry. Every
 * failure carries a stable code so the client can tell them apart.
 */

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CATALOG_STALE'
  | 'UNAVAILABLE';

export class LenterraError {
  public readonly name = 'LenterraError';
  public readonly code: ErrorCode;
  public readonly message: string;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    this.code = code;
    this.message = message;
    this.details = details;
  }
}

export function isLenterraError(value: unknown): value is LenterraError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: string }).name === 'LenterraError'
  );
}

/**
 * Normalise anything thrown into a coded error.
 *
 * An unexpected throw becomes UNAVAILABLE rather than leaking its message: a
 * SQL error text can name columns and constraints, and the client has no use
 * for it beyond deciding whether to retry.
 */
export function toLenterraError(value: unknown): LenterraError {
  if (isLenterraError(value)) return value;
  return new LenterraError('UNAVAILABLE', 'The server could not complete this request');
}

export function unauthenticated(message?: string): LenterraError {
  return new LenterraError('UNAUTHENTICATED', message ?? 'Sign-in required');
}

export function forbidden(message?: string): LenterraError {
  return new LenterraError('FORBIDDEN', message ?? 'Not permitted');
}

export function notFound(message?: string): LenterraError {
  return new LenterraError('NOT_FOUND', message ?? 'Not found');
}

export function invalidArgument(
  message: string,
  details?: Record<string, unknown>,
): LenterraError {
  return new LenterraError('INVALID_ARGUMENT', message, details);
}

export function conflict(reason: string, message?: string): LenterraError {
  return new LenterraError('CONFLICT', message ?? 'Conflicting state', { reason });
}

export function rateLimited(retryAfterMs: number): LenterraError {
  return new LenterraError('RATE_LIMITED', 'Too many requests', { retryAfterMs });
}

export function catalogStale(currentVersion: string): LenterraError {
  return new LenterraError('CATALOG_STALE', 'Your content is out of date', { currentVersion });
}
