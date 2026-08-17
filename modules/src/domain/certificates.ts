/**
 * Issuing certificates.
 *
 * The rule — what a certificate is allowed to mean — lives in `@lenterra/core`
 * as a pure predicate. This is the part that cannot be pure: reading the
 * evidence spread, writing the record, and awarding the points.
 *
 * Issuance is server-side, automatic and idempotent. Nothing a client sends can
 * trigger it.
 */

import type { SkillNodeId } from '@lenterra/core';
import { CERTIFICATES, checkCertificate, type NodeEvidence } from '@lenterra/core';

import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import type { MasterySnapshot } from './mastery';
import { award, POINTS } from './ledger';

export { CERTIFICATES };

/**
 * The snapshot stored with the certificate.
 *
 * Kept because a certificate has to be able to state its own limits
 * (PRD-RWD-013): how many attempts stand behind it and over what period. One
 * that can only say "issued" is asking to be over-read by whoever it is shown
 * to, which is exactly the person it must not mislead.
 */
export interface CertificateEvidence {
  nodes: {
    skillNodeId: string;
    mastery: number;
    distinctSources: number;
    distinctDays: number;
    validatedAttempts: number;
  }[];
  totalValidatedAttempts: number;
  earliestEvidenceMs: number;
  latestEvidenceMs: number;
  engineVersion: string;
}

interface Spread {
  days: number;
  events: number;
  firstMs: number;
  lastMs: number;
}

const NO_SPREAD: Spread = { days: 0, events: 0, firstMs: 0, lastMs: 0 };

function spreadFor(c: Ctx, nodes: readonly SkillNodeId[]): Record<string, Spread> {
  const rows = c.nk.sqlQuery(Q.masteryEvidenceSpread, [c.userId, nodes]) as {
    skill_node_id: string;
    days: number;
    events: number;
    first_ms: number;
    last_ms: number;
  }[];

  const out: Record<string, Spread> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as {
      skill_node_id: string;
      days: number;
      events: number;
      first_ms: number;
      last_ms: number;
    };
    out[row.skill_node_id] = {
      days: Number(row.days),
      events: Number(row.events),
      firstMs: Number(row.first_ms),
      lastMs: Number(row.last_ms),
    };
  }
  return out;
}

/**
 * Issue every certificate the student now qualifies for.
 *
 * Called after mastery is written, so it sees the state this attempt produced.
 * Returns only what was newly issued.
 */
export function issueEarned(
  c: Ctx,
  snapshot: MasterySnapshot,
  engineVersion: string,
): string[] {
  const issued: string[] = [];

  for (let i = 0; i < CERTIFICATES.length; i++) {
    const definition = CERTIFICATES[i] as (typeof CERTIFICATES)[number];

    // Cheap pre-filter on what the snapshot already holds, so a query only
    // runs for a student whose mastery and source counts could qualify. The
    // day spread is the one fact the snapshot cannot answer.
    const preliminary: Partial<Record<SkillNodeId, NodeEvidence>> = {};
    for (let n = 0; n < definition.requiredNodes.length; n++) {
      const node = definition.requiredNodes[n] as SkillNodeId;
      const state = snapshot.state[node];
      if (!state) continue;
      preliminary[node] = {
        mastery: state.value,
        evidenceCount: state.evidenceCount,
        distinctSources: state.distinctSources,
        // Assume the day condition holds for the pre-filter; it is checked for
        // real below. Assuming the other way round would cost a query per
        // certificate on every attempt for nothing.
        distinctDays: definition.minDistinctDays,
      };
    }
    if (!checkCertificate(definition, preliminary).qualifies) continue;

    const spread = spreadFor(c, definition.requiredNodes);

    const evidenceByNode: Partial<Record<SkillNodeId, NodeEvidence>> = {};
    const nodes: CertificateEvidence['nodes'] = [];
    let attempts = 0;
    let earliest = 0;
    let latest = 0;

    for (let n = 0; n < definition.requiredNodes.length; n++) {
      const node = definition.requiredNodes[n] as SkillNodeId;
      const state = snapshot.state[node];
      if (!state) continue;
      const found = spread[node] ?? NO_SPREAD;

      evidenceByNode[node] = {
        mastery: state.value,
        evidenceCount: state.evidenceCount,
        distinctSources: state.distinctSources,
        distinctDays: found.days,
      };
      nodes.push({
        skillNodeId: node,
        mastery: state.value,
        distinctSources: state.distinctSources,
        distinctDays: found.days,
        validatedAttempts: found.events,
      });
      attempts += found.events;
      earliest = earliest === 0 ? found.firstMs : Math.min(earliest, found.firstMs);
      latest = Math.max(latest, found.lastMs);
    }

    if (!checkCertificate(definition, evidenceByNode).qualifies) continue;

    const body = JSON.stringify({
      nodes,
      totalValidatedAttempts: attempts,
      earliestEvidenceMs: earliest,
      latestEvidenceMs: latest,
      engineVersion,
    } satisfies CertificateEvidence);

    const rows = c.nk.sqlExec(Q.certificateInsert, [
      c.nk.uuidv4(),
      c.userId,
      definition.id,
      body,
      // Hashing the snapshot is what will later let a third party check that a
      // displayed certificate matches what was issued, without re-deriving it
      // from an evidence chain that mastery decay will have moved on from
      // (PRD-RWD-014 builds on this).
      c.nk.sha256Hash(body),
    ]);

    if (rows.rowsAffected > 0) {
      issued.push(definition.id);
      award(
        c,
        c.userId,
        POINTS.certificate,
        'certificate.issued',
        'certificate',
        null,
        `certificate:${c.userId}:${definition.id}`,
      );
    }
  }

  return issued;
}
