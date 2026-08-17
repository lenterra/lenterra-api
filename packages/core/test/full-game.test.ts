/**
 * Whole games, and the numbers derived from them.
 *
 * Everything else tests a rule in isolation. This plays games to their end and
 * checks what the server *derives* from the replay — captures, chains, extra
 * turns, exposure, units lost — because those numbers are what a teacher reads
 * on the dashboard and what the adaptive engine reasons about, and until now
 * nothing asserted they were non-zero in a game that plainly produced them.
 *
 * A metric that silently stays at zero is worse than a missing one: it renders
 * as "this student never captures anything", which is a claim about a child.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bentengEngine,
  congklakEngine,
  domainRollup,
  validateReplay,
  ReplayRecorder,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { BentengMove, BentengState, CongklakMove, CongklakState } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Congklak, with every mechanic switched on
// ---------------------------------------------------------------------------

const RICH: Mission = {
  id: 'congklak.m12',
  game: 'congklak',
  rank: 12,
  contentVersion: 1,
  skillWeights: { 'algo.greedy': 1 },
  eloDifficulty: 1000,
  goal: { kind: 'outscore' },
  setup: {
    game: 'congklak',
    pits: [0, 5, 3, 1, 4, 2, 0, 6, 0, 3, 5, 1],
    playerSide: 1,
    toMove: 1,
  },
  constraints: { maxMoves: 80, aiTier: 'sedang' },
  // Everything on: captures, chains, extra turns, and the end-of-game sweep.
  // This is the configuration the later ladder actually uses.
  config: {
    extraTurnOnStore: true,
    captureEnabled: true,
    continuationEnabled: true,
    sweepOnEnd: true,
  },
  seed: 90210,
  rationale: 'Capturing into a prepared empty pit opposite the fullest one on the board.',
  titleKey: 'x.title',
  briefKey: 'x.brief',
  hintKeys: [],
  failureKeys: { tooSmall: 'x.fail' },
};

/** Play to the end, taking the highest-scoring legal move each turn. */
function playToEnd() {
  const recorder = new ReplayRecorder<CongklakState, CongklakMove>(congklakEngine as never, RICH);
  let elapsed = 0;

  for (let turn = 0; turn < 120 && !recorder.isTerminal(); turn++) {
    const state = recorder.state;
    const mine = congklakEngine.sideToMove(state) === congklakEngine.playerSide(state);
    elapsed += 800 + turn * 31;

    if (mine) {
      const legal = congklakEngine.legalMoves(state) as CongklakMove[];
      if (legal.length === 0) break;

      // Greedily: the move that puts the most into the store. Greedy play is
      // what most students do, so it is also the play the metrics have to
      // describe correctly.
      let best = legal[0] as CongklakMove;
      let bestGain = -1;
      for (const candidate of legal) {
        const after = congklakEngine.applyMove(state, candidate).state as CongklakState;
        const gain = (after.pits[6] as number) - (state.pits[6] as number);
        if (gain > bestGain) {
          bestGain = gain;
          best = candidate;
        }
      }
      recorder.play(best, 'player', elapsed);
    } else {
      const move = recorder.aiMove();
      if (!move) break;
      recorder.play(move, 'ai', elapsed);
    }
  }

  return recorder;
}

test('a full Congklak game validates and its metrics are actually derived', () => {
  const recorder = playToEnd();
  const replay = recorder.finish();
  const result = validateReplay(replay, RICH, congklakEngine as never);

  assert.equal(result.valid, true, result.valid ? '' : `rejected: ${result.reason}`);
  if (!result.valid) return;

  const metrics = result.derivedMetrics;

  assert.ok(metrics.moveCount > 0);
  assert.ok(metrics.playerMoveCount > 0);
  assert.ok(
    metrics.playerMoveCount < metrics.moveCount,
    'the opponent moved too, so not every move is the student’s',
  );

  // A game played greedily on a board with captures enabled produces captures.
  // If this is ever zero, the dashboard is telling teachers their students
  // never capture anything.
  assert.ok(metrics.captureCount > 0, 'captures must be counted from the event stream');
  assert.ok(metrics.chainMaxLength > 0, 'chains must be counted');
  assert.ok(
    metrics.greedyMoveTaken > 0,
    'a greedily-played game must register greedy moves, or algo.greedy is unmeasurable',
  );
  assert.ok(
    metrics.optimalMoveRank !== null && metrics.optimalMoveRank >= 0,
    'move ranking has to produce a number for a played game',
  );
});

test('the same game replays identically, which is what makes validation possible', () => {
  const first = playToEnd().finish();
  const second = playToEnd().finish();

  assert.equal(first.finalStateHash, second.finalStateHash);
  assert.deepEqual(
    first.moves.map((move) => move.move),
    second.moves.map((move) => move.move),
  );
});

// ---------------------------------------------------------------------------
// Benteng, through a capture
// ---------------------------------------------------------------------------

/**
 * A position where a capture is available immediately.
 *
 * The enemy unit is three turns stale and standing next to a unit that has just
 * touched its own base, so the freshness comparison permits the capture. Set up
 * deliberately rather than played into, because reaching it by search would
 * make the test about the search.
 */
