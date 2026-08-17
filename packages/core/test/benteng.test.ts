import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine } from '../dist/rules/benteng/index.js';
import { legalityOf } from '../dist/rules/benteng/moves.js';
import { freshnessOf, isCapturable } from '../dist/rules/benteng/state.js';
import type { BentengState, BentengMove } from '../dist/index.js';
import type { BentengSetup, GameConfig } from '../dist/types/mission.js';

function setup(over: Partial<BentengSetup> = {}): BentengSetup {
  return {
    game: 'benteng',
    width: 5,
    height: 5,
    bases: [
      { side: 1, x: 0, y: 4 },
      { side: 2, x: 4, y: 0 },
    ],
    units: [
      { id: 'p1', side: 1, x: 0, y: 4 },
      { id: 'e1', side: 2, x: 4, y: 0 },
    ],
    toMove: 1,
    ...over,
  } as BentengSetup;
}

function init(over: Partial<BentengSetup> = {}, config: GameConfig = {}): BentengState {
  return bentengEngine.init(setup(over), config) as BentengState;
}

const move = (unitId: string, x: number, y: number): BentengMove => ({ kind: 'move', unitId, x, y });

// ---------------------------------------------------------------------------
// The freshness rule — the whole game
// ---------------------------------------------------------------------------

test('a fresher unit may capture a staler one', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'e1', side: 2, x: 2, y: 3 },
    ],
  });
  // The player refreshed on turn 5; the enemy has not touched base since 0.
  state.turn = 5;
  (state.units[0] as { lastTouchedBaseOnTurn: number }).lastTouchedBaseOnTurn = 5;
  (state.units[1] as { lastTouchedBaseOnTurn: number }).lastTouchedBaseOnTurn = 0;

  assert.equal(freshnessOf(state, state.units[0]!), 0);
  assert.equal(freshnessOf(state, state.units[1]!), 5);
  assert.equal(bentengEngine.isLegal(state, move('p1', 2, 3)), true);

  const after = bentengEngine.applyMove(state, move('p1', 2, 3)).state as BentengState;
  assert.equal(after.units[1]!.captured, true, 'the staler unit is taken prisoner');
  assert.equal(after.prisoners.length, 1);
  assert.equal(after.prisoners[0]!.heldBy, 1);
});

test('a staler unit may not capture a fresher one', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'e1', side: 2, x: 2, y: 3 },
    ],
  });
  state.turn = 5;
  state.units[0]!.lastTouchedBaseOnTurn = 0; // stale
  state.units[1]!.lastTouchedBaseOnTurn = 5; // fresh

  const legality = legalityOf(state, move('p1', 2, 3));
  assert.equal(legality.legal, false);
  assert.equal(legality.reason, 'stale');
  // Both numbers are surfaced so the UI can state the comparison rather than
  // just buzzing.
  assert.deepEqual(legality.rejection, { moverFreshness: 5, targetFreshness: 0 });
});

test('equal freshness does not permit a capture', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'e1', side: 2, x: 2, y: 3 },
    ],
  });
  state.turn = 3;
  state.units[0]!.lastTouchedBaseOnTurn = 1;
  state.units[1]!.lastTouchedBaseOnTurn = 1;

  assert.equal(bentengEngine.isLegal(state, move('p1', 2, 3)), false);
});

test('a stale capture attempt is counted, not silently ignored', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'e1', side: 2, x: 2, y: 3 },
    ],
  });
  state.turn = 5;
  state.units[0]!.lastTouchedBaseOnTurn = 0;
  state.units[1]!.lastTouchedBaseOnTurn = 5;

  const result = bentengEngine.applyMove(state, move('p1', 2, 3));
  const after = result.state as BentengState;

  assert.equal(after.illegalCaptureAttempts, 1, 'the misconception is measurable');
  assert.equal(result.turnEnded, false, 'and the student does not lose their turn to it');
  assert.equal(after.units[1]!.captured, false);
});

test('touching your own base resets freshness to zero', () => {
  // This is the m03 moment: the same enemy is untouchable, then touchable, and
  // the only thing that changed is the age of your own authority.
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 0, y: 3 },
      { id: 'e1', side: 2, x: 4, y: 4 },
    ],
  });
  state.turn = 6;
  state.units[0]!.lastTouchedBaseOnTurn = 0;

  assert.equal(freshnessOf(state, state.units[0]!), 6, 'stale before');

  const after = bentengEngine.applyMove(state, move('p1', 0, 4)).state as BentengState;
  const refreshed = after.units.find((u) => u.id === 'p1')!;
  assert.equal(refreshed.lastTouchedBaseOnTurn, 6);
  assert.equal(freshnessOf(after, refreshed), after.turn - 6);
  assert.equal(after.refreshCount, 1);
});

// ---------------------------------------------------------------------------
// Movement, win, loss
// ---------------------------------------------------------------------------

test('units move exactly one orthogonal step, inside the grid', () => {
  const state = init({ units: [{ id: 'p1', side: 1, x: 2, y: 2 }] });

  assert.equal(bentengEngine.isLegal(state, move('p1', 2, 1)), true);
  assert.equal(bentengEngine.isLegal(state, move('p1', 3, 3)), false, 'diagonal');
  assert.equal(bentengEngine.isLegal(state, move('p1', 2, 4)), false, 'two steps');
  assert.equal(legalityOf(state, move('p1', -1, 2)).reason, 'out_of_bounds');
  assert.equal(legalityOf(state, move('nope', 2, 1)).reason, 'not_found');
});

test('a unit may not move onto an ally', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'p2', side: 1, x: 2, y: 3 },
    ],
  });
  assert.equal(legalityOf(state, move('p1', 2, 3)).reason, 'occupied_ally');
});

