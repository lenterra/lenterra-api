/**
 * Course validation and check grading (10-08, 10-12).
 *
 * Two jobs, in one file because they share the same definitions:
 *
 *  - **Validation** runs in CI before a lesson can merge and again before a
 *    catalog version can be published, on exactly the same inputs. Content that
 *    reached a student having skipped it is content nobody checked, and the
 *    security lessons are the ones where that matters most.
 *  - **Grading** is one implementation used twice: provisionally on the device
 *    so an offline student sees a result immediately, and authoritatively on
 *    the server, whose grade is the only one persisted. Two
 *    implementations would eventually disagree, and the student would watch a
 *    correct answer turn wrong on sync with no explanation.
 */

import { canonicalJson, sha256 } from '../hash';
import type {
  CheckAnswerKey,
  CheckItemPublic,
  CheckPublic,
  CourseSummary,
  Lesson,
  LessonBlock,
} from '../types/course';
import {
  MAX_LESSON_MINUTES,
  MAX_LESSONS_PER_COURSE,
  MIN_LESSON_MINUTES,
  MIN_LESSONS_PER_COURSE,
  checkAnswerHash,
} from '../types/course';
import { SKILL_NODE_IDS, isSkillNodeId, type SkillNodeId } from '../types/taxonomy';
import type { ContentIssue, ContentIssueSeverity } from './validate';

// ---------------------------------------------------------------------------
// Grading ---------------------------------------------------------------------------

export interface CheckAnswer {
  itemId: string;
  answer: unknown;
}

export interface CheckItemResult {
  itemId: string;
  correct: boolean;
  explainKey: string;
}

export interface CheckResult {
  score: number;
  passed: boolean;
  items: CheckItemResult[];
}

/** The digest an item's answer must produce, using the core's own hash. */
export function answerHashFor(checkId: string, itemId: string, answer: unknown): string {
  return checkAnswerHash(checkId, itemId, answer, canonicalJson, sha256);
}

function answerFor(answers: CheckAnswer[], itemId: string): unknown {
  for (let i = 0; i < answers.length; i++) {
    const entry = answers[i] as CheckAnswer;
    if (entry.itemId === itemId) return entry.answer;
  }
  return undefined;
}

function score(items: CheckItemResult[], passMark: number): CheckResult {
  let correct = 0;
  for (let i = 0; i < items.length; i++) {
    if ((items[i] as CheckItemResult).correct) correct++;
  }
  const value = items.length === 0 ? 0 : correct / items.length;
  return { score: value, passed: value >= passMark, items };
}

/**
 * Grade against the answer key. Server-side; this result is what is stored.
 */
export function gradeAgainstKey(key: CheckAnswerKey, answers: CheckAnswer[]): CheckResult {
  const items: CheckItemResult[] = [];
  for (let i = 0; i < key.items.length; i++) {
    const item = key.items[i] as CheckAnswerKey['items'][number];
    const given = answerFor(answers, item.itemId);
    items.push({
      itemId: item.itemId,
      // Canonical form on both sides, so `[0,2,1]` from a client that ordered
      // its object keys differently is not marked wrong for that reason.
      correct: canonicalJson(given) === canonicalJson(item.correct),
      explainKey: item.explainKey,
    });
  }
  return score(items, key.passMark);
}

/**
 * Grade on the device, against the shipped digests.
 *
 * Provisional by construction — see `checkAnswerHash` for why the digest is not
 * a secret. The student gets an immediate result and the authored explanation
 * while offline; the server decides what it was worth.
 */
