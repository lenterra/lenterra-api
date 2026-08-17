/**
 * The goja half of the cross-runtime conformance suite (TRD-TEST-002).
 *
 * **A test seam, and it says so.** This handler exists only to run replay
 * fixtures through the shared core inside the runtime that actually validates
 * student attempts, and compare the answers with the ones Node produced. There
 * is no other way to do that: goja is embedded in Nakama, it cannot be driven
 * from a unit test, and a divergence between it and Hermes does not surface as
 * a crash — it surfaces as the server telling honest students their work does
 * not count.
 *
 * Three properties keep it from being a hole:
 *
 *  - It is registered only when `CONFORMANCE_ENABLED` is exactly `'1'`, so a
 *    production server does not have the RPC at all rather than having it
 *    behind a check.
 *  - It reads nothing and writes nothing. No database, no user, no state — it
 *    takes replays in the request and returns verdicts. There is nothing here
 *    for an attacker who reaches it.
 *  - `InitModule` logs loudly when it is on, so a server running with it
 *    enabled says so in its first ten lines rather than being discovered.
 */

import { invalidArgument } from '../lib/errors';
import { requireArray, type Ctx } from '../lib/ctx';
import { engineFor, validateReplay, type Mission, type Replay } from '@lenterra/core';

export interface ConformanceReq {
  /** Chunked by the caller — a whole fixture set in one payload is megabytes. */
  cases: { id: string; mission: Mission; replay: Replay; twoPlayer?: boolean }[];
}

export interface ConformanceVerdict {
  id: string;
  valid: boolean;
  reason: string | null;
  outcome: string | null;
  suspicious: boolean | null;
  derivedMetrics: unknown;
}

/** How many fixtures one call may carry. goja is synchronous; a huge batch stalls its VM. */
const MAX_CASES = 50;

export function devConformance(c: Ctx, req: ConformanceReq): { verdicts: ConformanceVerdict[] } {
  const cases = requireArray<ConformanceReq['cases'][number]>(req.cases, 'cases', MAX_CASES);

  const verdicts: ConformanceVerdict[] = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[i] as ConformanceReq['cases'][number];
    if (!item || !item.mission || !item.replay) throw invalidArgument('each case needs a mission and a replay');

    const engine = engineFor(item.mission.game);
    if (!engine) throw invalidArgument(`no engine for ${item.mission.game}`);

    const result = validateReplay(
      item.replay,
      item.mission,
      engine as never,
      item.twoPlayer === true,
    );

    verdicts.push({
      id: item.id,
      valid: result.valid,
      reason: result.valid ? null : result.reason,
      outcome: result.valid ? result.outcome : (result.actualOutcome ?? null),
      suspicious: result.valid ? result.suspicious : null,
      derivedMetrics: result.valid ? result.derivedMetrics : null,
    });
  }

  c.logger.info('conformance batch of %d evaluated', verdicts.length);
  return { verdicts };
}
