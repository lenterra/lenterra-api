#!/usr/bin/env node
// Runs every content check and fails the build on an error.
//
// Two reviewers still have to approve a mission (PRD-CNT-005) — this cannot
// judge whether a mission teaches anything. What it can do is refuse the ways
// content breaks silently: weights that do not sum, a skill claimed with no
// mechanic behind it, a ladder with a gap, a mission nobody can win, and a
// greedy-trap quota that has quietly eroded as content was added.

import { checkAll, checkTeachingNotes, report } from './content-lib.mjs';
import { compileCourses } from './course-lib.mjs';
import { checkGreedyTrapQuota } from '../packages/core/dist/index.js';

const games = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const skipSolver = process.argv.includes('--fast');
const targets = games.length > 0 ? games : ['congklak', 'benteng'];

let totalErrors = 0;
let totalWarnings = 0;
const allMissionIds = [];

for (const game of targets) {
  const { missions, issues, solved, traps } = checkAll(game, { skipSolver });

  if (missions.length === 0) {
    console.log(`${game}: no missions authored yet`);
    continue;
  }

  const all = issues.slice();
  if (game === 'congklak' && !skipSolver) {
    for (const issue of checkGreedyTrapQuota(missions, traps)) all.push(issue);
  }

  console.log(`\n${game}: ${missions.length} missions`);
  const counts = report(all);
  totalErrors += counts.errors;
  totalWarnings += counts.warnings;

  if (!skipSolver) {
    const lines = missions
      .map((m) => {
        const s = solved.get(m.id);
        const line = s?.solvable
          ? `${s.line.length} move(s)${s.fromReferenceLine ? ' (authored)' : ''}`
          : 'UNSOLVED';
        const trap = traps.has(m.id) ? ' · greedy trap' : '';
        return `  rank ${String(m.rank).padStart(2)}  ${m.id.padEnd(16)} elo ${String(m.eloDifficulty).padStart(4)}  ${line}${trap}`;
      })
      .join('\n');
    console.log(lines);
    if (game === 'congklak') {
      console.log(`  greedy traps: ${traps.size}/${missions.length} (need ${Math.ceil(missions.length / 3)})`);
    }
  }

  if (counts.errors === 0) console.log(`  ✓ ${game} content is valid`);
  for (const mission of missions) allMissionIds.push(mission.id);
}

// Teaching notes are checked against every game's missions at once, because a
// note for a security node points at Benteng while a computation note points
// at Congklak.
const teaching = checkTeachingNotes(allMissionIds);
if (teaching.length > 0) {
  console.log('\nteaching notes');
  const counts = report(teaching);
  totalErrors += counts.errors;
  totalWarnings += counts.warnings;
} else {
  console.log('\nteaching notes: ✓');
}

// Courses are checked against the missions that exist, because a lesson may
// send a student into a mission and a link into nothing is worse than no link.
const compiled = compileCourses(allMissionIds);
if (compiled.courses.length === 0) {
  console.log('\ncourses: none authored yet');
} else {
  const lessonCount = compiled.lessons.length;
  const checkCount = Object.keys(compiled.answers).length;
  console.log(`\ncourses: ${compiled.courses.length} courses, ${lessonCount} lessons, ${checkCount} checks`);
  const counts = report(compiled.issues);
  totalErrors += counts.errors;
  totalWarnings += counts.warnings;

  for (const course of compiled.courses) {
    const minutes = course.lessons.reduce((sum, l) => sum + l.readingMinutes, 0);
    console.log(
      `  ${course.id.padEnd(14)} ${String(course.lessons.length).padStart(2)} lessons  ` +
        `${String(minutes).padStart(2)} min  ${course.skillNodes.join(', ')}`,
    );
  }
  if (counts.errors === 0) console.log('  ✓ course content is valid');
}

console.log(`\n${totalErrors} error(s), ${totalWarnings} warning(s)`);
process.exit(totalErrors > 0 ? 1 : 0);