export function gradeLocally(check: CheckPublic, answers: CheckAnswer[]): CheckResult {
  const items: CheckItemResult[] = [];
  for (let i = 0; i < check.items.length; i++) {
    const item = check.items[i] as CheckItemPublic;
    const given = answerFor(answers, item.id);
    const correct =
      given !== undefined && answerHashFor(check.id, item.id, given) === item.answerHash;
    items.push({ itemId: item.id, correct, explainKey: item.explainKey });
  }
  return score(items, check.passMark);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface CourseValidationInput {
  courses: CourseSummary[];
  lessons: Lesson[];
  /** Answer keys by check id — the server-only part, checked against the public one. */
  answers: Record<string, CheckAnswerKey>;
  /** Which nodes each lesson evidences, from its check's weights. */
  lessonNodes: Record<string, SkillNodeId[]>;
  strings: { id: Record<string, string>; en: Record<string, string> };
  /** Mission ids that exist, so a `gameLink` cannot point into nothing. */
  knownMissionIds: string[];
}

/**
 * Indonesian reading speed for the target age group, words per minute.
 *
 * The floor of the range reported for Indonesian secondary students reading
 * unfamiliar expository text. Deliberately the floor: overestimating speed
 * produces lessons that overrun the number a student planned their session
 * around, which is the failure a stated reading time exists to prevent.
 */
export const WORDS_PER_MINUTE = 130;

/** How far an authored estimate may sit from the word-count estimate. */
export const READING_TIME_TOLERANCE = 0.6;

/**
 * Seconds a student spends deciding on one check item, beyond reading it.
 *
 * The check is part of the lesson from the student's side — they do not stop
 * the clock when the prose ends — so it counts toward the number they budget
 * their session against. Reading the prompt and options is
 * already covered by the word count; this is the thinking on top of it.
 */
export const CHECK_ITEM_SECONDS = 20;

const MIN_CHECK_ITEMS = 2;
const MAX_CHECK_ITEMS = 5;
const MIN_EXPLAIN_CHARS = 40;

export function validateCourseSet(input: CourseValidationInput): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const add = (severity: ContentIssueSeverity, check: string, id: string, message: string): void => {
    issues.push({ severity, check, missionId: id, message });
  };

  const lessonsById: Record<string, Lesson> = {};
  for (let i = 0; i < input.lessons.length; i++) {
    const lesson = input.lessons[i] as Lesson;
    if (lessonsById[lesson.id]) {
      add('error', 'schema', lesson.id, 'duplicate lesson id');
    }
    lessonsById[lesson.id] = lesson;
  }

  const courseIds: string[] = [];
  const coveredNodes: Record<string, boolean> = {};

  for (let i = 0; i < input.courses.length; i++) {
    const course = input.courses[i] as CourseSummary;

    if (courseIds.indexOf(course.id) >= 0) add('error', 'schema', course.id, 'duplicate course id');
    courseIds.push(course.id);

    if (course.id.indexOf('.') < 0) {
      add('error', 'schema', course.id, 'course id must be "<prefix>.<slug>"');
    }
    if (!Number.isInteger(course.contentVersion) || course.contentVersion < 1) {
      add('error', 'schema', course.id, 'contentVersion must be a positive integer');
    }

    // R1 sells nothing. A non-free course in a published R1
    // catalog would put a lock on a screen shown to a child in a pilot that is
    // free, which is the specific thing that requirement forbids.
    if (course.entitlement !== 'free') {
      add('error', 'entitlement', course.id, 'every R1 course must be free');
    }

    if (
      course.lessons.length < MIN_LESSONS_PER_COURSE ||
      course.lessons.length > MAX_LESSONS_PER_COURSE
    ) {
      add(
        'error',
        'schema',
        course.id,
        `${course.lessons.length} lessons; expected ${MIN_LESSONS_PER_COURSE}–${MAX_LESSONS_PER_COURSE}`,
      );
    }

    for (let j = 0; j < course.skillNodes.length; j++) {
      const node = course.skillNodes[j] as SkillNodeId;
      if (!isSkillNodeId(node)) {
        add('error', 'node_references', course.id, `unknown skill node "${node}"`);
      }
    }

    for (let j = 0; j < course.prerequisites.length; j++) {
      const prerequisite = course.prerequisites[j] as string;
      let found = false;
      for (let k = 0; k < input.courses.length; k++) {
        if ((input.courses[k] as CourseSummary).id === prerequisite) found = true;
      }
      if (!found) {
        add('error', 'prerequisites', course.id, `prerequisite "${prerequisite}" does not exist`);
      }
      if (prerequisite === course.id) {
        add('error', 'prerequisites', course.id, 'a course cannot require itself');
      }
    }

    requireString(input, issues, course.id, course.titleKey, 'title');
    requireString(input, issues, course.id, course.summaryKey, 'summary');

    let totalMinutes = 0;

    for (let j = 0; j < course.lessons.length; j++) {
      const entry = course.lessons[j] as CourseSummary['lessons'][number];
      totalMinutes += entry.readingMinutes;

      const lesson = lessonsById[entry.id];
      if (!lesson) {
        add('error', 'schema', course.id, `lesson "${entry.id}" has no body`);
        continue;
      }
      if (lesson.courseId !== course.id) {
        add('error', 'schema', lesson.id, `body claims course "${lesson.courseId}"`);
      }
      if (entry.readingMinutes !== lesson.readingMinutes) {
        add('error', 'schema', lesson.id, 'index and body disagree about readingMinutes');
      }
      if (entry.hasCheck !== (lesson.check !== undefined)) {
        add('error', 'schema', lesson.id, 'index and body disagree about whether a check exists');
      }

      for (const node of input.lessonNodes[lesson.id] ?? []) {
        coveredNodes[node] = true;
        if (course.skillNodes.indexOf(node) < 0) {
          add(
            'error',
            'node_references',
            lesson.id,
            `evidences "${node}", which the course does not claim`,
          );
        }
      }

      validateLesson(input, issues, lesson);
    }

    // 25 minutes is the target, not a limit — a course that overruns it is a
    // course a student cannot finish in one borrowed-phone session.
    if (totalMinutes > 25) {
      add('warning', 'reading_time', course.id, `${totalMinutes} minutes total; target is ≤25`);
    }
  }

  // Every node needs a lesson. This is what allows a node to reach Mastered on
  // multi-source evidence when only one game touches it — without
  // it, a student can max out the game ladder and still be capped at Proficient
  // through no fault of their own.
  for (let i = 0; i < SKILL_NODE_IDS.length; i++) {
    const node = SKILL_NODE_IDS[i] as SkillNodeId;
    if (!coveredNodes[node]) {
      add('error', 'node_coverage', node, 'no lesson check evidences this node');
    }
  }

  return issues;
}

