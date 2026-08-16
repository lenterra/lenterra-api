/**
 * Applying evidence to mastery.
 *
 * The single place where an attempt outcome becomes a set of mastery changes.
 * The server calls it inside `v1.attempt.submit`; the client calls it to render
 * a provisional result while offline. One implementation, so a provisional
 * result and the authoritative one can only differ if the *inputs* differ —
 * which is the divergence worth investigating, and the one telemetry looks for.
 *
 * Pure: it takes current state and returns new state. Persistence and event
 * writing belong to the caller (TRD-ADPT-002).
 */

import type { SkillNodeId, MasteryBand } from '../types/taxonomy';
import { bandOf, bandRank, domainOf } from '../types/taxonomy';
import type { AttemptOutcome, MasteryChange } from '../types/attempt';
import {
  applyMasteryCaps,
  bktUpdateWeighted,
  effectiveWeight,
  DEFAULT_BKT_PARAMS,
  DOMAIN_PRIORS,
  type BktParams,
  type EvidenceSource,
} from './bkt';

export interface MasteryState {
  value: number;
  evidenceCount: number;
  /** Count of distinct mission or check IDs that have contributed. */
  distinctSources: number;
}

export interface EvidenceInput {
  /** Weights declared by the mission or check. */
  skillWeights: Partial<Record<SkillNodeId, number>>;
  outcome: AttemptOutcome;
  hintShown: boolean;
  hintUsed: boolean;
  source: EvidenceSource;
  /** Source identifier — mission ID or check ID — for the distinct-source count. */
  sourceKey: string;
  /** Source keys that have already contributed to each node. */
  priorSourceKeys: Partial<Record<SkillNodeId, string[]>>;
}

export interface MasteryUpdate extends MasteryChange {
  weight: number;
  correct: boolean;
  evidenceCountAfter: number;
  distinctSourcesAfter: number;
}

/** Per-node parameters, falling back to the domain prior then the global default. */
export function paramsFor(
  node: SkillNodeId,
  overrides?: Partial<Record<SkillNodeId, Partial<BktParams>>>,
): BktParams {
  const domainPrior = DOMAIN_PRIORS[domainOf(node)];
  const base: BktParams = {
    pInit: domainPrior,
    pTransit: DEFAULT_BKT_PARAMS.pTransit,
    pSlip: DEFAULT_BKT_PARAMS.pSlip,
    pGuess: DEFAULT_BKT_PARAMS.pGuess,
  };
  const override = overrides ? overrides[node] : undefined;
  if (!override) return base;
  return {
    pInit: override.pInit ?? base.pInit,
    pTransit: override.pTransit ?? base.pTransit,
    pSlip: override.pSlip ?? base.pSlip,
    pGuess: override.pGuess ?? base.pGuess,
  };
}

/** Starting mastery for a node with no record yet. */
export function initialMastery(
  node: SkillNodeId,
  overrides?: Partial<Record<SkillNodeId, Partial<BktParams>>>,
): MasteryState {
  return { value: paramsFor(node, overrides).pInit, evidenceCount: 0, distinctSources: 0 };
}

/**
 * Turn one attempt into mastery changes, one per weighted node.
 *
 * An 'abandoned' attempt produces no changes at all. It is not evidence of
 * failure — the student stopped, which happens when a borrowed phone goes back
 * to its owner mid-mission. Scoring it as a failure would systematically
 * understate exactly the students this product exists for.
 */
