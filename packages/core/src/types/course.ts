/**
 * Course, lesson, and check definitions (10-08).
 *
 * Courses are catalog content, not app code: shipping a new
 * lesson or fixing a typo is a publish, never a release. These types are the
 * contract that authoring, validation, the publish pipeline, the lesson reader
 * and server-side grading all agree on.
 *
 * **Prose is never in these types.** Every human-readable string is a key into
 * the catalog's `strings.<locale>` parts, the same way missions work — which is
 * what lets Indonesian be corrected without touching structure, and what lets
 * English lag behind it (ADR-010) instead of blocking a publish.
 */

import type { SkillDomainId, SkillNodeId } from './taxonomy';

/**
 * Access tier.
 *
 * Every R1 course is `free` and every account holds `free`, so no student meets
 * a restriction. The field exists now because retrofitting an
 * entitlement check into a live catalogue with cached clients is genuinely
 * painful, and adding one costs nothing today.
 */
export type Entitlement = 'free' | 'paket-sekolah';

export const ENTITLEMENTS: readonly Entitlement[] = ['free', 'paket-sekolah'];

// ---------------------------------------------------------------------------
// Lesson bodies
// ---------------------------------------------------------------------------

/**
 * One piece of a lesson.
 *
 * Discriminated so the reader is exhaustive: adding a block kind without
 * rendering it becomes a compile error rather than a blank space on a screen
 * a student is reading offline with nobody to ask.
 */
export type LessonBlock =
  /** Body prose. Markdown-ish, but only bold, lists, and paragraphs render. */
  | { kind: 'text'; textKey: string }
  /**
   * An illustration from the catalog's asset set.
   *
   * `altKey` is required, not optional — an image with no alternative text is
   * unreadable to a screen reader and invisible to a student whose connection
   * dropped the asset.
   */
  | { kind: 'image'; assetId: string; altKey: string }
  /** A worked example, set apart from the body so it can be skimmed back to. */
  | { kind: 'example'; textKey: string; captionKey?: string }
  /** An aside. `culture` carries regional-variation notes, which must be accurate. */
  | { kind: 'callout'; tone: 'tip' | 'warning' | 'culture'; textKey: string }
  /**
   * A link into the mission where the idea lives.
   *
   * The other direction of the recovery link: a lesson can send a student into the
   * game, not only a failed game into a lesson.
   */
  | { kind: 'gameLink'; missionId: string; labelKey: string };

export type LessonBlockKind = LessonBlock['kind'];

// ---------------------------------------------------------------------------
// Checks for understanding
// ---------------------------------------------------------------------------

export type CheckItemKind = 'choice' | 'order' | 'predict';

/**
 * A check item as the *client* receives it.
 *
 * The correct answer is not here. What ships instead is `answerHash` — see
 * `checkAnswerHash` below for what that does and, more importantly, what it
 * does not do.
 */
export interface CheckItemPublic {
  id: string;
  kind: CheckItemKind;
  promptKey: string;
  /** `choice`: the options, in authored order. */
  optionKeys?: string[];
  /** `order`: the fragments to arrange, in authored (i.e. scrambled) order. */
  fragmentKeys?: string[];
  /** `predict`: the position to read. A `MissionSetup`, rendered by the board. */
  position?: unknown;
  /**
   * Names the misconception behind a wrong answer.
   *
   * Shipped to the client because the student has to see it offline, the moment
   * they answer, which is the only moment it teaches anything. Authored so it
   * does not give the answer away — see `validateCourseSet`.
   */
  explainKey: string;
  answerHash: string;
}

/** A check as the client receives it: gradeable locally, authoritative nowhere. */
export interface CheckPublic {
  id: string;
  passMark: number;
  items: CheckItemPublic[];
}

/**
 * The answer key. Server-side only, in the `checks.answers` catalog part, which
 * `v1.catalog.pull` refuses to serve.
 */
export interface CheckAnswerKey {
  items: { itemId: string; correct: unknown; explainKey: string }[];
  passMark: number;
  /** Sums to 1.0 ± 0.001, same rule as a mission's. */
  skillWeights: Partial<Record<SkillNodeId, number>>;
}

export const DEFAULT_PASS_MARK = 0.7;

