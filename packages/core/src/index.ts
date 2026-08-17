/**
 * @lenterra/core — the shared deterministic core.
 *
 * One build runs in Hermes on a student's phone and the identical logic runs in
 * goja inside Nakama. That is only possible because this package has no runtime
 * dependencies, no I/O, no `Date.now()`, and no `Math.random()` (TRD-ENG-001),
 * and it is the reason ADR-011 chose TypeScript for the server modules: one
 * rules implementation, not two that drift.
 *
 * **Every export is named here rather than re-exported with `export *`.** Two
 * reasons, and the second is the one that matters.
 *
 * The package surface becomes reviewable. What a phone and a server are allowed
 * to share is a decision, and a wildcard makes it a side effect of whatever a
 * module happened to export — a helper that becomes public because somebody
 * needed it in a neighbouring file.
 *
 * And `export *` compiles to `__createBinding`/`__exportStar` calls that cannot
 * execute under a CJS consumer, so they counted as permanently uncovered
 * branches in a package whose coverage gate is the thing standing between a
 * rules bug and a student being told they lost a mission they won. Removing
 * them makes the number mean what it says.
 */

export const CORE_VERSION = '0.1.0';

// --- primitives ------------------------------------------------------------
export { clamp01, clamp, roundTo, sum, mean, median, createRng, rngInt } from './math';
export {
  utf8Bytes,
  sha256Bytes,
  sha256,
  canonicalJson,
  hashValue,
  timingSafeEqual,
} from './hash';

// --- types -----------------------------------------------------------------
export {
  SKILL_DOMAIN_IDS,
  SKILL_NODE_IDS,
  domainOf,
  isSkillNodeId,
  nodesInDomain,
  MASTERY_BAND_FLOOR,
  bandOf,
  MASTERY_BAND_ORDER,
  bandRank,
} from './types/taxonomy';
export type {
  SkillDomainId,
  ComputationNodeId,
  AlgorithmsNodeId,
  SecurityNodeId,
  SkillNodeId,
  MasteryBand,
} from './types/taxonomy';

export { GAME_IDS, isGameId, AI_TIERS, DEFAULT_GAME_CONFIG, primaryNodeOf } from './types/mission';
export type {
  GameId,
  AiTier,
  MissionGoal,
  MissionGoalKind,
  GoalStatus,
  CongklakSetup,
  BentengSetup,
  MissionSetup,
  MissionConstraints,
  GameConfig,
  Mission,
  MissionSummary,
} from './types/mission';

export type {
  AttemptOutcome,
  ReplayMove,
  Replay,
  RejectionReason,
  DerivedMetrics,
  ValidationSuccess,
  ValidationFailure,
  ValidationResult,
  AttemptSubmission,
  MasteryChange,
  AttemptSummary,
} from './types/attempt';

export {
  ENTITLEMENTS,
  DEFAULT_PASS_MARK,
  checkAnswerHash,
  MAX_LESSON_MINUTES,
  MIN_LESSON_MINUTES,
  MIN_LESSONS_PER_COURSE,
  MAX_LESSONS_PER_COURSE,
  courseMinutes,
  lessonForNode,
} from './types/course';
export type {
  Entitlement,
  LessonBlock,
  LessonBlockKind,
  CheckItemKind,
  CheckItemPublic,
  CheckPublic,
  CheckAnswerKey,
  Lesson,
  CourseSummary,
} from './types/course';

// --- adaptive engine -------------------------------------------------------
export {
  DEFAULT_BKT_PARAMS,
  DOMAIN_PRIORS,
  bktPosterior,
  bktUpdate,
  bktPredict,
  bktUpdateWeighted,
  HINT_DISCOUNT,
  SOURCE_FACTOR,
  hintDiscount,
  TWO_PLAYER_FACTOR,
  effectiveWeight,
  SINGLE_SOURCE_CEILING,
  THIN_EVIDENCE_CEILING,
  applyMasteryCaps,
  DECAY_GRACE_DAYS,
  DECAY_PER_WEEK,
  DECAY_FLOOR_MASTERED,
  applyDecay,
} from './adaptive/bkt';
export type { BktParams, EvidenceSource } from './adaptive/bkt';

