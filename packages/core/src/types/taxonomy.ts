/**
 * The skill taxonomy: 3 domains, 17 nodes (10-03).
 *
 * Labels and descriptions are *content* — they live in the catalog and can be
 * edited without an app release. The **IDs** are not content:
 * they key stored mastery, so an ID may be retired but never renamed or
 * reused. They are declared here as types precisely so a rename becomes a
 * compile error rather than a silent data corruption.
 */

export type SkillDomainId = 'computation' | 'algorithms' | 'security';

export const SKILL_DOMAIN_IDS: readonly SkillDomainId[] = [
  'computation',
  'algorithms',
  'security',
];

export type ComputationNodeId =
  | 'comp.counting'
  | 'comp.arithmetic'
  | 'comp.estimation'
  | 'comp.modular';

export type AlgorithmsNodeId =
  | 'algo.sequencing'
  | 'algo.iteration'
  | 'algo.branching'
  | 'algo.state-eval'
  | 'algo.lookahead'
  | 'algo.greedy'
  | 'algo.optimization';

export type SecurityNodeId =
  | 'sec.assets'
  | 'sec.threats'
  | 'sec.access'
  | 'sec.defense'
  | 'sec.risk'
  | 'sec.response';

export type SkillNodeId = ComputationNodeId | AlgorithmsNodeId | SecurityNodeId;

export const SKILL_NODE_IDS: readonly SkillNodeId[] = [
  'comp.counting',
  'comp.arithmetic',
  'comp.estimation',
  'comp.modular',
  'algo.sequencing',
  'algo.iteration',
  'algo.branching',
  'algo.state-eval',
  'algo.lookahead',
  'algo.greedy',
  'algo.optimization',
  'sec.assets',
  'sec.threats',
  'sec.access',
  'sec.defense',
  'sec.risk',
  'sec.response',
];

/** Domain of a node, derived from its ID prefix rather than a second table. */
export function domainOf(nodeId: SkillNodeId): SkillDomainId {
  const prefix = nodeId.slice(0, nodeId.indexOf('.'));
  if (prefix === 'comp') return 'computation';
  if (prefix === 'algo') return 'algorithms';
  return 'security';
}

export function isSkillNodeId(value: string): value is SkillNodeId {
  return SKILL_NODE_IDS.indexOf(value as SkillNodeId) >= 0;
}

export function nodesInDomain(domain: SkillDomainId): SkillNodeId[] {
  const out: SkillNodeId[] = [];
  for (let i = 0; i < SKILL_NODE_IDS.length; i++) {
    const node = SKILL_NODE_IDS[i] as SkillNodeId;
    if (domainOf(node) === domain) out.push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mastery bands
// ---------------------------------------------------------------------------

export type MasteryBand = 'not_started' | 'emerging' | 'developing' | 'proficient' | 'mastered';

export const MASTERY_BAND_FLOOR: Record<Exclude<MasteryBand, 'not_started'>, number> = {
  emerging: 0.0,
  developing: 0.4,
  proficient: 0.7,
  mastered: 0.85,
};

/**
 * Band for a mastery value.
 *
 * `evidenceCount === 0` is 'not_started' regardless of the value: a student
 * carrying only the prior (pInit = 0.15) has not started, and rendering that
 * as "Baru mulai" would claim evidence that does not exist.
 *
 * One implementation, used by the student app, the teacher heatmap, and the
 * certificate check alike. Three implementations would drift.
 */
export function bandOf(mastery: number, evidenceCount: number): MasteryBand {
  if (evidenceCount <= 0) return 'not_started';
  if (mastery >= MASTERY_BAND_FLOOR.mastered) return 'mastered';
  if (mastery >= MASTERY_BAND_FLOOR.proficient) return 'proficient';
  if (mastery >= MASTERY_BAND_FLOOR.developing) return 'developing';
  return 'emerging';
}

/** Ordering for comparisons like "did this attempt move the band up?" */
export const MASTERY_BAND_ORDER: readonly MasteryBand[] = [
  'not_started',
  'emerging',
  'developing',
  'proficient',
  'mastered',
];

export function bandRank(band: MasteryBand): number {
  return MASTERY_BAND_ORDER.indexOf(band);
}
