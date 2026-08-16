/**
 * Idempotent response replay.
 *
 * A client that loses its connection mid-request has no way to know whether the
 * write landed. Under offline-first sync that happens constantly, so the
 * contract is: send the same key, get the same answer, and the effect happens
 * once.
 */

import { LenterraError } from './errors';
import type { Ctx } from './ctx';
import { Q } from '../db/queries';

/** Stored responses live 30 days — longer than any plausible offline window. */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

export function readIdempotent(c: Ctx, key: string): string | null {
  const rows = c.nk.sqlQuery(Q.idempotencyRead, [key, c.userId]);
  if (rows.length === 0) return null;

  const row = rows[0] as { response: unknown; rpc: string };

  // A key reused across different RPCs is a client bug, and replaying the
  // wrong response would be worse than failing: the client would treat a
  // points award as a mission result.
  if (row.rpc !== c.rpc) {
    throw new LenterraError('INVALID_ARGUMENT', 'This idempotency key was used for another call');
  }

  return typeof row.response === 'string' ? row.response : JSON.stringify(row.response);
}

export function writeIdempotent(c: Ctx, key: string, body: string): void {
  // ON CONFLICT DO NOTHING: two concurrent retries race here, and the loser
  // simply keeps the winner's stored response.
  c.nk.sqlExec(Q.idempotencyWrite, [key, c.userId, c.rpc, body]);
}
