import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerHashFor,
  gradeAgainstKey,
  gradeLocally,
  validateCourseSet,
  hasErrors,
} from '../dist/index.js';
import type {
  CheckAnswerKey,
  CheckPublic,
  CourseSummary,
  Lesson,
} from '../dist/types/course.js';

const CHECK_ID = 'algo.loops.l01';

const KEY: CheckAnswerKey = {
  passMark: 0.7,
  skillWeights: { 'algo.iteration': 1.0 },
  items: [
    { itemId: 'q01', correct: 1, explainKey: 'x.q01.explain' },
    { itemId: 'q02', correct: 0, explainKey: 'x.q02.explain' },
    { itemId: 'q03', correct: [1, 0, 2], explainKey: 'x.q03.explain' },
  ],
};

const PUBLIC: CheckPublic = {
  id: CHECK_ID,
  passMark: 0.7,
  items: KEY.items.map((item, i) => ({
    id: item.itemId,
    kind: i === 2 ? 'order' : 'choice',
    promptKey: `x.${item.itemId}.prompt`,
    explainKey: item.explainKey,
    answerHash: answerHashFor(CHECK_ID, item.itemId, item.correct),
  })),
};

/**
 * The property the whole offline-check design rests on.
 *
 * The device grades against digests and the server grades against the key. If
 * those two ever disagree for an honest client, a student sees a correct answer
 * turn wrong on sync, with nothing on screen to explain it — which reads as the
 * product being broken, because it is.
 */
test('local and server grading agree on every answer combination', () => {
  const options = [0, 1, 2];
  const orders = [
    [0, 1, 2],
    [1, 0, 2],
    [2, 1, 0],
  ];

  for (const a of options) {
    for (const b of options) {
      for (const order of orders) {
        const answers = [
          { itemId: 'q01', answer: a },
          { itemId: 'q02', answer: b },
          { itemId: 'q03', answer: order },
        ];
        const server = gradeAgainstKey(KEY, answers);
        const local = gradeLocally(PUBLIC, answers);
        assert.equal(local.score, server.score);
        assert.equal(local.passed, server.passed);
        assert.deepEqual(
          local.items.map((item) => item.correct),
          server.items.map((item) => item.correct),
        );
      }
    }
  }
});

test('an unanswered item is wrong, not skipped', () => {
  const partial = [{ itemId: 'q01', answer: 1 }];
  const server = gradeAgainstKey(KEY, partial);
  const local = gradeLocally(PUBLIC, partial);

  // Scoring over every item rather than every answer is what stops a client
  // passing a check by submitting only the questions it is sure about.
  assert.equal(server.score, 1 / 3);
  assert.equal(local.score, 1 / 3);
  assert.equal(server.passed, false);
});

test('ordering answers are compared by value, not by key insertion order', () => {
  const graded = gradeAgainstKey(KEY, [{ itemId: 'q03', answer: [1, 0, 2] }]);
  assert.equal(graded.items[2]?.correct, true);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fixture(): {
  courses: CourseSummary[];
  lessons: Lesson[];
  answers: Record<string, CheckAnswerKey>;
  lessonNodes: Record<string, string[]>;
  strings: { id: Record<string, string>; en: Record<string, string> };
  knownMissionIds: string[];
} {
  const lesson: Lesson = {
    id: 'algo.loops.l01',
    courseId: 'algo.loops',
    titleKey: 'x.title',
    readingMinutes: 3,
    skillNodes: ['algo.iteration'],
    blocks: [{ kind: 'text', textKey: 'x.body' }],
    check: PUBLIC,
  };

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
      { id: lesson.id, titleKey: lesson.titleKey, readingMinutes: 3, hasCheck: true },
      { id: 'algo.loops.l02', titleKey: 'x.title', readingMinutes: 3, hasCheck: false },
      { id: 'algo.loops.l03', titleKey: 'x.title', readingMinutes: 3, hasCheck: false },
    ],
  };

  const filler = (id: string): Lesson => ({
    id,
    courseId: 'algo.loops',
    titleKey: 'x.title',
    readingMinutes: 3,
    skillNodes: [],
    blocks: [{ kind: 'text', textKey: 'x.body' }],
  });

  const words = new Array(390).fill('kata').join(' ');
  const strings = {
    id: {
      'x.title': 'Judul',
      'x.summary': 'Ringkasan',
      'x.body': words,
      'x.q01.prompt': 'Pertanyaan satu',
      'x.q02.prompt': 'Pertanyaan dua',
      'x.q03.prompt': 'Pertanyaan tiga',
      'x.q01.explain': 'Penjelasan yang cukup panjang untuk menyebut kekeliruan yang biasa terjadi.',
      'x.q02.explain': 'Penjelasan yang cukup panjang untuk menyebut kekeliruan yang biasa terjadi.',
      'x.q03.explain': 'Penjelasan yang cukup panjang untuk menyebut kekeliruan yang biasa terjadi.',
    },
    en: {},
  };

  return {
    courses: [course],
    lessons: [lesson, filler('algo.loops.l02'), filler('algo.loops.l03')],
    answers: { [CHECK_ID]: KEY },
    lessonNodes: { [lesson.id]: ['algo.iteration'] },
    strings,
    knownMissionIds: [],
  };
}

test('an answerHash that drifts from the key is an error', () => {
  const input = fixture();
  const check = input.lessons[0]?.check as CheckPublic;
  const item = check.items[0] as CheckPublic['items'][number];
  check.items[0] = { ...item, answerHash: 'deadbeef' };

  const issues = validateCourseSet(input as never);
  assert.ok(hasErrors(issues));
  assert.ok(issues.some((issue) => issue.check === 'answers'));
});

test('a node with no lesson check is an error', () => {
  // Only `algo.iteration` is covered by the fixture, so the other sixteen nodes
  // must each be reported: a node no lesson evidences can never reach Mastered
  // on multi-source evidence, however well the student plays.
  const issues = validateCourseSet(fixture() as never);
  const uncovered = issues.filter((issue) => issue.check === 'node_coverage');
  assert.equal(uncovered.length, 16);
});

test('a non-free course is rejected in R1', () => {
  const input = fixture();
  (input.courses[0] as CourseSummary).entitlement = 'paket-sekolah';
  const issues = validateCourseSet(input as never);
  assert.ok(issues.some((issue) => issue.check === 'entitlement'));
});

test('a gameLink to a mission that does not exist is an error', () => {
  const input = fixture();
  (input.lessons[0] as Lesson).blocks.push({
    kind: 'gameLink',
    missionId: 'congklak.m99',
    labelKey: 'x.title',
  });
  const issues = validateCourseSet(input as never);
  assert.ok(issues.some((issue) => issue.message.indexOf('congklak.m99') >= 0));
});
