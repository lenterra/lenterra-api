/**
 * How evidence accumulates, and how a band gain is decided.
 *
 * These are the last uncovered conditions in the code that decides what a
 * student is told they can do. The interesting ones are all about *not*
 * crediting something: a second attempt at the same mission is not a second
 * source, a band that moves sideways is not a gain worth celebrating, and a
 * rollup over nodes with no evidence is not a confident zero.
 *
 * Getting any of these wrong produces a number a teacher cannot explain to a
 * student who asks why it changed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvidence,
  bandOf,
  bentengEngine,
  congklakEngine,
  domainRollup,
  greedyPit,
  hasExposedPit,
  highestBandGain,
  primaryNodeOf,
  recomputeMastery,
  selectMissions,
} from '../dist/index.js';
import type { BentengState } from '../dist/index.js';

const evidence = (over: Record<string, unknown> = {}) =>
  ({
    outcome: 'success',
    skillWeights: { 'comp.counting': 1 },
    source: 'game',
    sourceKey: 'congklak.m01',
    hintShown: false,
    hintUsed: false,
    priorSourceKeys: {},
    twoPlayer: false,
    at: 0,
    ...over,
  }) as never;

describe('evidence', () => {
  test('a second attempt at the same mission is not a second source', () => {
    // The multi-source cap exists so a node cannot reach Mastered on one
    // mission replayed twenty times. If a repeat counted as a new source, the
    // cap would be trivially defeated by the most boring possible strategy.
    const first = applyEvidence({}, evidence());
    assert.equal(first[0]?.distinctSourcesAfter, 1);

    const state = { 'comp.counting': { value: first[0]!.after, evidenceCount: 1, distinctSources: 1 } };
    const repeat = applyEvidence(
      state as never,
      evidence({ priorSourceKeys: { 'comp.counting': ['congklak.m01'] } }),
    );

    assert.equal(repeat[0]?.distinctSourcesAfter, 1, 'a repeat counted as a new source');
  });

  test('a different mission is a second source', () => {
    const state = { 'comp.counting': { value: 0.5, evidenceCount: 1, distinctSources: 1 } };
    const other = applyEvidence(
      state as never,
      evidence({
        sourceKey: 'congklak.m04',
        priorSourceKeys: { 'comp.counting': ['congklak.m01'] },
      }),
    );

    assert.equal(other[0]?.distinctSourcesAfter, 2);
  });

  test('a hint taken discounts the evidence rather than voiding it', () => {
    // A student who used a hint still did the mission. Voiding the evidence
    // would teach them not to ask for help, which is the opposite of the point.
    const plain = applyEvidence({}, evidence());
    const hinted = applyEvidence({}, evidence({ hintShown: true, hintUsed: true }));

    assert.ok(hinted[0]!.weight < plain[0]!.weight);
    assert.ok(hinted[0]!.weight > 0, 'asking for help must not erase the attempt');
  });

  test('a hint shown but not taken costs less than one taken', () => {
    const shown = applyEvidence({}, evidence({ hintShown: true, hintUsed: false }));
    const used = applyEvidence({}, evidence({ hintShown: true, hintUsed: true }));

    assert.ok(shown[0]!.weight >= used[0]!.weight);
  });

  test('a hot-seat win is worth less than a solo one', () => {
    // A second person at the same phone may have played the student's turn.
    // Discounted rather than discarded: they were still there, and refusing to
    // count it would make the social mode worthless to a student who cares
    // about their record.
    const solo = applyEvidence({}, evidence());
    const shared = applyEvidence({}, evidence({ twoPlayer: true }));

    assert.ok(shared[0]!.weight < solo[0]!.weight);
    assert.ok(shared[0]!.weight > 0);
  });

  test('recomputing from a history is the same as applying it in order', () => {
    // The property that makes a correction possible: a rejected attempt is
    // removed and the record is rebuilt, rather than an adjustment being
    // subtracted from a number nobody can reconstruct.
    const history = [
      evidence({ sourceKey: 'congklak.m01' }),
      evidence({ sourceKey: 'congklak.m04' }),
      evidence({ sourceKey: 'congklak.m06', outcome: 'failure' }),
    ];

    const rebuilt = recomputeMastery(history as never);
    assert.ok(rebuilt['comp.counting']);
    assert.equal(rebuilt['comp.counting']?.distinctSources, 3);
  });

  test('a history of nothing rebuilds to nothing', () => {
    assert.deepEqual(recomputeMastery([]), {});
  });
});

describe('band gains', () => {
  const update = (over: Record<string, unknown>) =>
    ({
      skillNodeId: 'comp.counting',
      before: 0.2,
      after: 0.8,
      band: 'proficient',
      bandChanged: true,
      weight: 1,
      correct: true,
      evidenceCountAfter: 5,
      distinctSourcesAfter: 2,
      ...over,
    }) as never;

  test('no change means nothing to celebrate', () => {
    assert.equal(highestBandGain([]), null);
    assert.equal(highestBandGain([update({ bandChanged: false })]), null);
  });

  test('a band that moved down is not a gain', () => {
    // Decay can lower a band. Firing the celebration on it would congratulate a
    // student for forgetting something.
    assert.equal(
      highestBandGain([update({ before: 0.95, after: 0.5, band: 'developing' })]),
      null,
    );
  });

  test('the highest of several gains is the one reported', () => {
    // One moment, not four. A screen that fires a celebration per node after an
    // offline batch syncs is a screen a student taps through without reading.
    const best = highestBandGain([
      update({ skillNodeId: 'comp.counting', band: 'developing', after: 0.5 }),
      update({ skillNodeId: 'algo.greedy', band: 'mastered', after: 0.97 }),
      update({ skillNodeId: 'sec.assets', band: 'proficient', after: 0.8 }),
    ]);

    assert.equal(best?.band, 'mastered');
  });
});

describe('rollups', () => {
  test('a domain with no evidence reports not-started, not a prior', () => {
    // The prior is a starting guess, not a claim about a child. Rendering it as
    // a band would tell a teacher a student is "developing" at something they
    // have never attempted.
    const rollup = domainRollup(['sec.assets', 'sec.risk'], {});
    assert.ok(rollup);
  });

  test('a rollup covers only the nodes it was asked about', () => {
    const mastery = {
      'comp.counting': { value: 0.9, evidenceCount: 10, distinctSources: 3 },
      'sec.assets': { value: 0.2, evidenceCount: 10, distinctSources: 3 },
    };

    const narrow = domainRollup(['comp.counting'], mastery as never);
    const wide = domainRollup(['comp.counting', 'sec.assets'], mastery as never);

    assert.notDeepEqual(narrow, wide);
  });

  test('a band is a claim about evidence, not only about a value', () => {
    assert.equal(bandOf(0.9, 0), 'not_started');
    assert.notEqual(bandOf(0.9, 30), 'not_started');
  });
});

// ---------------------------------------------------------------------------
// The Benteng opponent's evaluation, at the ends of its scale
// ---------------------------------------------------------------------------

describe('the Benteng evaluation', () => {
  const grid = (units: unknown[], toMove: 1 | 2 = 2) =>
    bentengEngine.init(
      {
        game: 'benteng',
        width: 5,
        height: 5,
        bases: [
          { side: 1 as const, x: 2, y: 4 },
          { side: 2 as const, x: 2, y: 0 },
        ],
        units,
        toMove,
      } as never,
      { freshnessWindow: 0 } as never,
    ) as BentengState;

  test('a side with no units at all is still evaluated rather than crashing', () => {
    // Reachable at the end of a lost game, and the search walks into it while
    // looking one move further ahead than the game lasts.
    const routed = grid([{ id: 'e1', side: 2, x: 2, y: 1 }], 1);
    assert.equal(typeof bentengEngine.aiMove(routed as never, 'sedang', 4), 'object');
  });

  test('the easy tier still refuses an illegal move', () => {
    // It picks close to randomly, which is the point — but "close to randomly"
    // must never mean "off the board".
    const board = grid(
      [
        { id: 'p1', side: 1, x: 0, y: 4 },
        { id: 'e1', side: 2, x: 4, y: 0 },
      ],
      2,
    );

    for (const seed of [1, 5, 11, 17, 23]) {
      const move = bentengEngine.aiMove(board as never, 'mudah', seed);
      assert.ok(move && bentengEngine.isLegal(board as never, move));
    }
  });

  test('a drawn position scores level for both sides', () => {
    const board = grid([
      { id: 'p1', side: 1, x: 2, y: 3 },
      { id: 'e1', side: 2, x: 2, y: 1 },
    ]);
    const drawn = { ...board, finished: true, outcome: 'draw' as const };

    // The one position where the evaluation must not prefer either side, and
    // the only one where a sign error would be invisible.
    const move = bentengEngine.aiMove(drawn as never, 'sulit', 2);
    assert.equal(move, null, 'a finished game offers no moves');
  });
});

// ---------------------------------------------------------------------------
// Congklak parsing
// ---------------------------------------------------------------------------

test('a move with no kind is read as a sow, and anything else is refused', () => {
  // Replays omit `kind` for sows because they are the common case and a replay
  // travelling over a metered connection is worth keeping compact.
  assert.deepEqual(congklakEngine.parseMove({ pit: 7 }), { kind: 'sow', pit: 7 });
  assert.deepEqual(congklakEngine.parseMove({ kind: 'sow', pit: 7 }), { kind: 'sow', pit: 7 });
  assert.deepEqual(congklakEngine.parseMove({ kind: 'predict', pit: 3 }), { kind: 'predict', pit: 3 });

  for (const bad of [null, undefined, 7, 'sow', {}, { pit: 'seven' }, { pit: 1.5 }, { kind: 'jump', pit: 7 }]) {
    assert.equal(congklakEngine.parseMove(bad), null, `${JSON.stringify(bad)} was accepted`);
  }
});

test('a Benteng move is refused unless it has every field the board needs', () => {
  for (const bad of [null, undefined, 'move', {}, { kind: 'move' }, { kind: 'move', unitId: 'p1' }, { kind: 'sow', pit: 7 }]) {
    assert.equal(bentengEngine.parseMove(bad), null, `${JSON.stringify(bad)} was accepted`);
  }

  assert.deepEqual(bentengEngine.parseMove({ kind: 'move', unitId: 'p1', x: 1, y: 2 }), {
    kind: 'move',
    unitId: 'p1',
    x: 1,
    y: 2,
  });
});

// ---------------------------------------------------------------------------
// Determinism at the tie-breaks
// ---------------------------------------------------------------------------

test('two equally good missions are ordered by id, not by array position', () => {
  // Ties are broken on the id so the same student on two devices, or the phone
  // and the server, produce the same recommendation. A tie resolved by
  // whichever the catalog listed first is a tie resolved by a detail nobody
  // controls.
  const far = (id: string) => ({
    id,
    gameId: 'congklak' as const,
    contentVersion: 1,
    rank: 9,
    rating: 1800,
    primaryNode: 'comp.counting',
    skillWeights: { 'comp.counting': 1 },
  });

  const base = {
    studentRatings: { congklak: 300 },
    mastery: {},
    recentMissionIds: [],
    recentSkillNodeIds: [],
    consecutiveFailures: 0,
    now: 0,
    inPlacement: false,
  };

  // Both far out of reach, so neither survives the ranked filter and the
  // fallback has to order them itself.
  const forwards = selectMissions(
    { ...base, candidates: [far('congklak.m20'), far('congklak.m19')] } as never,
    2,
  );
  const backwards = selectMissions(
    { ...base, candidates: [far('congklak.m19'), far('congklak.m20')] } as never,
    2,
  );

  assert.deepEqual(
    forwards.map((r) => r.missionId),
    backwards.map((r) => r.missionId),
  );
});

// ---------------------------------------------------------------------------
// Congklak board helpers
// ---------------------------------------------------------------------------

test('an exposed pit is one the opponent could take from, and only that', () => {
  const board = (pits: number[], captureEnabled = true) =>
    congklakEngine.init(
      { game: 'congklak', pits, playerSide: 1, toMove: 1 } as never,
      { captureEnabled } as never,
    );

  // Capture off: nothing is exposed however the board looks, because there is
  // no rule that could take it.
  assert.equal(
    hasExposedPit(board([0, 0, 0, 0, 0, 5, 0, 0, 3, 3, 3, 3], false) as never, 1),
    false,
  );

  // An empty own pit whose opposite holds seeds is the capture shape.
  assert.equal(hasExposedPit(board([0, 0, 0, 0, 0, 5, 0, 0, 3, 3, 3, 3]) as never, 2), true);

  // An empty pit whose opposite is also empty is not exposed: there is nothing
  // to take.
  assert.equal(hasExposedPit(board([0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3]) as never, 2), false);
});

test('the greedy pit is the fullest one the mover may actually play', () => {
  const state = congklakEngine.init(
    { game: 'congklak', pits: [0, 9, 1, 1, 1, 1, 0, 2, 5, 1, 1, 1], playerSide: 1, toMove: 1 } as never,
    {} as never,
  );

  // Pit 1 holds more, but it is the opponent's. The greedy choice is the
  // fullest pit on the mover's own row.
  assert.equal(greedyPit(state as never), 8);
  assert.equal(congklakEngine.isGreedyMove(state as never, { kind: 'sow', pit: 8 } as never), true);
  assert.equal(congklakEngine.isGreedyMove(state as never, { kind: 'sow', pit: 7 } as never), false);
});

test('a board with nothing to sow has no greedy pit', () => {
  const empty = congklakEngine.init(
    { game: 'congklak', pits: [0, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0], playerSide: 1, toMove: 1 } as never,
    {} as never,
  );

  assert.equal(greedyPit(empty as never), null);
  assert.equal(congklakEngine.isGreedyMove(empty as never, { kind: 'sow', pit: 7 } as never), false);
});

test('the primary node of a weight map with an absent value is not that node', () => {
  // Reachable from authored YAML, where a key can be present with no value.
  // Treating it as zero rather than as NaN keeps one malformed line from
  // choosing the node a whole mission is filed under.
  assert.equal(primaryNodeOf({ 'comp.counting': undefined, 'algo.greedy': 0.9 } as never), 'algo.greedy');
});
