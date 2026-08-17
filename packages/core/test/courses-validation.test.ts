/**
 * Every way a course can be wrong.
 *
 * Content validation is only worth having if each check actually fires, and a
 * check nobody has ever seen reject anything is indistinguishable from a check
 * that does not work. Each case here breaks exactly one thing and asserts the
 * corresponding refusal — because these run before a lesson reaches a student,
 * and the security courses are the ones where being wrong does real damage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerHashFor, validateCourseSet } from '../dist/index.js';
import type { CheckAnswerKey, CheckPublic, CourseSummary, Lesson } from '../dist/types/course.js';
import type { ContentIssue } from '../dist/content/validate.js';

const CHECK_ID = 'algo.loops.l01';

function key(): CheckAnswerKey {
  return {
    passMark: 0.7,
    skillWeights: { 'algo.iteration': 1.0 },
    items: [
      { itemId: 'q01', correct: 1, explainKey: 'x.q01.explain' },
      { itemId: 'q02', correct: [1, 0, 2], explainKey: 'x.q02.explain' },
    ],
  };
}

function check(): CheckPublic {
  return {
    id: CHECK_ID,
    passMark: 0.7,
    items: [
      {
        id: 'q01',
        kind: 'choice',
        promptKey: 'x.q01.prompt',
        explainKey: 'x.q01.explain',
        optionKeys: ['x.o1', 'x.o2', 'x.o3'],
        answerHash: answerHashFor(CHECK_ID, 'q01', 1),
      },
      {
        id: 'q02',
        kind: 'order',
        promptKey: 'x.q02.prompt',
        explainKey: 'x.q02.explain',
        fragmentKeys: ['x.f1', 'x.f2', 'x.f3'],
        answerHash: answerHashFor(CHECK_ID, 'q02', [1, 0, 2]),
      },
    ],
  };
}

const EXPLAIN = 'Penjelasan yang cukup panjang untuk menyebut kekeliruan yang biasa terjadi.';

function strings(): { id: Record<string, string>; en: Record<string, string> } {
  return {
    id: {
      'x.title': 'Judul',
      'x.summary': 'Ringkasan',
      'x.body': new Array(330).fill('kata').join(' '),
      'x.q01.prompt': 'Pertanyaan satu',
      'x.q02.prompt': 'Pertanyaan dua',
      'x.q01.explain': EXPLAIN,
      'x.q02.explain': EXPLAIN,
      'x.o1': 'Pilihan satu',
      'x.o2': 'Pilihan dua',
      'x.o3': 'Pilihan tiga',
      'x.f1': 'Bagian satu',
      'x.f2': 'Bagian dua',
      'x.f3': 'Bagian tiga',
    },
    en: {},
  };
}

interface Input {
  courses: CourseSummary[];
  lessons: Lesson[];
  answers: Record<string, CheckAnswerKey>;
  lessonNodes: Record<string, string[]>;
  strings: { id: Record<string, string>; en: Record<string, string> };
  knownMissionIds: string[];
}

function fixture(): Input {
  const lesson: Lesson = {
    id: CHECK_ID,
    courseId: 'algo.loops',
    titleKey: 'x.title',
    readingMinutes: 3,
    skillNodes: ['algo.iteration'],
    blocks: [{ kind: 'text', textKey: 'x.body' }],
    check: check(),
  };

  const filler = (id: string): Lesson => ({
    id,
    courseId: 'algo.loops',
    titleKey: 'x.title',
    readingMinutes: 3,
    skillNodes: [],
    blocks: [{ kind: 'text', textKey: 'x.body' }],
  });

  const course: CourseSummary = {
    id: 'algo.loops',
    domain: 'algorithms',
    contentVersion: 1,
    titleKey: 'x.title',
    summaryKey: 'x.summary',
    skillNodes: ['algo.iteration'],
    entitlement: 'free',
    prerequisites: [],
    lessons: [
      { id: lesson.id, titleKey: 'x.title', readingMinutes: 3, hasCheck: true },
      { id: 'algo.loops.l02', titleKey: 'x.title', readingMinutes: 3, hasCheck: false },
      { id: 'algo.loops.l03', titleKey: 'x.title', readingMinutes: 3, hasCheck: false },
    ],
  };

  return {
    courses: [course],
    lessons: [lesson, filler('algo.loops.l02'), filler('algo.loops.l03')],
    answers: { [CHECK_ID]: key() },
    lessonNodes: { [CHECK_ID]: ['algo.iteration'] },
    strings: strings(),
    knownMissionIds: ['congklak.m01'],
  };
}

/** Issues excluding the node-coverage noise a one-course fixture always produces. */
function issuesOf(input: Input): ContentIssue[] {
  return validateCourseSet(input as never).filter((issue) => issue.check !== 'node_coverage');
}

