/**
 * @lenterra/core — the shared deterministic core.
 *
 * One build runs in Hermes on a student's phone and the identical logic runs in
 * goja inside Nakama. That is only possible because this package has no runtime
 * dependencies, no I/O, no `Date.now()`, and no `Math.random()` (TRD-ENG-001),
 * and it is the reason ADR-011 chose TypeScript for the server modules: one
 * rules implementation, not two that drift.
 */

export const CORE_VERSION = '0.1.0';

// --- primitives ------------------------------------------------------------
export * from './math';
export * from './hash';

// --- types -----------------------------------------------------------------
export * from './types/taxonomy';
export * from './types/mission';
export * from './types/attempt';
export * from './types/course';

// --- adaptive engine -------------------------------------------------------
export * from './adaptive/bkt';
export * from './adaptive/elo';
export * from './adaptive/select';
export * from './adaptive/struggle';
export * from './adaptive/mastery';
export * from './adaptive/classgoal';

// --- rules -----------------------------------------------------------------
export * from './rules/types';
export * from './rules/registry';
export * from './rules/validate';
export * from './rules/record';

export { congklakEngine, CONGKLAK_ENGINE_VERSION } from './rules/congklak';
export { bentengEngine, BENTENG_ENGINE_VERSION, unitFreshness } from './rules/benteng';

export type { CongklakState } from './rules/congklak/state';
export type { CongklakMove } from './rules/congklak/moves';
export type { BentengState, BentengUnit, BentengBase, Team } from './rules/benteng/state';
export type { BentengMove } from './rules/benteng/moves';

export {
  standardBoard,
  storeOf,
  rowOf,
  oppositePit,
  scoreOf,
  seedsInRow,
  pitsPerSide,
  hasExposedPit,
  greedyPit,
} from './rules/congklak';

export {
  freshnessOf,
  isCapturable,
  activeUnits,
  baseOf,
  unitById,
  legalityOf,
} from './rules/benteng';

// --- content ---------------------------------------------------------------
export * from './content/validate';
export * from './content/courses';
export * from './content/solver';
export * from './content/verify';
export * from './content/certificates';
export * from './content/achievements';
export * from './notify-window';
