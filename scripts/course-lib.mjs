/**
 * Compiling authored courses into catalog parts.
 *
 * Authors write one file per course with the Indonesian and English prose
 * inline, next to the structure it belongs to. That is the opposite of how
 * missions work — a mission carries string *keys* and the prose lives in
 * `content/strings/` — and the difference is deliberate: a mission has four
 * strings, a course has upwards of two hundred, and keeping two hundred keys in
 * sync by hand across three files is a job nobody does correctly twice.
 *
 * So the keys are generated here rather than typed. This module is the only
 * place that knows the naming scheme, which means renaming a lesson cannot
 * silently orphan its prose: both sides are derived from the same input.
 *
 * What comes out is exactly what gets published:
 *
 *   courses            the index the courses tab reads
 *   lessons.<courseId> one part per course, so opening a course pulls its
 *                      lessons and not the other eight
 *   checks.answers     the answer key, which `v1.catalog.pull` refuses to serve
 *   strings.<locale>   merged into the same parts the missions use
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

import { answerHashFor, validateCourseSet } from '../packages/core/dist/index.js';
import { contentDir } from './content-lib.mjs';

const LOCALES = ['id', 'en'];

export function courseDir() {
  return join(contentDir, 'courses');
}

/** Read every authored course, in catalogue order (by filename). */
export function loadCourses() {
  const dir = courseDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((file) => ({ file, course: yaml.load(readFileSync(join(dir, file), 'utf8')) }));
}

/**
 * Set `a.b.c` in a nested object.
 *
 * i18next treats `.` as a path separator, so a flat key like
 * `course.algo.loops.l01.title` is unreachable — it looks up `course` → `algo`
 * → … and finds a string where it expected an object. Nesting at publish time
 * is what makes the lookup work on the device.
 */