function validateLesson(
  input: CourseValidationInput,
  issues: ContentIssue[],
  lesson: Lesson,
): void {
  const add = (severity: ContentIssueSeverity, check: string, message: string): void => {
    issues.push({ severity, check, missionId: lesson.id, message });
  };

  if (lesson.id.indexOf(lesson.courseId + '.') !== 0) {
    add('error', 'schema', 'lesson id must be prefixed with its course id');
  }

  if (
    !Number.isInteger(lesson.readingMinutes) ||
    lesson.readingMinutes < MIN_LESSON_MINUTES ||
    lesson.readingMinutes > MAX_LESSON_MINUTES
  ) {
    add(
      'error',
      'reading_time',
      `readingMinutes ${lesson.readingMinutes} outside ${MIN_LESSON_MINUTES}–${MAX_LESSON_MINUTES}; split longer material`,
    );
  }

  requireString(input, issues, lesson.id, lesson.titleKey, 'title');

  if (lesson.blocks.length === 0) add('error', 'schema', 'lesson has no blocks');

  let words = 0;
  let hasText = false;

  for (let i = 0; i < lesson.blocks.length; i++) {
    const block = lesson.blocks[i] as LessonBlock;
    switch (block.kind) {
      case 'text':
        hasText = true;
        words += countWords(input.strings.id[block.textKey]);
        requireString(input, issues, lesson.id, block.textKey, `block ${i}`);
        break;
      case 'example':
        words += countWords(input.strings.id[block.textKey]);
        requireString(input, issues, lesson.id, block.textKey, `block ${i}`);
        if (block.captionKey) {
          requireString(input, issues, lesson.id, block.captionKey, `block ${i} caption`);
        }
        break;
      case 'callout':
        words += countWords(input.strings.id[block.textKey]);
        requireString(input, issues, lesson.id, block.textKey, `block ${i}`);
        break;
      case 'image':
        requireString(input, issues, lesson.id, block.altKey, `block ${i} alt text`);
        break;
      case 'gameLink':
        requireString(input, issues, lesson.id, block.labelKey, `block ${i} label`);
        if (input.knownMissionIds.indexOf(block.missionId) < 0) {
          add('error', 'node_references', `gameLink points at unknown mission "${block.missionId}"`);
        }
        break;
      default:
        add('error', 'schema', 'unknown block kind');
    }
  }

  if (!hasText) add('error', 'schema', 'lesson has no prose; a lesson of callouts teaches nothing');

  let thinkingSeconds = 0;
  if (lesson.check) {
    thinkingSeconds = lesson.check.items.length * CHECK_ITEM_SECONDS;
    for (let i = 0; i < lesson.check.items.length; i++) {
      const item = lesson.check.items[i] as CheckItemPublic;
      words += countWords(input.strings.id[item.promptKey]);
      for (const key of item.optionKeys ?? []) words += countWords(input.strings.id[key]);
      for (const key of item.fragmentKeys ?? []) words += countWords(input.strings.id[key]);
    }
  }

  // The honest-reading-time check. Before pilot data exists the
  // word count is the only evidence we have, so a number that contradicts it is
  // a guess dressed as a measurement. Explanations are excluded deliberately:
  // a student only reads the ones for answers they got wrong.
  if (words > 0) {
    const estimated = words / WORDS_PER_MINUTE + thinkingSeconds / 60;
    const declared = lesson.readingMinutes;
    if (Math.abs(declared - estimated) / estimated > READING_TIME_TOLERANCE) {
      add(
        'warning',
        'reading_time',
        `declares ${declared} min but ${words} words plus ${lesson.check?.items.length ?? 0} ` +
          `question(s) takes ~${estimated.toFixed(1)} min`,
      );
    }
  }

  if (lesson.check) validateCheck(input, issues, lesson, lesson.check);
}

