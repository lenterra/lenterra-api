/**
 * Bayesian knowledge tracing (20-06, ADR-003).
 *
 * One number per (student, skill node): the probability the student has
 * learned it. Four parameters govern how evidence moves it. Chosen over a
 * learned model for four reasons that each independently rule one out at this
 * stage: a teacher must be able to see *why* the system claims a weakness;
 * there is no training corpus because zero students have used the product; the
 * client must predict difficulty offline with the same maths; and re-running
 * the engine over stored history must reproduce stored mastery exactly
 * (PRD-LRN-003).
 *
 * Everything here is pure. No clock, no randomness, no I/O (TRD-ADPT-001).
 */

import { clamp01 } from '../math';

export interface BktParams {
  /** L₀ — prior before any evidence. */
  pInit: number;
  /** T — chance of learning on an attempt where it was not known. */
  pTransit: number;
  /** S — chance of failing while knowing it. */
  pSlip: number;
  /** G — chance of succeeding without knowing it. */
  pGuess: number;
}

export const DEFAULT_BKT_PARAMS: BktParams = {
  pInit: 0.15,
  pTransit: 0.12,
  pSlip: 0.1,
  pGuess: 0.2,
};

/**
 * Domain priors for a student with no evidence at all (20-06 "Cold start").
 *
 * Students arrive with counting experience from school, less with procedural
 * reasoning, and almost none with security concepts.
 */
export const DOMAIN_PRIORS: Record<'computation' | 'algorithms' | 'security', number> = {
  computation: 0.2,
  algorithms: 0.15,
  security: 0.1,
};

/** Posterior probability the skill is known, given the observation. */
export function bktPosterior(prior: number, correct: boolean, p: BktParams): number {
  const num = correct ? prior * (1 - p.pSlip) : prior * p.pSlip;
  const den = correct
    ? prior * (1 - p.pSlip) + (1 - prior) * p.pGuess
    : prior * p.pSlip + (1 - prior) * (1 - p.pGuess);

  // A degenerate parameter set can make the denominator vanish. Returning the
  // prior is the only answer that does not invent information.
  return den === 0 ? prior : clamp01(num / den);
}

/**
 * Full step: condition on the observation, then apply learning.
 *
 * **Deliberate deviation from textbook BKT.** The standard form applies
 * `pTransit` regardless of the observation, on the reasoning that the student
 * had a learning opportunity either way. That is defensible in the literature
 * and wrong for this product: below a prior of roughly 0.14 the transit term
 * dominates and a *failure raises* mastery. The `security` domain starts at
 * 0.10 (DOMAIN_PRIORS), so a student's very first failed Benteng mission would
 * move them upward.
 *
 * A teacher who sees mastery rise after three failures stops trusting the
 * dashboard, and the product's whole explainability claim rests on that trust
 * being warranted. So the update is clamped monotonic: a success never lowers
 * mastery, a failure never raises it. The clamp only binds in the low-prior
 * region where the textbook behaviour is counter-intuitive anyway.
 */
export function bktUpdate(prior: number, correct: boolean, p: BktParams): number {
  const post = bktPosterior(prior, correct, p);
  const learned = clamp01(post + (1 - post) * p.pTransit);
  return correct ? Math.max(prior, learned) : Math.min(prior, learned);
}

/** Probability of a correct response given current mastery. */
export function bktPredict(mastery: number, p: BktParams): number {
  return clamp01(mastery * (1 - p.pSlip) + (1 - mastery) * p.pGuess);
}

/**
 * Weighted update: interpolate between the prior and the full update.
 *
 * A mission evidences several nodes with different weights, and a hinted
 * success is weaker evidence than an unaided one. `weight = 0` leaves mastery
 * exactly unchanged, which is what makes a zero-weight node genuinely
 * unevidenced rather than nudged.
 */
export function bktUpdateWeighted(
  prior: number,
  correct: boolean,
  p: BktParams,
  weight: number,
): number {
  const full = bktUpdate(prior, correct, p);
  return clamp01(prior + (full - prior) * clamp01(weight));
}

// ---------------------------------------------------------------------------
// Effective weight
// ---------------------------------------------------------------------------

export type EvidenceSource = 'game' | 'check' | 'repeat';

/**
 * A hinted success is real but weaker evidence.
 *
 * 0.4 rather than 0: setting it to zero would punish help-seeking, which is
 * the opposite of what a learning product should do. Setting it to 1 would let
 * a student hint their way to a certificate.
 */
export const HINT_DISCOUNT = {
  unhinted: 1.0,
  shownAndUsed: 0.4,
  shownUnused: 0.8,
} as const;

export const SOURCE_FACTOR: Record<EvidenceSource, number> = {
  game: 1.0,
  check: 0.8,
  /** A repeat of an already-passed mission adds little. */
  repeat: 0.5,
};

export function hintDiscount(hintShown: boolean, hintUsed: boolean): number {
  if (hintUsed) return HINT_DISCOUNT.shownAndUsed;
  if (hintShown) return HINT_DISCOUNT.shownUnused;
  return HINT_DISCOUNT.unhinted;
}

/** effectiveWeight = skillWeight × hintDiscount × sourceFactor */
export function effectiveWeight(
  skillWeight: number,
  hintShown: boolean,
  hintUsed: boolean,
  source: EvidenceSource,
): number {
  return clamp01(clamp01(skillWeight) * hintDiscount(hintShown, hintUsed) * SOURCE_FACTOR[source]);
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Proficient ceiling for single-source evidence (PRD-LRN-005). */
export const SINGLE_SOURCE_CEILING = 0.84;
export const THIN_EVIDENCE_CEILING = 0.92;

/**
 * Two caps that stop BKT's optimism from overstating what we know.
 *
 * The first is the mechanism behind PRD-LRN-005: a student who has only ever
 * played one mission has demonstrated *that mission*, not the skill. Without
 * it, twenty replays of one easy mission would read as Mastered — which is
 * exactly the claim the transfer metric M-L05 exists to test.
 */
export function applyMasteryCaps(
  value: number,
  distinctSources: number,
  evidenceCount: number,
): number {
  if (distinctSources < 2) return Math.min(value, SINGLE_SOURCE_CEILING);
  if (evidenceCount < 3) return Math.min(value, THIN_EVIDENCE_CEILING);
  return value;
}

// ---------------------------------------------------------------------------
// Decay (PRD-LRN-006, R2)
// ---------------------------------------------------------------------------

export const DECAY_GRACE_DAYS = 30;
export const DECAY_PER_WEEK = 0.01;
export const DECAY_FLOOR_MASTERED = 0.5;

/**
 * Mastery decays without evidence.
 *
 * Deferred to R2 deliberately — the parameters are guesswork until there is a
 * term of real data — but implemented now so the storage shape and the read
 * path do not change later. Pure in `daysSinceEvidence` rather than reading a
 * clock, so it stays reproducible.
 */
export function applyDecay(
  value: number,
  daysSinceEvidence: number,
  everMastered: boolean,
): number {
  if (daysSinceEvidence <= DECAY_GRACE_DAYS) return value;
  const weeks = Math.floor((daysSinceEvidence - DECAY_GRACE_DAYS) / 7);
  if (weeks <= 0) return value;
  const decayed = value - weeks * DECAY_PER_WEEK;
  const floor = everMastered ? DECAY_FLOOR_MASTERED : 0;
  return clamp01(Math.max(decayed, floor));
}