/**
 * Digest of a correct answer, for provisional grading on the device.
 *
 * **This is not a security boundary and is not pretending to be one.** A
 * four-option `choice` item has four possible answers, so anyone willing to
 * hash four values can recover the key. What the digest buys is that the answer
 * is not *readable* — a student thumbing through the cache does not simply see
 * it, and a screenshot of the cache transfers nothing.
 *
 * What actually protects the evidence is that the score is graded again
 * server-side from `checks.answers` and only the server's grade is persisted
 *. Local grading exists so a student offline sees a result and
 * an explanation immediately; defeating it buys a green tick that the next sync
 * overwrites, and moves no mastery at all.
 *
 * 10-08 gestures at per-student salting instead. That does not work here: the
 * catalog is content-addressed and shared by every device, so a per-student
 * salt would mean a per-student catalog part and the end of shared caching. The
 * shipped design trades a weaker local secret for an authoritative remote one,
 * which is the trade that actually holds.
 */
export function checkAnswerHash(
  checkId: string,
  itemId: string,
  answer: unknown,
  canonical: (value: unknown) => string,
  digest: (input: string) => string,
): string {
  // `\u0000` rather than a literal NUL byte, which is what was here. The
  // runtime value is identical, so no published hash changes — but a raw NUL in
  // a source file is one editor, one copy-paste, or one encoding normalisation
  // away from being dropped, and if it were, every check a student submits
  // would be graded against a key that no longer matches. It also made this
  // file read as binary to grep and to diff tools.
  //
  // The separator matters: without one, check 'a1' item 'b' and check 'a' item
  // '1b' would hash the same. NUL is the right choice because it cannot occur
  // in an id.
  return digest(checkId + '\u0000' + itemId + '\u0000' + canonical(answer));
}

// ---------------------------------------------------------------------------
// Lesson and course
// ---------------------------------------------------------------------------

export interface Lesson {
  id: string; // 'algo.loops.l02'
  courseId: string;
  titleKey: string;
  /**
   * Authored reading time, in minutes.
   *
   * Capped at 6: a student with a 40-minute borrowed-phone window
   * budgets by this number, so a lesson that overruns it costs them a session
   * they had planned. Validation checks it against word count, and the pilot
   * replaces the estimate with a measured median.
   */
  readingMinutes: number;
  /**
   * What this lesson evidences, taken from its check's weights.
   *
   * Shipped to the client even though the weights themselves are not: knowing a
   * lesson teaches `algo.iteration` gives away nothing about the answers, and
   * without it the app cannot answer "which lesson covers the node this student
   * keeps failing" — which is the whole of the recovery offer.
   */
  skillNodes: SkillNodeId[];
  blocks: LessonBlock[];
  check?: CheckPublic;
}

export const MAX_LESSON_MINUTES = 6;
export const MIN_LESSON_MINUTES = 2;

/** The course index, as the courses tab reads it. Lesson bodies are pulled separately. */
export interface CourseSummary {
  id: string; // 'algo.loops'
  domain: SkillDomainId;
  contentVersion: number;
  titleKey: string;
  summaryKey: string;
  /** What completing the course evidences. */
  skillNodes: SkillNodeId[];
  entitlement: Entitlement;
  prerequisites: string[];
  lessons: { id: string; titleKey: string; readingMinutes: number; hasCheck: boolean }[];
}

export const MIN_LESSONS_PER_COURSE = 3;
export const MAX_LESSONS_PER_COURSE = 7;

/** Total reading time, which is what a card shows and a student plans around. */
export function courseMinutes(course: CourseSummary): number {
  let total = 0;
  for (let i = 0; i < course.lessons.length; i++) {
    total += (course.lessons[i] as CourseSummary['lessons'][number]).readingMinutes;
  }
  return total;
}

/**
 * The lesson that best covers a node, for the recovery offer.
 *
 * "Best" means the one that weights the node most heavily, not the first one
 * that mentions it. A student who has failed three missions on `algo.greedy`
 * should be sent to the lesson about greedy choices, not to the one that
 * touches it in passing while teaching something else.
 */
export function lessonForNode(lessons: Lesson[], node: SkillNodeId): Lesson | null {
  let best: Lesson | null = null;
  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i] as Lesson;
    const position = lesson.skillNodes.indexOf(node);
    if (position < 0) continue;
    // Nodes are emitted in weight order, so an earlier position means the
    // lesson leans on this node more.
    if (best === null || position < best.skillNodes.indexOf(node)) best = lesson;
  }
  return best;
}