function validateCheck(
  input: CourseValidationInput,
  issues: ContentIssue[],
  lesson: Lesson,
  check: CheckPublic,
): void {
  const add = (severity: ContentIssueSeverity, name: string, message: string): void => {
    issues.push({ severity, check: name, missionId: lesson.id, message });
  };

  if (!(check.passMark > 0) || check.passMark > 1) {
    add('error', 'schema', 'passMark must be in (0, 1]');
  }
  if (check.items.length < MIN_CHECK_ITEMS || check.items.length > MAX_CHECK_ITEMS) {
    add('error', 'schema', `${check.items.length} check items; expected ${MIN_CHECK_ITEMS}–${MAX_CHECK_ITEMS}`);
  }

  const key = input.answers[check.id];
  if (!key) {
    add('error', 'answers', 'no answer key published for this check');
    return;
  }

  if (key.passMark !== check.passMark) {
    add('error', 'answers', 'answer key and client check disagree about passMark');
  }

  // Weights are the whole reason a check counts as evidence. The same rule a
  // mission's weights follow, because they feed the same BKT path.
  const nodes = Object.keys(key.skillWeights) as SkillNodeId[];
  let total = 0;
  let primary = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as SkillNodeId;
    const weight = key.skillWeights[node] ?? 0;
    if (!isSkillNodeId(node)) add('error', 'node_references', `unknown skill node "${node}"`);
    if (!(weight > 0) || weight > 1) add('error', 'weights', `weight for "${node}" must be in (0, 1]`);
    total += weight;
    if (weight >= 0.4) primary++;
  }
  if (nodes.length === 0) {
    add('error', 'weights', 'a check with no weights evidences nothing');
  } else if (Math.abs(total - 1) > 0.001) {
    add('error', 'weights', `skillWeights sums to ${total.toFixed(4)}, expected 1.0`);
  }
  if (nodes.length > 0 && primary !== 1) {
    add('warning', 'weights', `expected exactly one node weighted ≥ 0.4, found ${primary}`);
  }

  for (let i = 0; i < check.items.length; i++) {
    const item = check.items[i] as CheckItemPublic;

    requireString(input, issues, lesson.id, item.promptKey, `check item ${item.id} prompt`);
    requireString(input, issues, lesson.id, item.explainKey, `check item ${item.id} explanation`);

    let expected: unknown = undefined;
    let found = false;
    for (let j = 0; j < key.items.length; j++) {
      const entry = key.items[j] as CheckAnswerKey['items'][number];
      if (entry.itemId === item.id) {
        expected = entry.correct;
        found = true;
        if (entry.explainKey !== item.explainKey) {
          add('error', 'answers', `item "${item.id}": explanation key differs from the answer key`);
        }
      }
    }
    if (!found) {
      add('error', 'answers', `item "${item.id}" has no entry in the answer key`);
      continue;
    }

    // The digest and the key must agree. If they drift, every student who
    // answers correctly is told they are wrong offline and right on sync — a
    // failure that looks exactly like the product being broken, because it is.
    if (answerHashFor(check.id, item.id, expected) !== item.answerHash) {
      add('error', 'answers', `item "${item.id}": answerHash does not match the answer key`);
    }

    switch (item.kind) {
      case 'choice': {
        const options = item.optionKeys ?? [];
        if (options.length < 2) add('error', 'schema', `item "${item.id}": needs at least 2 options`);
        for (let j = 0; j < options.length; j++) {
          requireString(input, issues, lesson.id, options[j] as string, `item ${item.id} option ${j}`);
        }
        if (typeof expected !== 'number' || expected < 0 || expected >= options.length) {
          add('error', 'answers', `item "${item.id}": answer is not a valid option index`);
        }
        checkExplanation(input, issues, lesson, item, options[expected as number]);
        break;
      }
      case 'order': {
        const fragments = item.fragmentKeys ?? [];
        if (fragments.length < 3) {
          add('error', 'schema', `item "${item.id}": ordering needs at least 3 fragments`);
        }
        for (let j = 0; j < fragments.length; j++) {
          requireString(input, issues, lesson.id, fragments[j] as string, `item ${item.id} fragment ${j}`);
        }
        if (!isPermutation(expected, fragments.length)) {
          add('error', 'answers', `item "${item.id}": answer is not a permutation of the fragments`);
        }
        checkExplanation(input, issues, lesson, item, undefined);
        break;
      }
      case 'predict': {
        if (item.position === undefined || item.position === null) {
          add('error', 'schema', `item "${item.id}": a prediction needs a position to read`);
        }
        checkExplanation(input, issues, lesson, item, undefined);
        break;
      }
      default:
        add('error', 'schema', `item "${item.id}": unknown item kind`);
    }
  }
}

