/**
 * The class goal (PRD-SOC-009).
 *
 * The requirement has one clause that is easy to write and easy to violate:
 * the goal must be achievable by a class where several students are struggling.
 * That is asserted directly here, because a target that quietly requires every
 * student to contribute turns the one cooperative mechanic in the product into
 * another way for a class to fail together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODES_PER_STUDENT,
  classGoal,
  classGoalTarget,
  isCounted,
  MIN_CLASS_TARGET,
} from '../dist/index.js';
import type { MasteryBand } from '../dist/types/taxonomy.js';

function student(userId: string, bands: MasteryBand[]) {
  return { userId, bands };
}

test('only Proficient and above count', () => {
  assert.equal(isCounted('mastered'), true);
  assert.equal(isCounted('proficient'), true);
  assert.equal(isCounted('developing'), false);
  assert.equal(isCounted('emerging'), false);
  assert.equal(isCounted('not_started'), false);
});

test('a strong minority can carry a struggling class', () => {
  // Thirty students. Six are doing well; twenty-four have reached Proficient on
  // nothing at all. This is the shape the requirement names, and it has to be
  // winnable — otherwise the goal is a second way to tell a struggling class it
  // is failing.
  const contributions = [];
  for (let i = 0; i < 6; i++) {
    contributions.push(student(`strong-${i}`, new Array(15).fill('mastered' as MasteryBand)));
  }
  for (let i = 0; i < 24; i++) {
    contributions.push(student(`struggling-${i}`, ['developing', 'emerging']));
  }

  const goal = classGoal(30, contributions);
  assert.equal(goal.achieved, true, 'six strong students should be able to carry thirty');
  assert.equal(goal.contributors, 6);
});

test('a class where nobody has reached Proficient shows honest zero', () => {
  const goal = classGoal(30, [student('a', ['developing']), student('b', ['emerging'])]);

  assert.equal(goal.reached, 0);
  assert.equal(goal.progress, 0);
  assert.equal(goal.contributors, 0);
  assert.equal(goal.achieved, false);
});

test('overshooting is met, not exceeded', () => {
  const contributions = [student('a', new Array(200).fill('mastered' as MasteryBand))];
  const goal = classGoal(4, contributions);

  // A bar past 100% invites a race nobody set, on the one mechanic that exists
  // to be cooperative.
  assert.equal(goal.progress, 1);
  assert.equal(goal.achieved, true);
});

test('the target scales with the class and has a floor', () => {
  assert.equal(classGoalTarget(30), 30 * NODES_PER_STUDENT);
  assert.equal(classGoalTarget(1), MIN_CLASS_TARGET);
  assert.equal(classGoalTarget(0), MIN_CLASS_TARGET);
});

test('one student cannot be counted twice for the same node', () => {
  // The caller groups by student, so a duplicated node would have to come from
  // duplicated rows. Guarding the arithmetic here means a join that fans out
  // shows up as a wrong total rather than as a goal that silently completes.
  const goal = classGoal(10, [student('a', ['proficient', 'proficient', 'developing'])]);
  assert.equal(goal.reached, 2);
  assert.equal(goal.contributors, 1);
});