function has(input: Input, checkName: string): boolean {
  return issuesOf(input).some(
    (issue) => issue.check === checkName && issue.severity === 'error',
  );
}

/** Some checks are advisory: a warning is the correct refusal for them. */
function warns(input: Input, checkName: string): boolean {
  return issuesOf(input).some(
    (issue) => issue.check === checkName && issue.severity === 'warning',
  );
}

test('a well-formed course produces no errors', () => {
  // Warnings are expected: the fixture ships no English, which is allowed to
  // lag (ADR-010). Errors are not.
  const errors = issuesOf(fixture()).filter((issue) => issue.severity === 'error');
  assert.deepEqual(errors, []);
});

// --- schema ----------------------------------------------------------------

test('a duplicate course id is caught', () => {
  const input = fixture();
  input.courses.push({ ...(input.courses[0] as CourseSummary) });
  assert.ok(has(input, 'schema'));
});

test('a course id without a dot is caught', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).id = 'loops';
  assert.ok(has(input, 'schema'));
});

test('a content version below one is caught', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).contentVersion = 0;
  assert.ok(has(input, 'schema'));
});

test('too few lessons is caught', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).lessons = [
    { id: CHECK_ID, titleKey: 'x.title', readingMinutes: 3, hasCheck: true },
  ];
  assert.ok(has(input, 'schema'));
});

test('a lesson listed in the index with no body is caught', () => {
  const input = fixture();
  input.lessons = input.lessons.filter((lesson) => lesson.id !== 'algo.loops.l02');
  assert.ok(has(input, 'schema'));
});

test('an index and body that disagree about reading time is caught', () => {
  const input = fixture();
  const entry = (input.courses[0] as CourseSummary).lessons[0];
  if (entry) entry.readingMinutes = 5;
  assert.ok(has(input, 'schema'));
});

test('an index and body that disagree about having a check is caught', () => {
  const input = fixture();
  const entry = (input.courses[0] as CourseSummary).lessons[0];
  if (entry) entry.hasCheck = false;
  assert.ok(has(input, 'schema'));
});

test('a lesson claiming the wrong course is caught', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).courseId = 'sec.basics';
  assert.ok(has(input, 'schema'));
});

test('a lesson with no prose is caught', () => {
  // A lesson of callouts and images looks like content and teaches nothing.
  const input = fixture();
  (input.lessons[0] as Lesson).blocks = [
    { kind: 'callout', tone: 'tip', textKey: 'x.body' },
  ];
  assert.ok(has(input, 'schema'));
});

test('a duplicate lesson id is caught', () => {
  const input = fixture();
  input.lessons.push({ ...(input.lessons[0] as Lesson) });
  assert.ok(has(input, 'schema'));
});

// --- reading time ----------------------------------------------------------

test('a lesson longer than six minutes is caught', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).readingMinutes = 9;
  const entry = (input.courses[0] as CourseSummary).lessons[0];
  if (entry) entry.readingMinutes = 9;
  assert.ok(has(input, 'reading_time'));
});

test('a reading estimate that contradicts the word count is caught', () => {
  const input = fixture();
  input.strings.id['x.body'] = 'Sangat pendek sekali.';
  assert.ok(warns(input, 'reading_time'));
});

// --- prerequisites and entitlement -----------------------------------------

test('a prerequisite that does not exist is caught', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).prerequisites = ['algo.nonexistent'];
  assert.ok(has(input, 'prerequisites'));
});

test('a course that requires itself is caught', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).prerequisites = ['algo.loops'];
  assert.ok(has(input, 'prerequisites'));
});