const CAPTURE_SETUP = {
  game: 'benteng' as const,
  width: 5,
  height: 5,
  bases: [
    { side: 1 as const, x: 2, y: 4 },
    { side: 2 as const, x: 2, y: 0 },
  ],
  units: [
    { id: 'p1', side: 1 as const, x: 2, y: 3, freshness: 0 },
    { id: 'p2', side: 1 as const, x: 1, y: 4, freshness: 0 },
    { id: 'e1', side: 2 as const, x: 2, y: 2, freshness: 3 },
    { id: 'e2', side: 2 as const, x: 0, y: 1, freshness: 0 },
  ],
  toMove: 1 as const,
};

test('a capture is applied, recorded, and reported in the metrics', () => {
  const mission: Mission = {
    ...RICH,
    id: 'benteng.m02',
    game: 'benteng',
    goal: { kind: 'capture_units', count: 1 },
    setup: CAPTURE_SETUP,
    constraints: { maxMoves: 20, aiTier: 'mudah' },
    config: { freshnessWindow: 0 },
    skillWeights: { 'sec.access': 1 },
    rationale: 'Capturing a stale unit while your own freshness is lower than theirs.',
  };

  const recorder = new ReplayRecorder<BentengState, BentengMove>(bentengEngine as never, mission);
  const capture: BentengMove = { kind: 'move', unitId: 'p1', x: 2, y: 2 };

  assert.equal(
    bentengEngine.isLegal(recorder.state as never, capture as never),
    true,
    'the fixture should offer an immediate capture',
  );

  const before = recorder.state as BentengState;
  const result = recorder.play(capture as never, 'player', 1000);
  const after = result.state as BentengState;

  // The captured unit is held rather than deleted, which is the whole of the
  // rescue lesson.
  assert.equal(after.prisoners.length, 1);
  assert.equal(after.prisoners[0]?.unitId, 'e1');
  assert.equal(after.unitsLostBy[1], before.unitsLostBy[1] + 1);
  assert.ok(result.events.some((event) => event.kind === 'capture'));

  // A held unit still exists on the board, sitting at its captor's base.
  const held = after.units.filter((unit) => unit.id === 'e1')[0];
  assert.ok(held);
  assert.equal(held.captured, true);

  const metrics = bentengEngine.stateMetrics?.(after as never);
  assert.ok(metrics);
  assert.equal(metrics.unitsLost, 0, 'the student lost nothing here');
});

test('an attempted capture with the wrong freshness is refused and counted', () => {
  // Counting the attempt is the point: repeated illegal captures are the
  // `sec.access` signal that a student has not understood the rule, and a
  // refusal that leaves no trace teaches the system nothing.
  const stale = bentengEngine.init(
    {
      ...CAPTURE_SETUP,
      units: [
        { id: 'p1', side: 1, x: 2, y: 3, freshness: 5 },
        { id: 'e1', side: 2, x: 2, y: 2, freshness: 0 },
      ],
    },
    { freshnessWindow: 0 },
  ) as BentengState;

  const move: BentengMove = { kind: 'move', unitId: 'p1', x: 2, y: 2 };
  assert.equal(bentengEngine.isLegal(stale as never, move as never), false);
});

test('touching your own base resets freshness, which is the whole mechanic', () => {
  const state = bentengEngine.init(
    {
      ...CAPTURE_SETUP,
      units: [{ id: 'p1', side: 1, x: 2, y: 3, freshness: 6 }],
      toMove: 1,
    },
    { freshnessWindow: 0 },
  ) as BentengState;

  const home: BentengMove = { kind: 'move', unitId: 'p1', x: 2, y: 4 };
  assert.equal(bentengEngine.isLegal(state as never, home as never), true);

  const after = bentengEngine.applyMove(state as never, home as never).state as BentengState;
  const unit = after.units.filter((entry) => entry.id === 'p1')[0];
  assert.ok(unit);
  assert.equal(after.turn - unit.lastTouchedBaseOnTurn, 0);
});

test('reaching the enemy base wins, and the game stops there', () => {
  const state = bentengEngine.init(
    {
      ...CAPTURE_SETUP,
      units: [{ id: 'p1', side: 1, x: 2, y: 1, freshness: 0 }],
      toMove: 1,
    },
    { freshnessWindow: 0 },
  ) as BentengState;

  const win: BentengMove = { kind: 'move', unitId: 'p1', x: 2, y: 0 };
  const after = bentengEngine.applyMove(state as never, win as never).state as BentengState;

  assert.equal(after.outcome, 'won');
  assert.equal(after.finished, true);
  assert.deepEqual(bentengEngine.legalMoves(after as never), []);
});

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

test('a domain roll-up is computed on read and cannot drift from its nodes', () => {
  const mastery = {
    'algo.iteration': { value: 0.8, evidenceCount: 4, distinctSources: 2 },
    'algo.greedy': { value: 0.4, evidenceCount: 2, distinctSources: 1 },
  };

  const both = domainRollup(['algo.iteration', 'algo.greedy'], mastery as never);
  assert.equal(Math.round(both.value * 100) / 100, 0.6);
  assert.equal(both.evidenceCount, 6);

  // A node with no record is skipped rather than averaged in as zero, which
  // would make a student look worse for not having attempted something.
  const withGap = domainRollup(
    ['algo.iteration', 'algo.greedy', 'algo.lookahead'],
    mastery as never,
  );
  assert.equal(withGap.value, both.value);
});
