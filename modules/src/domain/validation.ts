/**
 * Server-side replay validation.
 *
 * The client scores an attempt provisionally so a student on a bus gets
 * immediate feedback; this decides what it was actually worth. They agree
 * because it is the same function on both sides, not because the client is
 * trusted (P4).
 *
 * An attempt that fails validation is still *recorded* — with its rejection
 * reason and no effects. Discarding it would hide the one signal that says
 * whether rejections are a client bug, a version skew, or someone cheating
 * (metric M-S01).
 */

import type { Mission, Replay, ValidationResult } from '@lenterra/core';
import { engineFor, validateReplay } from '@lenterra/core';

import type { Ctx } from '../lib/ctx';

export interface ValidationOutcome {
  result: ValidationResult;
  /** What to store in `validation_status`. */
  status: 'validated' | 'rejected';
  rejectionReason: string | null;
}

export function validate(c: Ctx, mission: Mission, replay: Replay): ValidationOutcome {
  // Validate under the engine version the replay declares, not the current one.
  // A phone that played offline for six days under 1.2 must not be judged by
  // 1.3's rules — that would reject exactly the students the offline design
  // exists to serve (TRD-ENG-007).
  const engine = engineFor(mission.game, replay.engineVersion);

  if (!engine) {
    c.logger.warn(
      'replay declares unsupported engine game=%s version=%s',
      mission.game,
      replay.engineVersion,
    );
    return {
      result: { valid: false, reason: 'core_version_unsupported' },
      status: 'rejected',
      rejectionReason: 'core_version_unsupported',
    };
  }

  const result = validateReplay(replay, mission, engine as never);

  if (!result.valid) {
    return { result, status: 'rejected', rejectionReason: result.reason };
  }

  if (result.suspicious) {
    // Flagged, never penalised. A legal replay submitted by a script is legal;
    // timing is the only signal separating it from play, and it is weak enough
    // that it must inform a human rather than trigger a sanction.
    c.logger.warn(
      'attempt flagged suspicious user=%s mission=%s reasons=%s',
      c.userId,
      mission.id,
      result.suspicionReasons.join(','),
    );
  }

  return { result, status: 'validated', rejectionReason: null };
}

/**
 * Narrow an untrusted payload into a Replay.
 *
 * Shape only — the engine decides whether the moves make sense.
 */
export function parseReplay(value: unknown): Replay | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Partial<Replay>;

  if (typeof raw.gameId !== 'string') return null;
  if (typeof raw.missionId !== 'string') return null;
  if (typeof raw.missionContentVersion !== 'number') return null;
  if (typeof raw.engineVersion !== 'string') return null;
  if (typeof raw.configHash !== 'string') return null;
  if (typeof raw.seed !== 'number') return null;
  if (typeof raw.finalStateHash !== 'string') return null;
  if (Object.prototype.toString.call(raw.moves) !== '[object Array]') return null;

  const outcome = raw.claimedOutcome;
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'abandoned') return null;

  return raw as Replay;
}
