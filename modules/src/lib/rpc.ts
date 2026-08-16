/**
 * The handler wrapper.
 *
 * Every RPC goes through exactly one of these so authentication, parsing,
 * idempotency, rate limiting, error shaping, and logging are impossible to
 * forget. Idempotency in particular belongs here and not in handlers: offline
 * sync retries constantly, and making each handler responsible for its own
 * deduplication guarantees that one of them forgets — and that one
 * double-awards points.
 */

import { LenterraError, toLenterraError, unauthenticated, type ErrorCode } from './errors';
import { serverNow, type Ctx } from './ctx';
import { checkRateLimit, type RateLimit } from './ratelimit';
import { readIdempotent, writeIdempotent } from './idempotency';

export interface RpcEnvelopeOk<T> {
  ok: true;
  data: T;
}

export interface RpcEnvelopeErr {
  ok: false;
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export type Handler<Req, Res> = (c: Ctx, req: Req) => Res;

export interface RpcOptions {
  /** Handlers that are reachable before an account exists, e.g. class-code join. */
  allowUnauthenticated?: boolean;
  rateLimit?: RateLimit;
}

/**
 * Slow-handler threshold.
 *
 * goja executes synchronously, so a slow handler blocks its VM and every other
 * request queued behind it. Anything past this is logged as a warning even when
 * it succeeded — a classroom of 32 students submitting at once turns a 400 ms
 * handler into a visible stall.
 */
const SLOW_HANDLER_MS = 300;

export function rpc<Req, Res>(
  name: string,
  handler: Handler<Req, Res>,
  options?: RpcOptions,
): nkruntime.RpcFunction {
  return function (ctx, logger, nk, payload): string {
    const started = serverNow();
    const userId = ctx.userId ?? '';

    try {
      if (!userId && !(options && options.allowUnauthenticated)) {
        throw unauthenticated();
      }

      let req: Req;
      try {
        req = (payload ? JSON.parse(payload) : {}) as Req;
      } catch (_parseError) {
        throw new LenterraError('INVALID_ARGUMENT', 'Request body is not valid JSON');
      }
      if (req === null || typeof req !== 'object') {
        throw new LenterraError('INVALID_ARGUMENT', 'Request body must be an object');
      }

      const c: Ctx = { ctx, logger, nk, userId, now: started, rpc: name };

      if (options && options.rateLimit) {
        checkRateLimit(c, name, options.rateLimit);
      }

      // Replay a stored response rather than re-applying an effect. The key is
      // the client's, so a retry after a dropped connection is safe.
      const key = (req as { idempotencyKey?: unknown }).idempotencyKey;
      const idempotencyKey = typeof key === 'string' && key.length > 0 ? key : null;

      if (idempotencyKey) {
        const prior = readIdempotent(c, idempotencyKey);
        if (prior !== null) {
          logger.info('rpc %s replayed idempotent user=%s', name, userId);
          return prior;
        }
      }

      const data = handler(c, req);
      const body = JSON.stringify({ ok: true, data } as RpcEnvelopeOk<Res>);

      if (idempotencyKey) writeIdempotent(c, idempotencyKey, body);

      const elapsed = serverNow() - started;
      if (elapsed > SLOW_HANDLER_MS) {
        logger.warn('rpc %s slow user=%s ms=%d', name, userId, elapsed);
      } else {
        logger.info('rpc %s ok user=%s ms=%d', name, userId, elapsed);
      }
      return body;
    } catch (thrown) {
      const err = toLenterraError(thrown);

      // The message of an unexpected throw is deliberately dropped by
      // toLenterraError; log the original so it is diagnosable server-side
      // without ever reaching a client.
      if (err.code === 'UNAVAILABLE') {
        logger.error('rpc %s failed user=%s err=%s', name, userId, String(thrown));
      } else {
        logger.warn('rpc %s rejected user=%s code=%s', name, userId, err.code);
      }

      const envelope: RpcEnvelopeErr = {
        ok: false,
        error: err.details
          ? { code: err.code, message: err.message, details: err.details }
          : { code: err.code, message: err.message },
      };
      return JSON.stringify(envelope);
    }
  };
}