/**
 * An explanation must name the misconception, not restate the answer.
 *
 * Restating the right answer teaches nothing a student could not
 * read off the screen, and it is the shape a rushed author reaches for. The
 * check is a heuristic — it catches the verbatim case, which is the common one.
 */
function checkExplanation(
  input: CourseValidationInput,
  issues: ContentIssue[],
  lesson: Lesson,
  item: CheckItemPublic,
  correctOptionKey: string | undefined,
): void {
  const explanation = input.strings.id[item.explainKey];
  if (explanation === undefined) return;

  if (explanation.trim().length < MIN_EXPLAIN_CHARS) {
    issues.push({
      severity: 'error',
      check: 'explanations',
      missionId: lesson.id,
      message: `item "${item.id}": explanation is too short to name a misconception`,
    });
  }

  if (correctOptionKey === undefined) return;
  const answer = input.strings.id[correctOptionKey];
  if (answer === undefined) return;

  const normalised = answer.trim().replace(/[.!?]+$/, '').toLowerCase();
  if (normalised.length >= 12 && explanation.toLowerCase().indexOf(normalised) >= 0) {
    issues.push({
      severity: 'warning',
      check: 'explanations',
      missionId: lesson.id,
      message: `item "${item.id}": explanation repeats the correct option verbatim`,
    });
  }
}

function isPermutation(value: unknown, length: number): boolean {
  if (Object.prototype.toString.call(value) !== '[object Array]') return false;
  const array = value as unknown[];
  if (array.length !== length) return false;
  const seen: Record<number, boolean> = {};
  for (let i = 0; i < array.length; i++) {
    const entry = array[i];
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry >= length) {
      return false;
    }
    if (seen[entry]) return false;
    seen[entry] = true;
  }
  return true;
}

/**
 * Indonesian is the source locale and may not lag; English may (ADR-010).
 */
function requireString(
  input: CourseValidationInput,
  issues: ContentIssue[],
  id: string,
  key: string,
  what: string,
): void {
  if (!key) {
    issues.push({ severity: 'error', check: 'strings', missionId: id, message: `${what} has no key` });
    return;
  }
  if (input.strings.id[key] === undefined) {
    issues.push({
      severity: 'error',
      check: 'strings',
      missionId: id,
      message: `missing Indonesian string for ${what} ("${key}")`,
    });
  } else if (input.strings.en[key] === undefined) {
    issues.push({
      severity: 'warning',
      check: 'strings',
      missionId: id,
      message: `missing English string for ${what} ("${key}")`,
    });
  }
}

function countWords(text: string | undefined): number {
  if (!text) return 0;
  const parts = text.trim().split(/\s+/);
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] as string).length > 0) count++;
  }
  return count;
}
