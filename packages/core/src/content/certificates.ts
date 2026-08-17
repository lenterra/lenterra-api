/**
 * What a certificate means.
 *
 * A certificate is the one artefact from this product a student might show to
 * somebody who has never heard of it — a school, an employer, a parent. That
 * puts a hard constraint on what it is allowed to claim, so the rule lives here
 * as a pure predicate rather than inside the RPC that happens to trigger it.
 *
 * Three conditions, all necessary:
 *
 *  - every required node is **Mastered**
 *  - each has evidence from at least two distinct missions, so a single
 *    well-guessed mission cannot certify a skill
 *  - the evidence is spread over at least three distinct days
 *
 * The last one is both the easiest to drop and the one that most changes what
 * the certificate means. A student can reach 0.85 on four nodes in one evening
 * by replaying a ladder. The mastery model is not wrong about that — it is
 * answering a different question. "Learned" is not "performed once under
 * favourable conditions", and a certificate that cannot tell those apart is
 * worth nothing to the person reading it, which makes it worth nothing to the
 * student holding it.
 */

import { bandOf } from '../types/taxonomy';
import type { SkillNodeId } from '../types/taxonomy';

export interface CertificateDefinition {
  id: string;
  /** All must be Mastered. */
  requiredNodes: SkillNodeId[];
  /** Distinct missions or checks evidencing each node. */
  minEvidenceSources: number;
  /** Distinct days the evidence for each node is spread over. */
  minDistinctDays: number;
}

/**
 * The R1 set.
 *
 * Mapped to the three domains rather than to games on purpose: a certificate
 * saying "finished Congklak" would describe what a student did, not what they
 * can do, and only the second is legible to anyone outside this product.
 */
export const CERTIFICATES: readonly CertificateDefinition[] = [
  {
    id: 'cert.comp.foundations',
    requiredNodes: ['comp.counting', 'comp.arithmetic', 'comp.estimation', 'comp.modular'],
    minEvidenceSources: 2,
    minDistinctDays: 3,
  },
  {
    id: 'cert.algo.foundations',
    requiredNodes: ['algo.sequencing', 'algo.iteration', 'algo.branching', 'algo.state-eval'],
    minEvidenceSources: 2,
    minDistinctDays: 3,
  },
  {
    id: 'cert.algo.strategy',
    requiredNodes: ['algo.lookahead', 'algo.greedy', 'algo.optimization'],
    minEvidenceSources: 2,
    minDistinctDays: 3,
  },
  {
    id: 'cert.sec.foundations',
    requiredNodes: ['sec.assets', 'sec.threats', 'sec.access'],
    minEvidenceSources: 2,
    minDistinctDays: 3,
  },
  {
    id: 'cert.sec.defense',
    requiredNodes: ['sec.defense', 'sec.risk', 'sec.response'],
    minEvidenceSources: 2,
    minDistinctDays: 3,
  },
];

export function certificateById(id: string): CertificateDefinition | null {
  for (let i = 0; i < CERTIFICATES.length; i++) {
    const definition = CERTIFICATES[i] as CertificateDefinition;
    if (definition.id === id) return definition;
  }
  return null;
}

/** What is known about one node when deciding whether to certify it. */
export interface NodeEvidence {
  mastery: number;
  evidenceCount: number;
  distinctSources: number;
  distinctDays: number;
}

export type CertificateBlocker =
  | 'no_evidence'
  | 'not_mastered'
  | 'too_few_sources'
  | 'too_few_days';

export interface CertificateCheck {
  qualifies: boolean;
  /** Why not, per node. Empty when it qualifies. */
  blockedBy: { skillNodeId: SkillNodeId; reason: CertificateBlocker }[];
}

/**
 * Does this evidence earn this certificate?
 *
 * Returns *why* it does not rather than a bare boolean, so a student can be
 * shown what is left instead of a locked badge with no explanation — the same
 * reason recommendations carry their reason (P3).
 */
export function checkCertificate(
  definition: CertificateDefinition,
  evidence: Partial<Record<SkillNodeId, NodeEvidence>>,
): CertificateCheck {
  const blockedBy: CertificateCheck['blockedBy'] = [];

  for (let i = 0; i < definition.requiredNodes.length; i++) {
    const node = definition.requiredNodes[i] as SkillNodeId;
    const found = evidence[node];

    if (!found || found.evidenceCount <= 0) {
      blockedBy.push({ skillNodeId: node, reason: 'no_evidence' });
      continue;
    }
    if (bandOf(found.mastery, found.evidenceCount) !== 'mastered') {
      blockedBy.push({ skillNodeId: node, reason: 'not_mastered' });
      continue;
    }
    if (found.distinctSources < definition.minEvidenceSources) {
      blockedBy.push({ skillNodeId: node, reason: 'too_few_sources' });
      continue;
    }
    if (found.distinctDays < definition.minDistinctDays) {
      blockedBy.push({ skillNodeId: node, reason: 'too_few_days' });
    }
  }

  return { qualifies: blockedBy.length === 0, blockedBy };
}

/** Every certificate this evidence earns. */
export function certificatesEarned(
  evidence: Partial<Record<SkillNodeId, NodeEvidence>>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < CERTIFICATES.length; i++) {
    const definition = CERTIFICATES[i] as CertificateDefinition;
    if (checkCertificate(definition, evidence).qualifies) out.push(definition.id);
  }
  return out;
}