export {
  DEFAULT_RATING,
  expectedScore,
  updateRatings,
  studentK,
  missionK,
  PLACEMENT_K,
  RATING_FLOOR,
  RATING_CEILING,
  seedRatingFromPlacement,
  skippedPlacementTargets,
} from './adaptive/elo';
export type { RatingUpdate } from './adaptive/elo';

export {
  TARGET_SUCCESS,
  RECOVERY_TARGET_SUCCESS,
  RECOVERY_MIN_PREDICTED,
  RECOVERY_TRIGGER_FAILURES,
  DECAY_ATTENTION_DAYS,
  gameOfMissionId,
  gapScore,
  varietyPenalty,
  sameGameStreak,
  selectMissions,
} from './adaptive/select';
export type {
  RecommendationReason,
  MasteryView,
  SelectionInput,
  Recommendation,
} from './adaptive/select';

export { STRUGGLE_THRESHOLD, detectStruggle, supportOptionsFor } from './adaptive/struggle';
export type { StruggleDetection, SupportOption } from './adaptive/struggle';

export {
  paramsFor,
  initialMastery,
  applyEvidence,
  recomputeMastery,
  domainRollup,
  highestBandGain,
} from './adaptive/mastery';
export type { MasteryState, EvidenceInput, MasteryUpdate } from './adaptive/mastery';

export {
  NODES_PER_STUDENT,
  MIN_CLASS_TARGET,
  classGoalTarget,
  isCounted,
  classGoal,
} from './adaptive/classgoal';
export type { ClassGoalInput, ClassGoal } from './adaptive/classgoal';

// --- rules -----------------------------------------------------------------
export type {
  MoveEventKind,
  MoveEvent,
  MoveResult,
  GameEngine,
  StateMetrics,
} from './rules/types';

export {
  SUPPORT_WINDOW_DAYS,
  engineFor,
  currentEngine,
  currentVersion,
  supportedVersions,
  registerEngine,
} from './rules/registry';

export {
  MAX_REPLAY_MOVES,
  MIN_PLAUSIBLE_TOTAL_MS,
  MIN_PLAUSIBLE_INTERVAL_MS,
  LONG_GAME_MOVE_THRESHOLD,
  hashConfig,
  validateReplay,
  checkPlausibility,
  withStateMetrics,
} from './rules/validate';

export { ReplayRecorder, recordReplay } from './rules/record';

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
export {
  WEIGHT_SUM_TOLERANCE,
  PRIMARY_WEIGHT_MIN,
  INCIDENTAL_WEIGHT_MAX,
  validateMission,
  validateMissionSet,
  checkGreedyTrapQuota,
  hasErrors,
  primaryNodeOfMission,
} from './content/validate';
export type { ContentIssueSeverity, ContentIssue } from './content/validate';

export {
  answerHashFor,
  gradeAgainstKey,
  gradeLocally,
  WORDS_PER_MINUTE,
  READING_TIME_TOLERANCE,
  CHECK_ITEM_SECONDS,
  validateCourseSet,
} from './content/courses';
export type {
  CheckAnswer,
  CheckItemResult,
  CheckResult,
  CourseValidationInput,
} from './content/courses';

export { solve, estimateDifficulty, eloFromSuccessRate, checkGreedyTrap } from './content/solver';
export type {
  SolveOptions,
  SolveResult,
  DifficultyEstimate,
  GreedyTrapResult,
} from './content/solver';

export { verifyLine, greedyLine } from './content/verify';
export type { LineVerification } from './content/verify';

export {
  CERTIFICATES,
  certificateById,
  checkCertificate,
  certificatesEarned,
} from './content/certificates';
export type {
  CertificateDefinition,
  NodeEvidence,
  CertificateBlocker,
  CertificateCheck,
} from './content/certificates';

export {
  ACHIEVEMENTS,
  TEACHER_AWARDED,
  isGreedyTrapRank,
  FORTRESS_MISSION_ID,
  achievementsFrom,
} from './content/achievements';
export type { AchievementFacts } from './content/achievements';

export {
  DAILY_CAP,
  QUIET_FROM_HOUR,
  QUIET_TO_HOUR,
  DEFAULT_UTC_OFFSET_HOURS,
  isQuietHour,
  underDailyCap,
} from './notify-window';
