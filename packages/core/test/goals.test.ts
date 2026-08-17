/**
 * Goal evaluation — the code that decides whether a student won.
 *
 * This was the least-covered file in the core at 33% of branches, which is a
 * bad place for a gap: every clause here is the difference between a mission
 * being passed and a student being told they failed something they did. The
 * cases below are the ones where "achieved" and "terminal" can disagree, since
 * those are what decide whether a session ends and whether it counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine } from '../dist/rules/benteng/index.js';
import { congklakEngine } from '../dist/rules/congklak/index.js';
import type { BentengState } from '../dist/rules/benteng/state.js';
import type { CongklakState } from '../dist/rules/congklak/state.js';
import type { MissionGoal } from '../dist/types/mission.js';

// ---------------------------------------------------------------------------
// Benteng
// ---------------------------------------------------------------------------

function bentengState(overrides: Partial<BentengState> = {}): BentengState {
  const base = bentengEngine.init(
    {
      game: 'benteng',
      width: 5,
      height: 5,
      bases: [
        { side: 1, x: 2, y: 4 },
        { side: 2, x: 2, y: 0 },
      ],
      units: [
        { id: 'p1', side: 1, x: 2, y: 3 },
        { id: 'e1', side: 2, x: 2, y: 1 },
      ],
      toMove: 1,
    },
    { freshnessWindow: 0 },
  ) as BentengState;

  return { ...base, ...overrides };
}

const evaluate = (state: BentengState, goal: MissionGoal) =>
  bentengEngine.evaluateGoal(state as never, goal);

test('reach_base is met only by a won game', () => {
  assert.equal(evaluate(bentengState({ outcome: 'won', finished: true }), { kind: 'reach_base' }).achieved, true);
  assert.equal(evaluate(bentengState({ outcome: 'lost', finished: true }), { kind: 'reach_base' }).achieved, false);
  assert.equal(evaluate(bentengState(), { kind: 'reach_base' }).achieved, false);
});

test('capture_units counts what the opponent lost, not what the player lost', () => {
  // unitsLostBy is indexed by the team that *lost* units, so capturing two of
  // team 2's units shows up in slot 1. Reading the wrong slot would credit a
  // student for their own losses.
  const state = bentengState({ unitsLostBy: [0, 2] });
  const goal: MissionGoal = { kind: 'capture_units', count: 2 };

  assert.equal(evaluate(state, goal).achieved, true);
  assert.equal(evaluate(bentengState({ unitsLostBy: [2, 0] }), goal).achieved, false);
});

test('a defence goal cannot be satisfied by a lost game', () => {
  // The counter can run to its target on the turn the base falls. Awarding the
  // goal then would tell a student they successfully defended a base they lost.
  const held = bentengState({ baseHeldTurns: 10, outcome: 'lost', finished: true });
  assert.equal(evaluate(held, { kind: 'defend_base', turns: 8 }).achieved, false);

  const survived = bentengState({ baseHeldTurns: 10, outcome: 'playing' });
  assert.equal(evaluate(survived, { kind: 'defend_base', turns: 8 }).achieved, true);
});

test('no_exposure becomes terminal the moment it is broken', () => {
  const clean = evaluate(bentengState({ maxExposureTurns: 0 }), { kind: 'no_exposure' });
  assert.equal(clean.achieved, true);
  // Not terminal while clean: the student can still break it by playing on.
  assert.equal(clean.terminal, false);

  const broken = evaluate(bentengState({ maxExposureTurns: 1 }), { kind: 'no_exposure' });
  assert.equal(broken.achieved, false);
  // Terminal once broken: continuing cannot un-expose a unit, so the session
  // should end rather than let a student play on toward a result they can no
  // longer reach.
  assert.equal(broken.terminal, true);
});

test('survive reports partial progress before it is met', () => {
  const half = evaluate(bentengState({ turnsWithoutLoss: 5 }), { kind: 'survive', turns: 10 });
  assert.equal(half.achieved, false);
  assert.equal(half.progress, 0.5);
});

test('within fails when the move budget runs out', () => {
  const goal: MissionGoal = { kind: 'within', moves: 6, goal: { kind: 'reach_base' } };

  const early = evaluate(bentengState({ turn: 2 }), goal);
  assert.equal(early.achieved, false);
  assert.equal(early.terminal, false);

  const late = evaluate(bentengState({ turn: 6 }), goal);
  assert.equal(late.achieved, false);
  assert.equal(late.terminal, true, 'exceeding the budget has to end the attempt');

  // Meeting the inner goal inside the budget passes it straight through.
  const won = evaluate(bentengState({ turn: 3, outcome: 'won', finished: true }), goal);
  assert.equal(won.achieved, true);
});

test('all requires every sub-goal, and ends early when one is unreachable', () => {
  const goal: MissionGoal = {
    kind: 'all',
    goals: [{ kind: 'reach_base' }, { kind: 'no_exposure' }],
  };

  const both = evaluate(
    bentengState({ outcome: 'won', finished: true, maxExposureTurns: 0 }),
    goal,
  );
  assert.equal(both.achieved, true);

  // Exposure is already broken, so the compound goal can never be met however
  // the rest of the game goes.
  const spoiled = evaluate(bentengState({ maxExposureTurns: 3 }), goal);
  assert.equal(spoiled.achieved, false);
  assert.equal(spoiled.terminal, true);
});

test('an empty all is vacuously met rather than dividing by zero', () => {
  const result = evaluate(bentengState(), { kind: 'all', goals: [] });
  assert.equal(result.achieved, true);
  assert.equal(result.progress, 1);
});

test('a Congklak goal on a Benteng board is unmet, not a crash', () => {
  // A malformed mission should fail content validation, not throw inside a
  // student's session.
  const result = evaluate(bentengState(), { kind: 'collect', count: 4 });
  assert.equal(result.achieved, false);
  assert.equal(result.progress, 0);
});

// ---------------------------------------------------------------------------
// Congklak
// ---------------------------------------------------------------------------

function congklakState(overrides: Partial<CongklakState> = {}): CongklakState {
  const base = congklakEngine.init(
    {
      game: 'congklak',
      pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
      playerSide: 1,
      toMove: 1,
    },
    {},
  ) as CongklakState;
  return { ...base, ...overrides };
}

const evaluateC = (state: CongklakState, goal: MissionGoal) =>
  congklakEngine.evaluateGoal(state as never, goal);

test('collect measures the store, and reports progress toward it', () => {
  const pits = [0, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3];
  const half = evaluateC(congklakState({ pits }), { kind: 'collect', count: 8 });
  assert.equal(half.achieved, false);
  assert.equal(half.progress, 0.5);

  const met = evaluateC(congklakState({ pits }), { kind: 'collect', count: 4 });
  assert.equal(met.achieved, true);
});

test('outscore needs a finished game and a real margin', () => {
  const ahead = [0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0];
  const behind = [18, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0];

  assert.equal(
    evaluateC(congklakState({ pits: ahead, finished: true }), { kind: 'outscore' }).achieved,
    true,
  );
  // A two-seed lead does not satisfy a margin of three.
  assert.equal(
    evaluateC(congklakState({ pits: behind, finished: true }), { kind: 'outscore', margin: 3 })
      .achieved,
    false,
  );
});

test('chain and extra-turn goals read the player’s own counters', () => {
  // The counters are per side. Reading the opponent's would credit a student
  // for a chain the machine built.
  assert.equal(
    evaluateC(congklakState({ maxChainBy: [4, 0] }), { kind: 'chain', count: 4 }).achieved,
    true,
  );
  assert.equal(
    evaluateC(congklakState({ maxChainBy: [0, 4] }), { kind: 'chain', count: 4 }).achieved,
    false,
    'the opponent’s chain is not the student’s',
  );

  assert.equal(
    evaluateC(congklakState({ extraTurnsBy: [2, 0] }), { kind: 'extra_turns', count: 2 }).achieved,
    true,
  );
  // `consecutive` reads a different counter: two extra turns spread across a
  // game is not the same achievement as two in a row.
  assert.equal(
    evaluateC(congklakState({ extraTurnsBy: [2, 0], consecutiveExtraBy: [1, 0] }), {
      kind: 'extra_turns',
      count: 2,
      consecutive: true,
    }).achieved,
    false,
  );
});