// --- nodes -----------------------------------------------------------------

test('a lesson evidencing a node its course does not claim is caught', () => {
  const input = fixture();
  input.lessonNodes[CHECK_ID] = ['sec.assets'];
  assert.ok(has(input, 'node_references'));
});

test('an unknown skill node on a course is caught', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).skillNodes = ['algo.nonsense' as never];
  assert.ok(has(input, 'node_references'));
});

// --- checks ----------------------------------------------------------------

test('a check with no published answer key is caught', () => {
  const input = fixture();
  input.answers = {};
  assert.ok(has(input, 'answers'));
});

test('a pass mark outside (0,1] is caught', () => {
  const input = fixture();
  const c = (input.lessons[0] as Lesson).check as CheckPublic;
  c.passMark = 1.5;
  assert.ok(has(input, 'schema'));
});

test('a client check and answer key that disagree about the pass mark is caught', () => {
  const input = fixture();
  const c = (input.lessons[0] as Lesson).check as CheckPublic;
  c.passMark = 0.6;
  assert.ok(has(input, 'answers'));
});

test('weights that do not sum to one are caught', () => {
  const input = fixture();
  (input.answers[CHECK_ID] as CheckAnswerKey).skillWeights = { 'algo.iteration': 0.5 };
  assert.ok(has(input, 'weights'));
});

test('a check with no weights at all is caught', () => {
  const input = fixture();
  (input.answers[CHECK_ID] as CheckAnswerKey).skillWeights = {};
  assert.ok(has(input, 'weights'));
});

test('an item missing from the answer key is caught', () => {
  const input = fixture();
  const answers = input.answers[CHECK_ID] as CheckAnswerKey;
  answers.items = answers.items.filter((item) => item.itemId !== 'q02');
  assert.ok(has(input, 'answers'));
});

test('an explanation key that differs between the two halves is caught', () => {
  const input = fixture();
  const answers = input.answers[CHECK_ID] as CheckAnswerKey;
  const item = answers.items[0];
  if (item) item.explainKey = 'x.q02.explain';
  assert.ok(has(input, 'answers'));
});

test('a choice answer that is not a valid option index is caught', () => {
  const input = fixture();
  const answers = input.answers[CHECK_ID] as CheckAnswerKey;
  const item = answers.items[0];
  if (item) item.correct = 9;
  assert.ok(has(input, 'answers'));
});

test('a choice with fewer than two options is caught', () => {
  const input = fixture();
  const c = (input.lessons[0] as Lesson).check as CheckPublic;
  const item = c.items[0];
  if (item) item.optionKeys = ['x.o1'];
  assert.ok(has(input, 'schema'));
});

test('an ordering answer that is not a permutation is caught', () => {
  const input = fixture();
  const answers = input.answers[CHECK_ID] as CheckAnswerKey;
  const item = answers.items[1];
  if (item) item.correct = [1, 1, 2];
  assert.ok(has(input, 'answers'));
});

test('an ordering with too few fragments is caught', () => {
  const input = fixture();
  const c = (input.lessons[0] as Lesson).check as CheckPublic;
  const item = c.items[1];
  if (item) item.fragmentKeys = ['x.f1', 'x.f2'];
  assert.ok(has(input, 'schema'));
});

test('a prediction with no position to read is caught', () => {
  const input = fixture();
  const c = (input.lessons[0] as Lesson).check as CheckPublic;
  const item = c.items[0];
  if (item) {
    item.kind = 'predict';
    delete item.optionKeys;
  }
  assert.ok(has(input, 'schema'));
});

test('a valid prediction item passes', () => {
  const input = fixture();
  const c = (input.lessons[0] as Lesson).check as CheckPublic;
  const item = c.items[0];
  if (item) {
    item.kind = 'predict';
    delete item.optionKeys;
    item.position = { game: 'congklak', pits: [0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1] };
  }
  assert.ok(!has(input, 'schema'));
});

// --- explanations ----------------------------------------------------------

test('an explanation too short to name a misconception is caught', () => {
  const input = fixture();
  input.strings.id['x.q01.explain'] = 'Salah.';
  assert.ok(has(input, 'explanations'));
});

