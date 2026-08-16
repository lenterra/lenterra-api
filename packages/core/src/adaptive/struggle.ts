/**
 * Struggle detection (20-06).
 *
 * Three consecutive failures on the same primary node. Deliberately blunt:
 * a subtler detector would be harder for a teacher to trust, and the whole
 * point is that the attention list in the dashboard is explainable in one
 * sentence — "Ani failed these three missions in a row".
 */

import type { AttemptSummary } from '../types/attempt';
import type { SkillNodeId } from '../types/taxonomy';

export const STRUGGLE_THRESHOLD = 3;

export interface StruggleDetection {
  skillNodeId: SkillNodeId;
  attemptIds: string[];
}

export type SupportOption = 'easier' | 'lesson' | 'hint';

/**
 * @param recent Most recent first.
 */
export function detectStruggle(recent: AttemptSummary[]): StruggleDetection | null {
  const last3 = recent.slice(0, STRUGGLE_THRESHOLD);
  if (last3.length < STRUGGLE_THRESHOLD) return null;

  for (let i = 0; i < last3.length; i++) {
    // 'abandoned' is not failure. A student whose borrowed phone was taken
    // back has not demonstrated a weakness, and treating it as one would put
    // the poorest students at the top of every attention list.
    if ((last3[i] as AttemptSummary).outcome !== 'failure') return null;
  }

  const node = (last3[0] as AttemptSummary).primaryNode;
  for (let i = 1; i < last3.length; i++) {
    if ((last3[i] as AttemptSummary).primaryNode !== node) return null;
  }

  return {
    skillNodeId: node,
    attemptIds: last3.map((a) => a.id),
  };
}

/**
 * Support offered to a struggling student (PRD-ADPT-006).
 *
 * Ordered by how little it interrupts: an easier mission keeps them playing, a
 * hint keeps them in this mission, a lesson steps out of the game entirely.
 */
export function supportOptionsFor(hasLesson: boolean, hasEasier: boolean): SupportOption[] {
  const options: SupportOption[] = [];
  if (hasEasier) options.push('easier');
  options.push('hint');
  if (hasLesson) options.push('lesson');
  return options;
}
