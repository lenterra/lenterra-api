/**
 * What the machine opponent values.
 *
 * The evaluation function is the difficulty curve. Every mission's ELO was
 * authored against it, so a change here silently re-rates the whole ladder —
 * and its worst failure was invisible from the outside: an opponent that raced
 * for the enemy base and never defended made every full-game mission winnable
 * by walking straight up a column, which reads as the missions being easy
 * rather than the opponent being broken.
 *
 * These assert the *ordering* the evaluation has to produce rather than the
 * numbers, so the weights can be retuned without rewriting the tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine } from '../dist/index.js';
// `evaluate` is not on the package's public surface — both games define one, so
// exporting either from the root would be ambiguous. Imported from its own
// module, which is also where a caller would reach for it.
import { evaluate } from '../dist/rules/benteng/ai.js';
import type { BentengMove, BentengState } from '../dist/index.js';

const GRID = {
  game: 'benteng' as const,
  width: 5,
  height: 5,
  bases: [
    { side: 1 as const, x: 2, y: 4 },
    { side: 2 as const, x: 2, y: 0 },
  ],
};

function position(units: unknown[], toMove: 1 | 2 = 2): BentengState {
  return bentengEngine.init({ ...GRID, units, toMove } as never, {
    freshnessWindow: 0,
  } as never) as BentengState;
}

test('a won position outscores everything and a lost one is worse than everything', () => {
  const playing = position([
    { id: 'p1', side: 1, x: 2, y: 3 },
    { id: 'e1', side: 2, x: 2, y: 1 },
  ]);

  const won = { ...playing, finished: true, outcome: 'won' as const };
  const lost = { ...playing, finished: true, outcome: 'lost' as const };
  const drawn = { ...playing, finished: true, outcome: 'draw' as const };

  // `outcome` is from the student's point of view, so a win for side 1 is a
  // loss for side 2 and the sign has to flip with the team asked about.
  assert.ok(evaluate(won as never, 1) > evaluate(playing as never, 1));
  assert.ok(evaluate(won as never, 2) < evaluate(playing as never, 2));
  assert.ok(evaluate(lost as never, 1) < evaluate(playing as never, 1));
  assert.equal(evaluate(drawn as never, 1), 0);
  assert.equal(evaluate(drawn as never, 2), 0);
});

test('material advantage is valued', () => {
  const even = position([
    { id: 'p1', side: 1, x: 1, y: 3 },
    { id: 'e1', side: 2, x: 1, y: 1 },
    { id: 'e2', side: 2, x: 3, y: 1 },
  ]);
  const ahead = position([
    { id: 'p1', side: 1, x: 1, y: 3 },
    { id: 'e1', side: 2, x: 1, y: 1 },
    { id: 'e2', side: 2, x: 3, y: 1 },
    { id: 'e3', side: 2, x: 2, y: 1 },
  ]);

  assert.ok(evaluate(ahead as never, 2) > evaluate(even as never, 2));
});

test('an enemy one step from your base outweighs your own progress', () => {
  // The bug this exists to prevent. Linear distance alone made the opponent
  // indifferent between an enemy two steps out and one adjacent — six points
  // against the eight it scores for advancing itself — so it raced and never
  // defended, and every full-game mission fell to a straight walk up a column.
  const threatened = position([
    { id: 'p1', side: 1, x: 2, y: 1 },
    { id: 'e1', side: 2, x: 2, y: 3 },
  ]);
  const safe = position([
    { id: 'p1', side: 1, x: 2, y: 3 },
    { id: 'e1', side: 2, x: 2, y: 3 },
  ]);

  assert.ok(
    evaluate(threatened as never, 2) < evaluate(safe as never, 2),
    'an enemy at the door has to dominate the evaluation',
  );
});

test('the danger gradient is steep, not linear', () => {
  const at = (y: number) =>
    evaluate(
      position([
        { id: 'p1', side: 1, x: 2, y },
        { id: 'e1', side: 2, x: 0, y: 3 },
      ]) as never,
      2,
    );

  // Side 2's base is at y = 0, so a lower y is closer to it.
  const adjacent = at(1);
  const two = at(2);
  const three = at(3);

  assert.ok(adjacent < two, 'one step out must be worse than two');
  assert.ok(two < three, 'two steps out must be worse than three');
  assert.ok(
    two - adjacent > three - two,
    'the penalty has to accelerate — at one step out there is no next turn',
  );
});

test('staleness and exposure both cost something', () => {
  const fresh = position([
    { id: 'p1', side: 1, x: 0, y: 4 },
    { id: 'e1', side: 2, x: 4, y: 2, freshness: 0 },
  ]);
  const stale = position([
    { id: 'p1', side: 1, x: 0, y: 4 },
    { id: 'e1', side: 2, x: 4, y: 2, freshness: 6 },
  ]);

  assert.ok(
    evaluate(stale as never, 2) < evaluate(fresh as never, 2),
    'a stale unit is a unit that cannot act on an opportunity',
  );
});

test('a deeper tier does not simply agree with a shallower one', () => {
  // If every tier picked the same move the ladder would have one difficulty,
  // and the ELO on every mission would be a number about nothing.
  const state = position(
    [
      { id: 'p1', side: 1, x: 2, y: 2, freshness: 4 },
      { id: 'p2', side: 1, x: 0, y: 3 },
      { id: 'e1', side: 2, x: 2, y: 1, freshness: 0 },
      { id: 'e2', side: 2, x: 4, y: 1, freshness: 2 },
    ],
    2,
  );

  const picks = (['mudah', 'sedang', 'sulit'] as const).map((tier) =>
    JSON.stringify(bentengEngine.aiMove(state as never, tier, 7)),
  );

  assert.ok(picks.every((pick) => pick !== 'null'));
  assert.ok(new Set(picks).size > 1, 'the tiers should not be interchangeable here');
});

test('the opponent takes a capture that is available to it', () => {
  // A stale student unit next to a fresh enemy. An opponent that walks past
  // this is not teaching the freshness rule, it is ignoring it.
  const state = position(
    [
      { id: 'p1', side: 1, x: 2, y: 2, freshness: 5 },
      { id: 'e1', side: 2, x: 2, y: 1, freshness: 0 },
    ],
    2,
  );

  const move = bentengEngine.aiMove(state as never, 'sulit', 3) as BentengMove | null;
  assert.ok(move);
  assert.equal(move.x, 2);
  assert.equal(move.y, 2);
});

test('a mirrored position scores the same for both sides', () => {
  // Not zero-sum — this is a heuristic, and both sides can be in trouble at
  // once. What it must not do is see an asymmetry that is not there.
  const mirrored = position([
    { id: 'p1', side: 1, x: 2, y: 1 },
    { id: 'e1', side: 2, x: 2, y: 3 },
  ]);
  assert.equal(evaluate(mirrored as never, 1), evaluate(mirrored as never, 2));
});

test('a real advantage is seen by the side that holds it', () => {
  // Side 2 has an extra unit and is closer to the enemy base. If the evaluation
  // cannot separate that from the mirror above, it cannot rank moves at all.
  const lopsided = position([
    { id: 'p1', side: 1, x: 0, y: 4 },
    { id: 'e1', side: 2, x: 2, y: 3 },
    { id: 'e2', side: 2, x: 3, y: 3 },
  ]);

  assert.ok(
    evaluate(lopsided as never, 2) > evaluate(lopsided as never, 1),
    'the side with more units and better position must score higher',
  );
});
