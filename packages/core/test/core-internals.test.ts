/**
 * The small pieces everything else stands on.
 *
 * Numeric helpers, the mastery caps, the replay recorder, the engine registry.
 * None of it is interesting on its own, which is exactly why it went untested —
 * and all of it is load-bearing. A PRNG that is not reproducible breaks replay
 * validation for every offline attempt; a cap that does not apply lets a
 * certificate be earned from one mission repeated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvidence,
  clamp,
  clamp01,
  congklakEngine,
  createRng,
  engineFor,
  currentVersion,
  mean,
  median,
  recomputeMastery,
  rngInt,
  roundTo,
  sum,
  ReplayRecorder,
  recordReplay,
} from '../dist/index.js';
import type { EvidenceInput } from '../dist/adaptive/mastery.js';
import type { Mission } from '../dist/types/mission.js';
import type { CongklakMove } from '../dist/index.js';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

test('clamping collapses NaN rather than letting it spread', () => {
  // A NaN mastery value written to the database poisons every later update and
  // renders as a blank band with no explanation.
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp(Number.NaN, 3, 9), 3);

  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp(1, 3, 9), 3);
  assert.equal(clamp(99, 3, 9), 9);
  assert.equal(clamp(5, 3, 9), 5);
});

test('roundTo is used only at boundaries and rounds half away from zero', () => {
  assert.equal(roundTo(0.12345, 2), 0.12);
  assert.equal(roundTo(0.125, 2), 0.13);
  assert.equal(roundTo(7, 0), 7);
});

test('sum, mean and median handle the empty case without dividing by zero', () => {
  assert.equal(sum([]), 0);
  assert.equal(mean([]), 0);
  assert.equal(median([]), 0);

  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(mean([1, 2, 3]), 2);
  // Odd count takes the middle; even count averages the two middles.
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('the PRNG is reproducible, which replay validation depends on entirely', () => {
  // If this ever stops holding, every offline attempt starts being rejected for
  // AI divergence through no fault of the student.
  const a = createRng(4242);
  const b = createRng(4242);
  const first = [a(), a(), a(), a()];
  const second = [b(), b(), b(), b()];
  assert.deepEqual(first, second);

  const different = createRng(4243);
  assert.notEqual(first[0], different());

  for (const value of first) {
    assert.ok(value >= 0 && value < 1, 'values must stay in [0, 1)');
  }
});

test('rngInt stays in range, including for a zero bound', () => {
  const rng = createRng(7);
  for (let i = 0; i < 50; i++) {
    const value = rngInt(rng, 5);
    assert.ok(value >= 0 && value < 5);
  }
  // A zero bound would be a division by zero or a NaN index; it returns 0.
  assert.equal(rngInt(createRng(1), 0), 0);
});

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

function evidence(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    skillWeights: { 'algo.iteration': 1 },
    outcome: 'success',
    hintShown: false,
    hintUsed: false,
    source: 'game',
    sourceKey: 'congklak.m06',
    priorSourceKeys: {},
    ...overrides,
  };
}

test('an abandoned attempt is not evidence of failure', () => {
  // A borrowed phone goes back to its owner mid-mission. Scoring that as a
  // failure would systematically understate exactly the students this exists
  // for.
  assert.deepEqual(applyEvidence({}, evidence({ outcome: 'abandoned' })), []);
});

test('a zero or negative weight contributes nothing', () => {
  assert.deepEqual(applyEvidence({}, evidence({ skillWeights: { 'algo.iteration': 0 } })), []);
});

test('one source repeated cannot reach the top band', () => {
  // The multi-source cap (PRD-LRN-005). Without it, a student who replays one
  // mission thirty times is indistinguishable from one who has demonstrated the
  // skill across different problems.
  const history: EvidenceInput[] = [];
  for (let i = 0; i < 30; i++) history.push(evidence());

  const single = recomputeMastery(history);
  const node = single['algo.iteration'];
  assert.ok(node);
  assert.ok(node.value < 0.85, `one source reached ${node?.value}, which should be capped`);
  assert.equal(node.distinctSources, 1);
  assert.equal(node.evidenceCount, 30);
});

test('evidence from different sources is not capped the same way', () => {
  const history: EvidenceInput[] = [];
  for (let i = 0; i < 30; i++) {
    history.push(evidence({ sourceKey: `congklak.m${i % 6}` }));
  }

  const varied = recomputeMastery(history);
  const node = varied['algo.iteration'];
  assert.ok(node);
  assert.equal(node.distinctSources, 6);
  assert.ok(
    node.value > 0.85,
    'six distinct sources over thirty successes should reach the top band',
  );
});

test('recomputation reproduces the same value it built incrementally', () => {
  // TRD-ADPT-001. This is what makes an engine bug recoverable by recomputation
  // rather than by guesswork.
  const history: EvidenceInput[] = [
    evidence({ sourceKey: 'a' }),
    evidence({ sourceKey: 'b', outcome: 'failure' }),
    evidence({ sourceKey: 'c', hintShown: true }),
    evidence({ sourceKey: 'a' }),
  ];

  const first = recomputeMastery(history);
  const second = recomputeMastery(history);
  assert.equal(first['algo.iteration']?.value, second['algo.iteration']?.value);
});

test('a hinted success is worth less than an unhinted one', () => {
  const plain = recomputeMastery([evidence()]);
  const hinted = recomputeMastery([evidence({ hintShown: true, hintUsed: true })]);

  assert.ok(
    (hinted['algo.iteration']?.value ?? 0) < (plain['algo.iteration']?.value ?? 0),
    'a hint has to cost something, or hinting is free mastery',
  );
  assert.ok(
    (hinted['algo.iteration']?.value ?? 0) > 0,
    'a hint must not cost everything, or help-seeking is punished',
  );
});

// ---------------------------------------------------------------------------
// Recorder and registry
// ---------------------------------------------------------------------------

const MISSION: Mission = {
  id: 'congklak.m02',
  game: 'congklak',
  rank: 2,
  contentVersion: 1,
  skillWeights: { 'comp.arithmetic': 1 },
  eloDifficulty: 850,
  goal: { kind: 'collect', count: 2 },
  setup: {
    game: 'congklak',
    pits: [0, 1, 1, 1, 1, 1, 0, 6, 0, 0, 0, 6],
    playerSide: 1,
    toMove: 1,
  },
  constraints: { maxMoves: 20, aiTier: 'sedang' },
  config: { extraTurnOnStore: true, captureEnabled: false, continuationEnabled: false, sweepOnEnd: true },
  seed: 4242,
  rationale: 'Counting seeds in a pit and predicting the landing pit to reach the lumbung.',
  titleKey: 'x.title',
  briefKey: 'x.brief',
  hintKeys: [],
  failureKeys: { ranOut: 'x.fail' },
};

test('the recorder refuses an illegal move rather than recording it', () => {
  // An illegal move in a replay becomes a server rejection the student sees.
  // Throwing here turns it into a bug the developer sees instead.
  const recorder = new ReplayRecorder(congklakEngine as never, MISSION);
  assert.throws(
    () => recorder.play({ kind: 'sow', pit: 9 } as CongklakMove as never, 'player', 0),
    /illegal move/,
  );
  assert.equal(recorder.moveCount, 0);
});

test('an unfinished mission is abandoned, not failed', () => {
  const recorder = new ReplayRecorder(congklakEngine as never, MISSION);
  assert.equal(recorder.outcome(), 'abandoned');
  assert.equal(recorder.isTerminal(), false);
});

test('a replay records what was played and hashes the state it ended in', () => {
  const recorder = new ReplayRecorder(congklakEngine as never, MISSION);
  const legal = congklakEngine.legalMoves(recorder.state as never) as CongklakMove[];
  recorder.play(legal[0] as never, 'player', 1200);

  const replay = recorder.finish();
  assert.equal(replay.moves.length, 1);
  assert.equal(replay.missionId, MISSION.id);
  assert.equal(replay.seed, MISSION.seed);
  assert.ok(replay.finalStateHash.length > 0);

  // The claimed outcome can be overridden, which is what lets a client report
  // "abandoned" for a session the student walked away from.
  assert.equal(recorder.finish('abandoned').claimedOutcome, 'abandoned');
});

test('recordReplay drives a scripted list through the same path', () => {
  const first = congklakEngine.legalMoves(
    congklakEngine.init(MISSION.setup, MISSION.config) as never,
  ) as CongklakMove[];

  const replay = recordReplay(congklakEngine as never, MISSION, [
    { move: first[0] as never, actor: 'player', elapsedMs: 900 },
  ]);
  assert.equal(replay.moves.length, 1);
  assert.equal(replay.moves[0]?.actor, 'player');
});

test('the registry resolves a known engine and refuses an unknown one', () => {
  assert.ok(engineFor('congklak'));
  assert.ok(engineFor('benteng'));
  assert.equal(engineFor('engklek' as never), null);

  // A version that does not exist must not silently fall back to the current
  // one: a client six days behind would then be judged by rules it never had.
  assert.equal(engineFor('congklak', '0.0.1-nonexistent'), null);
  assert.ok(engineFor('congklak', currentVersion('congklak') ?? undefined));
});