test('an explanation that just repeats the right answer is flagged', () => {
  // PRD-CRS-005: name the misconception, do not restate the answer. This is the
  // shape a rushed author reaches for and it teaches nothing a student could
  // not read off the screen.
  const input = fixture();
  input.strings.id['x.o2'] = 'Karena perulangan berlaku untuk jumlah berapa pun';
  input.strings.id['x.q01.explain'] =
    'Jawabannya adalah karena perulangan berlaku untuk jumlah berapa pun, itu saja.';
  assert.ok(warns(input, 'explanations'));
});

// --- strings ---------------------------------------------------------------

test('a missing Indonesian string is an error', () => {
  const input = fixture();
  delete input.strings.id['x.summary'];
  assert.ok(has(input, 'strings'));
});

test('English strings absent everywhere produce warnings, never errors', () => {
  const input = fixture();
  const issues = validateCourseSet(input as never).filter((issue) => issue.check === 'strings');
  assert.ok(issues.every((issue) => issue.severity === 'warning'));
});

test('a block with no key at all is caught', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).blocks = [{ kind: 'text', textKey: '' }];
  assert.ok(has(input, 'strings'));
});

test('an image needs alt text', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).blocks.push({
    kind: 'image',
    assetId: 'diagram',
    altKey: 'x.missing',
  });
  assert.ok(has(input, 'strings'));
});

test('an example caption is checked when present', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).blocks.push({
    kind: 'example',
    textKey: 'x.body',
    captionKey: 'x.absent',
  });
  assert.ok(has(input, 'strings'));
});

test('a block kind nothing knows how to render is caught', () => {
  // Skipping it would render as a blank space in a lesson and the author would
  // be told nothing — a mistake that survives review because it looks like a
  // styling problem.
  const input = fixture();
  (input.lessons[0] as Lesson).blocks = [
    { kind: 'text', textKey: 'x.body' },
    { kind: 'hologram', textKey: 'x.body' } as never,
  ];
  assert.ok(has(input, 'schema'));
});

test('a gameLink into a mission that does not exist is caught', () => {
  // The link renders, the student taps it, and nothing is there. Checked here
  // because the mission ladder and the courses are authored separately and
  // renumbering one does not touch the other.
  const input = fixture();
  (input.lessons[0] as Lesson).blocks.push({
    kind: 'gameLink',
    missionId: 'congklak.m99',
    labelKey: 'x.title',
  });
  assert.ok(has(input, 'node_references'));
});

test('a check with too few or too many items is caught', () => {
  // Too few is not a check; too many is a lesson that stops being a check and
  // starts being an exam, in a product whose whole premise is short sessions on
  // a borrowed phone.
  const few = fixture();
  (few.lessons[0] as Lesson).check!.items = [];
  assert.ok(has(few, 'schema'));

  const many = fixture();
  const item = (many.lessons[0] as Lesson).check!.items[0]!;
  (many.lessons[0] as Lesson).check!.items = new Array(30).fill(null).map((_, i) => ({
    ...item,
    id: `q${i}`,
  }));
  assert.ok(has(many, 'schema'));
});

test('an item kind nothing knows how to grade is caught', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).check!.items[0] = {
    ...(input.lessons[0] as Lesson).check!.items[0]!,
    kind: 'essay' as never,
  };
  assert.ok(has(input, 'schema'));
});

test('a course that overruns a single session is flagged', () => {
  // A warning rather than an error: 25 minutes is the target a student plans
  // their borrowed-phone session around, not a rule about content.
  const input = fixture();
  for (const lesson of input.lessons) lesson.readingMinutes = 6;
  for (const entry of (input.courses[0] as CourseSummary).lessons) entry.readingMinutes = 6;
  input.courses[0]!.lessons = new Array(6).fill(null).map((_, i) => ({
    id: `algo.loops.l0${i + 1}`,
    titleKey: 'x.title',
    readingMinutes: 6,
    hasCheck: i === 0,
  }));
  input.lessons = new Array(6).fill(null).map((_, i) => ({
    ...(input.lessons[i === 0 ? 0 : 1] as Lesson),
    id: `algo.loops.l0${i + 1}`,
    readingMinutes: 6,
  }));

  assert.ok(warns(input, 'reading_time'));
});
