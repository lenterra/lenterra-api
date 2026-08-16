/**
 * Persisting mastery.
 *
 * The maths lives in @lenterra/core and runs identically on the phone; this
 * module is only the part that cannot: reading current state, writing the audit
 * event, and updating the stored value in the same statement as the attempt
 * (TRD-ADPT-002).
 *
 * `lenterra_mastery_event` is append-only and is the most valuable table in the
 * schema. It lets a teacher see the evidence chain, lets the engine be re-run
 * over history after a parameter change, and lets an engine bug be repaired by
 * recomputation rather than by guesswork.
 */

import type {
  AttemptOutcome,
  EvidenceSource,
  MasteryState,
  MasteryUpdate,
  SkillNodeId,
} from '@lenterra/core';
import { applyEvidence, bandOf } from '@lenterra/core';

import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';

export const ENGINE_VERSION = '1.0.0';
export const DEFAULT_PARAMS_VERSION = 'params@v1';

export interface MasteryRow {
  skill_node_id: SkillNodeId;
  mastery: number;
  evidence_count: number;
  distinct_sources: number;
  last_evidence_ms: number | null;
}

export interface MasterySnapshot {
  state: Partial<Record<SkillNodeId, MasteryState>>;
  lastEvidenceAt: Partial<Record<SkillNodeId, number>>;
  sourceKeys: Partial<Record<SkillNodeId, string[]>>;
}

export function readMastery(c: Ctx, userId: string): MasterySnapshot {
  const rows = c.nk.sqlQuery(Q.masteryForUser, [userId]) as MasteryRow[];
  const state: Partial<Record<SkillNodeId, MasteryState>> = {};
  const lastEvidenceAt: Partial<Record<SkillNodeId, number>> = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as MasteryRow;
    state[row.skill_node_id] = {
      value: Number(row.mastery),
      evidenceCount: Number(row.evidence_count),
      distinctSources: Number(row.distinct_sources),
    };
    if (row.last_evidence_ms !== null) {
      lastEvidenceAt[row.skill_node_id] = Number(row.last_evidence_ms);
    }
  }

  // Which missions have already contributed to each node. Needed so the
  // multi-source cap (PRD-LRN-005) counts distinct *sources*, not attempts —
  // twenty replays of one easy mission must not read as mastery of the skill.
  const keyRows = c.nk.sqlQuery(Q.masterySourceKeys, [userId]) as {
    skill_node_id: SkillNodeId;
    source_key: string;
  }[];
  const sourceKeys: Partial<Record<SkillNodeId, string[]>> = {};
  for (let i = 0; i < keyRows.length; i++) {
    const row = keyRows[i] as { skill_node_id: SkillNodeId; source_key: string };
    const list = sourceKeys[row.skill_node_id] ?? [];
    list.push(row.source_key);
    sourceKeys[row.skill_node_id] = list;
  }

  return { state, lastEvidenceAt, sourceKeys };
}

export interface EvidenceRequest {
  userId: string;
  skillWeights: Partial<Record<SkillNodeId, number>>;
  outcome: AttemptOutcome;
  hintShown: boolean;
  hintUsed: boolean;
  source: EvidenceSource;
  sourceKey: string;
  sourceType: 'attempt' | 'check';
  sourceId: string;
  paramsVersion?: string;
}

export interface MasteryChangeOut {
  skillNodeId: SkillNodeId;
  before: number;
  after: number;
  band: string;
  bandChanged: boolean;
}

/**
 * Apply evidence and persist it.
 *
 * The event row and the state upsert are separate statements, which is safe
 * because both are derived from the same computed update and re-running them
 * produces the same result. The attempt row itself is what carries the
 * idempotency key, so a retry never reaches here twice.
 */
export function applyAndPersist(
  c: Ctx,
  snapshot: MasterySnapshot,
  request: EvidenceRequest,
): MasteryChangeOut[] {
  const updates = applyEvidence(snapshot.state, {
    skillWeights: request.skillWeights,
    outcome: request.outcome,
    hintShown: request.hintShown,
    hintUsed: request.hintUsed,
    source: request.source,
    sourceKey: request.sourceKey,
    priorSourceKeys: snapshot.sourceKeys,
  });

  const paramsVersion = request.paramsVersion ?? DEFAULT_PARAMS_VERSION;
  const out: MasteryChangeOut[] = [];

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i] as MasteryUpdate;

    c.nk.sqlExec(Q.masteryEventInsert, [
      c.nk.uuidv4(),
      request.userId,
      update.skillNodeId,
      request.sourceType,
      request.sourceId,
      update.before,
      update.after,
      update.weight,
      update.correct,
      ENGINE_VERSION,
      paramsVersion,
    ]);

    c.nk.sqlExec(Q.masteryUpsert, [
      request.userId,
      update.skillNodeId,
      update.after,
      update.evidenceCountAfter,
      update.distinctSourcesAfter,
      request.sourceType === 'attempt' ? request.sourceId : null,
      ENGINE_VERSION,
      paramsVersion,
    ]);

    // Keep the in-memory snapshot current so a batch of sync items sees the
    // effect of the items before it.
    snapshot.state[update.skillNodeId] = {
      value: update.after,
      evidenceCount: update.evidenceCountAfter,
      distinctSources: update.distinctSourcesAfter,
    };
    const keys = snapshot.sourceKeys[update.skillNodeId] ?? [];
    if (keys.indexOf(request.sourceKey) < 0) keys.push(request.sourceKey);
    snapshot.sourceKeys[update.skillNodeId] = keys;

    out.push({
      skillNodeId: update.skillNodeId,
      before: update.before,
      after: update.after,
      band: update.band,
      bandChanged: update.bandChanged,
    });
  }

  return out;
}

/** Bands only — the student app must be structurally incapable of a number. */
export function bandFor(state: MasteryState): string {
  return bandOf(state.value, state.evidenceCount);
}