test('reaching the enemy base wins immediately', () => {
  const state = init({ units: [{ id: 'p1', side: 1, x: 4, y: 1 }] });
  const after = bentengEngine.applyMove(state, move('p1', 4, 0)).state as BentengState;

  assert.equal(after.outcome, 'won');
  assert.equal(after.finished, true);
  assert.equal(bentengEngine.evaluateGoal(after, { kind: 'reach_base' }).achieved, true);
});

test('the opponent reaching your base is a loss', () => {
  const state = init({ units: [{ id: 'e1', side: 2, x: 0, y: 3 }], toMove: 2 });
  const after = bentengEngine.applyMove(state, move('e1', 0, 4)).state as BentengState;

  assert.equal(after.outcome, 'lost');
  assert.equal(bentengEngine.evaluateGoal(after, { kind: 'reach_base' }).achieved, false);
});

test('losing every unit ends the game', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'e1', side: 2, x: 2, y: 3 },
    ],
    toMove: 2,
  });
  state.turn = 5;
  state.units[0]!.lastTouchedBaseOnTurn = 0;
  state.units[1]!.lastTouchedBaseOnTurn = 5;

  const after = bentengEngine.applyMove(state, move('e1', 2, 2)).state as BentengState;
  assert.equal(after.outcome, 'lost');
  assert.equal(after.finished, true);
});

test('a rescue frees a prisoner back to its own base at full freshness', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 4, y: 1 },
      { id: 'p2', side: 1, x: 2, y: 2 },
      // The enemy is away from its base, so the square holds only the
      // prisoner — otherwise this would be a capture attempt, not a rescue.
      { id: 'e1', side: 2, x: 0, y: 0 },
    ],
  });
  // p2 is already a prisoner, held at the enemy base.
  state.units[1]!.captured = true;
  state.units[1]!.x = 4;
  state.units[1]!.y = 0;
  state.prisoners.push({ unitId: 'p2', heldBy: 2 });
  state.unitsLostBy[0] = 1;
  state.turn = 4;

  // p1 steps onto the prisoner's square. That square is the enemy base, so the
  // move also wins — check the rescue bookkeeping regardless.
  const after = bentengEngine.applyMove(state, move('p1', 4, 0)).state as BentengState;
  const freed = after.units.find((u) => u.id === 'p2')!;

  assert.equal(freed.captured, false, 'the prisoner is freed');
  assert.equal(freed.x, 0);
  assert.equal(freed.y, 4, 'and returns to its own base');
  assert.equal(freshnessOf(after, freed), 0, 'at freshness 0');
  assert.equal(after.rescuesPerformed, 1);
  assert.equal(after.prisoners.length, 0);
});

// ---------------------------------------------------------------------------
// Exposure and determinism
// ---------------------------------------------------------------------------

test('isCapturable reports the exposure a student is taking on', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 2, y: 2 },
      { id: 'e1', side: 2, x: 2, y: 3 },
    ],
  });
  state.turn = 5;
  state.units[0]!.lastTouchedBaseOnTurn = 0; // stale player unit
  state.units[1]!.lastTouchedBaseOnTurn = 5; // fresh enemy adjacent

  assert.equal(isCapturable(state, state.units[0]!), true);
  assert.equal(isCapturable(state, state.units[1]!), false);
});

test('AI moves are identical across repeated calls', () => {
  const state = init({
    units: [
      { id: 'p1', side: 1, x: 1, y: 3 },
      { id: 'p2', side: 1, x: 0, y: 4 },
      { id: 'e1', side: 2, x: 3, y: 1 },
      { id: 'e2', side: 2, x: 4, y: 0 },
    ],
    toMove: 2,
  });

  for (const tier of ['mudah', 'sedang', 'sulit'] as const) {
    const first = bentengEngine.aiMove(state, tier, 777);
    for (let i = 0; i < 500; i++) {
      assert.deepEqual(bentengEngine.aiMove(state, tier, 777), first, `${tier} diverged`);
    }
  }
});

test('applyMove never mutates its argument', () => {
  const state = init({ units: [{ id: 'p1', side: 1, x: 2, y: 2 }] });
  const before = JSON.stringify(state);
  bentengEngine.applyMove(state, move('p1', 2, 1));
  assert.equal(JSON.stringify(state), before);
});

test('hashing is insensitive to unit ordering', () => {
  const a = init({
    units: [
      { id: 'p1', side: 1, x: 0, y: 4 },
      { id: 'e1', side: 2, x: 4, y: 0 },
    ],
  });
  const b = init({
    units: [
      { id: 'e1', side: 2, x: 4, y: 0 },
      { id: 'p1', side: 1, x: 0, y: 4 },
    ],
  });
  assert.equal(bentengEngine.hash(a), bentengEngine.hash(b));
});

test('a full game against the AI terminates', () => {
  let state = init({
    width: 7,
    height: 7,
    bases: [
      { side: 1, x: 0, y: 6 },
      { side: 2, x: 6, y: 0 },
    ],
    units: [
      { id: 'p1', side: 1, x: 0, y: 6 },
      { id: 'p2', side: 1, x: 1, y: 6 },
      { id: 'e1', side: 2, x: 6, y: 0 },
      { id: 'e2', side: 2, x: 5, y: 0 },
    ],
  });

  for (let i = 0; i < 500 && !state.finished; i++) {
    const chosen = bentengEngine.aiMove(state, state.toMove === 1 ? 'sedang' : 'sulit', i);
    if (!chosen) break;
    state = bentengEngine.applyMove(state, chosen).state as BentengState;
  }
  assert.equal(state.finished, true, 'the turn limit or a win must end the game');
});