function put(target, key, value) {
  const parts = key.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Compile the authored set.
 *
 * Returns the catalog parts plus the issue list. Nothing throws on bad content:
 * an author fixing a course wants every problem at once, not the first one.
 */
export function compileCourses(knownMissionIds = []) {
  const loaded = loadCourses();
  const issues = [];

  const courses = [];
  const lessons = [];
  const lessonParts = {};
  const answers = {};
  const lessonNodes = {};
  const strings = { id: {}, en: {} };
  const flat = { id: {}, en: {} };

  /** Record a localised bundle under a generated key, returning the key. */
  const emit = (key, bundle, where) => {
    if (!bundle || typeof bundle !== 'object') {
      issues.push({ severity: 'error', check: 'strings', missionId: where, message: `${key} has no text` });
      return key;
    }
    for (const locale of LOCALES) {
      const value = bundle[locale];
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      put(strings[locale], key, value.trim());
      flat[locale][key] = value.trim();
    }
    return key;
  };

  for (const { file, course } of loaded) {
    if (!course || typeof course !== 'object' || !course.id) {
      issues.push({ severity: 'error', check: 'schema', missionId: file, message: 'course has no id' });
      continue;
    }

    const courseId = course.id;
    const base = `course.${courseId}`;

    // Review is a publication gate, not metadata. Cybersecurity
    // content that is wrong is worse than none, so a `sec.*` course with no
    // factual reviewer must not reach a student.
    for (const pass of ['pedagogy', 'factual', 'language']) {
      const record = course.review?.[pass];
      if (!record || typeof record.by !== 'string' || typeof record.on !== 'string') {
        issues.push({
          severity: 'error',
          check: 'review',
          missionId: courseId,
          message: `no ${pass} review recorded`,
        });
      } else if (record.by === course.author) {
        // The author approving their own work on the same document is the
        // failure the separate-pass rule exists to prevent.
        issues.push({
          severity: 'error',
          check: 'review',
          missionId: courseId,
          message: `${pass} review is by the author`,
        });
      }
    }

    const index = [];
    const bodies = [];

    for (const authored of course.lessons ?? []) {
      const lessonId = `${courseId}.${authored.id}`;
      const lessonBase = `${base}.${authored.id}`;
      const blocks = [];

      let blockNumber = 0;
      for (const block of authored.blocks ?? []) {
        const key = `${lessonBase}.b${pad(++blockNumber)}`;
        switch (block.kind) {
          case 'text':
            blocks.push({ kind: 'text', textKey: emit(key, block.text, lessonId) });
            break;
          case 'example':
            blocks.push({
              kind: 'example',
              textKey: emit(key, block.text, lessonId),
              ...(block.caption ? { captionKey: emit(`${key}.caption`, block.caption, lessonId) } : {}),
            });
            break;
          case 'callout':
            blocks.push({
              kind: 'callout',
              tone: block.tone ?? 'tip',
              textKey: emit(key, block.text, lessonId),
            });
            break;
          case 'image':
            blocks.push({
              kind: 'image',
              assetId: block.asset,
              altKey: emit(`${key}.alt`, block.alt, lessonId),
            });
            break;
          case 'gameLink':
            blocks.push({
              kind: 'gameLink',
              missionId: block.mission,
              labelKey: emit(`${key}.label`, block.label, lessonId),
            });
            break;
          default:
            issues.push({
              severity: 'error',
              check: 'schema',
              missionId: lessonId,
              message: `unknown block kind "${block.kind}"`,
            });
        }
      }

      let check;
      if (authored.check) {
        const checkId = lessonId;
        const passMark = authored.check.passMark ?? 0.7;
        const items = [];
        const keyItems = [];

        let itemNumber = 0;
        for (const item of authored.check.items ?? []) {
          const itemId = `q${pad(++itemNumber)}`;
          const itemBase = `${lessonBase}.${itemId}`;
          const explainKey = emit(`${itemBase}.explain`, item.explain, lessonId);
          const promptKey = emit(`${itemBase}.prompt`, item.prompt, lessonId);

          const common = { id: itemId, kind: item.kind, promptKey, explainKey };
          let correct;

          if (item.kind === 'choice') {
            const optionKeys = (item.options ?? []).map((option, i) =>
              emit(`${itemBase}.o${i + 1}`, option, lessonId),
            );
            correct = item.answer;
            items.push({ ...common, optionKeys, answerHash: answerHashFor(checkId, itemId, correct) });
          } else if (item.kind === 'order') {
            const fragmentKeys = (item.fragments ?? []).map((fragment, i) =>
              emit(`${itemBase}.f${i + 1}`, fragment, lessonId),
            );
            correct = item.answer;
            items.push({ ...common, fragmentKeys, answerHash: answerHashFor(checkId, itemId, correct) });
          } else if (item.kind === 'predict') {
            correct = item.answer;
            items.push({
              ...common,
              position: item.position,
              answerHash: answerHashFor(checkId, itemId, correct),
            });
          } else {
            issues.push({
              severity: 'error',
              check: 'schema',
              missionId: lessonId,
              message: `unknown check item kind "${item.kind}"`,
            });
            continue;
          }

          keyItems.push({ itemId, correct, explainKey });
        }

        check = { id: checkId, passMark, items };
        answers[checkId] = { items: keyItems, passMark, skillWeights: authored.check.weights ?? {} };
        // Heaviest first, so `lessonForNode` can pick the lesson that leans on
        // a node rather than the first one that mentions it.
        const weights = authored.check.weights ?? {};
        lessonNodes[lessonId] = Object.keys(weights).sort((a, b) => weights[b] - weights[a]);
      }

      const lesson = {
        id: lessonId,
        courseId,
        titleKey: emit(`${lessonBase}.title`, authored.title, lessonId),
        readingMinutes: authored.readingMinutes,
        skillNodes: lessonNodes[lessonId] ?? [],
        blocks,
        ...(check ? { check } : {}),
      };

      bodies.push(lesson);
      lessons.push(lesson);
      index.push({
        id: lessonId,
        titleKey: lesson.titleKey,
        readingMinutes: lesson.readingMinutes,
        hasCheck: check !== undefined,
      });
    }

    lessonParts[`lessons.${courseId}`] = bodies;
    courses.push({
      id: courseId,
      domain: course.domain,
      contentVersion: course.contentVersion ?? 1,
      titleKey: emit(`${base}.title`, course.title, courseId),
      summaryKey: emit(`${base}.summary`, course.summary, courseId),
      skillNodes: course.skillNodes ?? [],
      entitlement: course.entitlement ?? 'free',
      prerequisites: course.prerequisites ?? [],
      lessons: index,
    });
  }

  for (const issue of validateCourseSet({
    courses,
    lessons,
    answers,
    lessonNodes,
    strings: flat,
    knownMissionIds,
  })) {
    issues.push(issue);
  }

  return { courses, lessons, lessonParts, answers, lessonNodes, strings, issues };
}
