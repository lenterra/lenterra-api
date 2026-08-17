/**
 * Turning a rule off has to actually turn it off.
 *
 * Early missions disable capture, chaining, and extra turns so one idea lands
 * before the next arrives — mission 1 teaches sowing and nothing else. If a
 * disabled rule still fires, the mission teaches two things at once and the
 * student meets a mechanic nobody has explained, in a mission whose brief does
 * not mention it. Nothing tested these toggles, so every one of them was a
 * claim the ladder made and nothing checked.
 *
 * Benteng's freshness window is the same shape: relaxing it for early ranks is
 * how the concept lands before the pressure does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bentengEngine, congklakEngine, hashConfig } from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { BentengMove, BentengState, CongklakMove, CongklakState } from '../dist/index.js';

const PITS = [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3];

function congklak(config: Record<string, unknown>, pits: number[] = PITS, toMove: 1 | 2 = 1) {
  return congklakEngine.init(
    { game: 'congklak', pits, playerSide: 1, toMove } as never,
    config as never,
  ) as CongklakState;
}

const sow = (state: CongklakState, pit: number) =>
  congklakEngine.applyMove(state as never, { kind: 'sow', pit } as never);

// ---------------------------------------------------------------------------
// Congklak toggles
// ---------------------------------------------------------------------------

test('extraTurnOnStore off means a seed landing in the store passes the turn', () => {
  // Sowing runs upward and wraps, skipping the opponent's store at 0, so side
  // 1 reaches its own store at 6 from pit 11 in six steps. A pit holding
  // exactly its distance to the store is what grants the extra turn.
  const pits = [0, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 6];
  const on = sow(
    congklak({ extraTurnOnStore: true, continuationEnabled: false, captureEnabled: false }, pits),
    11,
  );
  const off = sow(
    congklak({ extraTurnOnStore: false, continuationEnabled: false, captureEnabled: false }, pits),
    11,
  );

  assert.ok(
    (on.state as CongklakState).extraTurnsBy[0] > 0,
    'the fixture should land the last seed in the store',
  );
  assert.equal(
    (off.state as CongklakState).extraTurnsBy[0],
    0,
    'a disabled extra turn must not be granted',
  );
  assert.equal(on.turnEnded, false);
  assert.equal(off.turnEnded, true);
});

test('continuationEnabled off stops a chain before it starts', () => {
  const withChain = congklak({ continuationEnabled: true, captureEnabled: false });
  const without = congklak({ continuationEnabled: false, captureEnabled: false });

  const chained = sow(withChain, 7).state as CongklakState;
  const plain = sow(without, 7).state as CongklakState;

  assert.ok(
    chained.maxChainBy[0] > plain.maxChainBy[0],
    'the chaining board should chain and the other should not',
  );
  assert.equal(plain.maxChainBy[0], 0);
});

test('captureEnabled off means landing in an empty own pit captures nothing', () => {
  // Pit 7 holds one seed and lands in the empty pit 8, whose opposite holds a
  // pile — the capture shape, and unmissable when captures are on.
  const pits = [0, 3, 3, 3, 9, 3, 0, 1, 0, 3, 3, 3];

  const on = sow(
    congklak({ captureEnabled: true, continuationEnabled: false, extraTurnOnStore: false }, pits),
    7,
  ).state as CongklakState;
  const off = sow(
    congklak({ captureEnabled: false, continuationEnabled: false, extraTurnOnStore: false }, pits),
    7,
  ).state as CongklakState;

  assert.ok(
    on.capturedBy[0] > off.capturedBy[0],
    'the capturing board should capture and the other should not',
  );
  assert.equal(off.capturedBy[0], 0, 'a disabled capture must not fire');
});

test('the seed total is conserved however the game ends', () => {
  // Whatever the sweep does, seeds may not be created or destroyed. A rule that
  // loses one would show up as a score nobody can reconcile with the board.
  const pits = [0, 4, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  const total = pits.reduce((sum, count) => sum + count, 0);

  for (const sweepOnEnd of [true, false]) {
    const after = sow(
      congklak({ sweepOnEnd, continuationEnabled: false, captureEnabled: false }, pits),
      7,
    ).state as CongklakState;
    assert.equal(
      after.pits.reduce((sum, count) => sum + count, 0),
      total,
      `seeds must be conserved with sweepOnEnd ${sweepOnEnd}`,
    );
  }
});

test('a config change changes the config hash, so a client playing other rules is caught', () => {
  const base: Mission = {
    id: 'congklak.m01',
    game: 'congklak',
    rank: 1,
    contentVersion: 1,
    skillWeights: { 'comp.counting': 1 },
    eloDifficulty: 700,
    goal: { kind: 'collect', count: 1 },
    setup: { game: 'congklak', pits: PITS, playerSide: 1, toMove: 1 },
    constraints: {},
    config: { extraTurnOnStore: false, captureEnabled: false, continuationEnabled: false },
    seed: 1,
    rationale: 'Sowing seeds one at a time from a chosen pit until the hand is empty.',
    titleKey: 'x',
    briefKey: 'x',
    hintKeys: [],
    failureKeys: { ranOut: 'x' },
  };

  const hashes = new Set([
    hashConfig(base),
    hashConfig({ ...base, config: { ...base.config, captureEnabled: true } }),
    hashConfig({ ...base, config: { ...base.config, continuationEnabled: true } }),
    hashConfig({ ...base, config: { ...base.config, extraTurnOnStore: true } }),
  ]);

  // Four distinct rule sets must produce four distinct hashes, or a replay
  // played under one could be validated under another.
  assert.equal(hashes.size, 4);
});

test('an unspecified toggle falls back to the standard rule, not to off', () => {
  // A mission that says nothing about capture gets the real game, because the
  // defaults are the game as it is normally played.
  const bare = congklak({});
  const explicit = congklak({
    extraTurnOnStore: true,
    captureEnabled: true,
    continuationEnabled: true,
    sweepOnEnd: true,
  });
  assert.equal(congklakEngine.hash(bare as never), congklakEngine.hash(explicit as never));
});

// ---------------------------------------------------------------------------
// Benteng's freshness window
// ---------------------------------------------------------------------------

const GRID = {
  game: 'benteng' as const,
  width: 5,
  height: 5,
  bases: [
    { side: 1 as const, x: 2, y: 4 },
    { side: 2 as const, x: 2, y: 0 },
  ],
  toMove: 1 as const,
};

function benteng(config: Record<string, unknown>, units: unknown[]) {
  return bentengEngine.init({ ...GRID, units } as never, config as never) as BentengState;
}

test('a freshness window protects a unit that would otherwise be capturable', () => {
  const units = [
    { id: 'p1', side: 1, x: 2, y: 3, freshness: 0 },
    { id: 'e1', side: 2, x: 2, y: 2, freshness: 2 },
  ];
  const capture: BentengMove = { kind: 'move', unitId: 'p1', x: 2, y: 2 };

  // Strict: two turns stale against a fresh unit is capturable.
  assert.equal(
    bentengEngine.isLegal(benteng({ freshnessWindow: 0 }, units) as never, capture as never),
    true,
  );

  // Relaxed: a window of three turns covers it, which is how an early rank
  // teaches the freshness reading before it teaches the pressure.
  assert.equal(
    bentengEngine.isLegal(benteng({ freshnessWindow: 3 }, units) as never, capture as never),
    false,
  );
});

test('the freshness window does not make anything permanently safe', () => {
  const units = [
    { id: 'p1', side: 1, x: 2, y: 3, freshness: 0 },
    { id: 'e1', side: 2, x: 2, y: 2, freshness: 9 },
  ];
  // Long past the window, so the protection has lapsed as it should.
  assert.equal(
    bentengEngine.isLegal(
      benteng({ freshnessWindow: 3 }, units) as never,
      { kind: 'move', unitId: 'p1', x: 2, y: 2 } as never,
    ),
    true,
  );
});

test('a unit standing on its own base cannot be taken, and blocks the square', () => {
  // The property that made a 7×7 four-unit tier unwinnable, pinned here so a
  // future board size cannot rediscover it the hard way. A unit on its own base
  // refreshes every turn, so its freshness is permanently zero and no attacker
  // can ever be strictly lower — which means the square it occupies cannot be
  // entered at all, and a `reach_base` goal behind it is unreachable.
  const state = benteng({ freshnessWindow: 0 }, [
    { id: 'p1', side: 1, x: 2, y: 1, freshness: 0 },
    { id: 'e1', side: 2, x: 2, y: 0, freshness: 0 },
  ]);

  const onto = { kind: 'move', unitId: 'p1', x: 2, y: 0 } as BentengMove;
  assert.equal(bentengEngine.isLegal(state as never, onto as never), false);
  assert.equal(
    bentengEngine.legalMoves(state as never).some((move) => {
      const target = move as BentengMove;
      return target.x === 2 && target.y === 0;
    }),
    false,
    'the guarded base square is not offered as a move',
  );

  // With the guard gone, the same move wins.
  const open = benteng({ freshnessWindow: 0 }, [
    { id: 'p1', side: 1, x: 2, y: 1, freshness: 0 },
    { id: 'e1', side: 2, x: 4, y: 0, freshness: 0 },
  ]);
  const won = bentengEngine.applyMove(open as never, onto as never).state as BentengState;
  assert.equal(won.outcome, 'won');
});

test('a turn limit ends the game as a loss rather than running forever', () => {
  const state = benteng({ freshnessWindow: 0 }, [
    { id: 'p1', side: 1, x: 0, y: 4, freshness: 0 },
    { id: 'e1', side: 2, x: 4, y: 0, freshness: 0 },
  ]);

  let current = state;
  // Shuffle a unit back and forth well past any sensible limit.
  for (let i = 0; i < 200 && !current.finished; i++) {
    const legal = bentengEngine.legalMoves(current as never) as BentengMove[];
    if (legal.length === 0) break;
    current = bentengEngine.applyMove(current as never, legal[0] as never).state as BentengState;
  }

  assert.equal(current.finished, true, 'a game must terminate rather than run indefinitely');
});