export function applyEvidence(
  current: Partial<Record<SkillNodeId, MasteryState>>,
  evidence: EvidenceInput,
  overrides?: Partial<Record<SkillNodeId, Partial<BktParams>>>,
): MasteryUpdate[] {
  if (evidence.outcome === 'abandoned') return [];

  const correct = evidence.outcome === 'success';
  const updates: MasteryUpdate[] = [];

  // Sorted so the resulting event order is identical on client and server.
  const nodes = Object.keys(evidence.skillWeights).sort() as SkillNodeId[];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as SkillNodeId;
    const skillWeight = evidence.skillWeights[node] ?? 0;
    if (skillWeight <= 0) continue;

    const params = paramsFor(node, overrides);
    const state = current[node] ?? initialMastery(node, overrides);

    const weight = effectiveWeight(
      skillWeight,
      evidence.hintShown,
      evidence.hintUsed,
      evidence.source,
    );

    const priorKeys = evidence.priorSourceKeys[node] ?? [];
    const isNewSource = priorKeys.indexOf(evidence.sourceKey) < 0;
    const distinctSourcesAfter = state.distinctSources + (isNewSource ? 1 : 0);
    const evidenceCountAfter = state.evidenceCount + 1;

    const raw = bktUpdateWeighted(state.value, correct, params, weight);
    const after = applyMasteryCaps(raw, distinctSourcesAfter, evidenceCountAfter);

    const bandBefore = bandOf(state.value, state.evidenceCount);
    const bandAfter = bandOf(after, evidenceCountAfter);

    updates.push({
      skillNodeId: node,
      before: state.value,
      after,
      band: bandAfter,
      bandChanged: bandBefore !== bandAfter,
      weight,
      correct,
      evidenceCountAfter,
      distinctSourcesAfter,
    });
  }

  return updates;
}

/**
 * Replay a full evidence history from scratch (PRD-LRN-003).
 *
 * This is what makes an engine bug recoverable by recomputation rather than by
 * guesswork, and what TRD-ADPT-001's 1e-9 reproducibility assertion tests.
 */
export function recomputeMastery(
  history: EvidenceInput[],
  overrides?: Partial<Record<SkillNodeId, Partial<BktParams>>>,
): Record<string, MasteryState> {
  const state: Partial<Record<SkillNodeId, MasteryState>> = {};
  const sourceKeys: Partial<Record<SkillNodeId, string[]>> = {};

  for (let i = 0; i < history.length; i++) {
    const evidence = history[i] as EvidenceInput;
    const updates = applyEvidence(state, { ...evidence, priorSourceKeys: sourceKeys }, overrides);

    for (let j = 0; j < updates.length; j++) {
      const update = updates[j] as MasteryUpdate;
      state[update.skillNodeId] = {
        value: update.after,
        evidenceCount: update.evidenceCountAfter,
        distinctSources: update.distinctSourcesAfter,
      };
      const keys = sourceKeys[update.skillNodeId] ?? [];
      if (keys.indexOf(evidence.sourceKey) < 0) keys.push(evidence.sourceKey);
      sourceKeys[update.skillNodeId] = keys;
    }
  }

  return state as Record<string, MasteryState>;
}

/**
 * Weighted roll-up for a domain.
 *
 * Mastery is never *stored* at domain level (10-03) — a domain figure is
 * always computed on read, so it cannot drift from the nodes beneath it.
 */
export function domainRollup(
  nodes: SkillNodeId[],
  mastery: Partial<Record<SkillNodeId, MasteryState>>,
): { value: number; band: MasteryBand; evidenceCount: number } {
  let total = 0;
  let evidence = 0;
  let counted = 0;

  for (let i = 0; i < nodes.length; i++) {
    const state = mastery[nodes[i] as SkillNodeId];
    if (!state) continue;
    total += state.value;
    evidence += state.evidenceCount;
    counted++;
  }

  const value = counted === 0 ? 0 : total / counted;
  return { value, band: bandOf(value, evidence), evidenceCount: evidence };
}

/** Did this set of updates move any band upward? Drives the celebration moment. */
export function highestBandGain(updates: MasteryUpdate[]): MasteryUpdate | null {
  let best: MasteryUpdate | null = null;
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i] as MasteryUpdate;
    if (!update.bandChanged) continue;
    if (bandRank(update.band) <= bandRank(bandOf(update.before, 1))) continue;
    if (best === null || bandRank(update.band) > bandRank(best.band)) best = update;
  }
  return best;
}
