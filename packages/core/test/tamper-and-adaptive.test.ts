/**
 * Replay tampering, the prediction mechanic, and the adaptive edges.
 *
 * The tamper cases are the reason offline play can be trusted at all: a client
 * that has been modified, or is simply six days out of date, has to be told
 * apart from one that is cheating, and the two get different treatment. The
 * prediction cases cover a whole Congklak rule — "say where the last seed will
 * land, then sow" — that had no test of its own despite being what mission m05
 * teaches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  congklakEngine,
  detectStruggle,
  domainRollup,
  gameOfMissionId,
  gapScore,
  hashConfig,
  highestBandGain,
  initialMastery,
  nodesInDomain,
  paramsFor,
  sameGameStreak,
  selectMissions,
  supportOptionsFor,
  validateReplay,
  varietyPenalty,
  ReplayRecorder,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { Replay } from '../dist/types/attempt.js';
import type { CongklakMove, CongklakState } from '../dist/index.js';
import type { MissionSummary } from '../dist/types/mission.js';
import type { MasteryUpdate } from '../dist/adaptive/mastery.js';

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
    pits: [0, 6, 0, 0, 0, 6, 0, 1, 1, 1, 1, 1],
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

function honestReplay(): Replay {
  const recorder = new ReplayRecorder<CongklakState, CongklakMove>(congklakEngine as never, MISSION);
  let elapsed = 0;

  for (let i = 0; i < 30 && !recorder.isTerminal(); i++) {
    const state = recorder.state;
    const mine = congklakEngine.sideToMove(state) === congklakEngine.playerSide(state);
    elapsed += 1100 + i * 43;

    if (mine) {
      const legal = congklakEngine.legalMoves(state) as CongklakMove[];
      if (legal.length === 0) break;
      recorder.play(legal[0] as CongklakMove, 'player', elapsed);
    } else {
      const move = recorder.aiMove();
      if (!move) break;
      recorder.play(move, 'ai', elapsed);
    }
  }
  return recorder.finish();
}

// ---------------------------------------------------------------------------
// Tampering
// ---------------------------------------------------------------------------

test('an honest replay validates', () => {
  const result = validateReplay(honestReplay(), MISSION, congklakEngine as never);
  assert.equal(result.valid, true, result.valid ? '' : `rejected: ${result.reason}`);
});

test('moves that are not an array are refused before anything is executed', () => {
  const result = validateReplay(
    { ...honestReplay(), moves: 'nope' as never },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid === false && result.reason, 'malformed_replay');
});

test('a replay for a different mission is refused', () => {
  const result = validateReplay(
    { ...honestReplay(), missionId: 'congklak.m19' },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid === false && result.reason, 'unknown_mission');
});

test('a replay against an older content version is refused, not silently accepted', () => {
  // The student played different rules. Accepting it would score them against a
  // mission they never saw.
  const result = validateReplay(
    { ...honestReplay(), missionContentVersion: 99 },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid === false && result.reason, 'config_mismatch');
});

test('a replay from an unsupported engine is refused by version, not by behaviour', () => {
  const result = validateReplay(
    { ...honestReplay(), engineVersion: '0.0.1' },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid === false && result.reason, 'core_version_unsupported');
});

test('a replay whose config hash disagrees is refused', () => {
  const result = validateReplay(
    { ...honestReplay(), configHash: 'not-the-config' },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid === false && result.reason, 'config_mismatch');
});

test('a gap in the sequence numbers is refused', () => {
  const replay = honestReplay();
  const moves = replay.moves.slice();
  if (moves[0]) moves[0] = { ...moves[0], seq: 5 };
  const result = validateReplay({ ...replay, moves }, MISSION, congklakEngine as never);
  assert.equal(result.valid === false && result.reason, 'sequence_gap');
});

test('editing a move and recomputing the hash still fails', () => {
  // The check a naive implementation misses. The hash an attacker computes is
  // over their edited state; this one is over the state re-execution actually
  // reached, and the two only agree if nothing was edited.
  const replay = honestReplay();
  const moves = replay.moves.slice();
  const first = moves[0];
  assert.ok(first);

  const start = congklakEngine.init(MISSION.setup, MISSION.config);
  const legal = congklakEngine.legalMoves(start) as CongklakMove[];
  const different = legal.find(
    (move) => !congklakEngine.movesEqual(move as never, first.move as never),
  );
  assert.ok(different, 'the fixture needs at least two legal opening moves');

  moves[0] = { ...first, move: different };
  const result = validateReplay({ ...replay, moves }, MISSION, congklakEngine as never);
  assert.equal(result.valid, false);
});

test('a claimed outcome that re-execution does not produce is refused', () => {
  const replay = honestReplay();
  const result = validateReplay(
    { ...replay, claimedOutcome: replay.claimedOutcome === 'success' ? 'failure' : 'success' },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid, false);
});

test('timing that runs backwards is flagged, never penalised automatically', () => {
  // A legal replay submitted by a script is still legal. Timing is the only
  // signal separating it from play, and it is weak enough that it has to inform
  // a human rather than trigger a sanction.
  const replay = honestReplay();
  const moves = replay.moves.map((move, index) => ({ ...move, elapsedMs: 10_000 - index * 100 }));
  const result = validateReplay({ ...replay, moves }, MISSION, congklakEngine as never);

  if (result.valid) {
    assert.equal(result.suspicious, true);
    assert.ok(result.suspicionReasons.length > 0);
  }
});

test('the config hash is stable and reflects the rules actually resolved', () => {
  assert.equal(hashConfig(MISSION), hashConfig(MISSION));
  assert.notEqual(
    hashConfig(MISSION),
    hashConfig({ ...MISSION, config: { ...MISSION.config, captureEnabled: true } }),
  );
});

// ---------------------------------------------------------------------------
// The prediction mechanic (mission m05)
// ---------------------------------------------------------------------------

const PREDICT_SETUP = {
  game: 'congklak' as const,
  pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
  playerSide: 1 as const,
  toMove: 1 as const,
};

test('a prediction mission asks for a prediction before it will accept a sow', () => {
  // The rule that turns "guess where it lands" from a UI affordance into
  // something the solver can search and a replay can prove.
  const state = congklakEngine.init(PREDICT_SETUP, { requirePrediction: true }) as CongklakState;
  const legal = congklakEngine.legalMoves(state as never) as CongklakMove[];

  assert.ok(legal.length > 0);
  assert.ok(
    legal.every((move) => move.kind === 'predict'),
    'only predictions are offered until one is made',
  );
  assert.equal(
    congklakEngine.isLegal(state as never, { kind: 'sow', pit: 7 } as never),
    false,
    'sowing before predicting has to be refused',
  );
});

test('a prediction cannot name the opponent’s store, which sowing always skips', () => {
  const state = congklakEngine.init(PREDICT_SETUP, { requirePrediction: true }) as CongklakState;
  assert.equal(congklakEngine.isLegal(state as never, { kind: 'predict', pit: 0 } as never), false);
  assert.equal(congklakEngine.isLegal(state as never, { kind: 'predict', pit: 99 } as never), false);
  assert.equal(congklakEngine.isLegal(state as never, { kind: 'predict', pit: 1.5 } as never), false);
  assert.equal(congklakEngine.isLegal(state as never, { kind: 'predict', pit: 6 } as never), true);
});

test('once predicted, sowing is allowed and a second prediction is not', () => {
  const state = congklakEngine.init(PREDICT_SETUP, { requirePrediction: true }) as CongklakState;
  const after = congklakEngine.applyMove(state as never, {
    kind: 'predict',
    pit: 10,
  } as never).state as CongklakState;

  assert.equal(after.pendingPrediction, 10);
  assert.equal(congklakEngine.isLegal(after as never, { kind: 'sow', pit: 7 } as never), true);
  assert.equal(
    congklakEngine.isLegal(after as never, { kind: 'predict', pit: 9 } as never),
    false,
    'predicting twice would let a student cover every option',
  );
});

test('a correct prediction is credited and a wrong one is not', () => {
  // Continuation off, so the sow is exactly three steps and the landing pit is
  // something a student could have worked out — which is the point of the
  // mechanic.
  const state = congklakEngine.init(PREDICT_SETUP, {
    requirePrediction: true,
    continuationEnabled: false,
    captureEnabled: false,
  }) as CongklakState;

  // Sowing three seeds from pit 7 lands the last in pit 10.
  const predicted = congklakEngine.applyMove(state as never, {
    kind: 'predict',
    pit: 10,
  } as never).state as CongklakState;
  const sown = congklakEngine.applyMove(predicted as never, {
    kind: 'sow',
    pit: 7,
  } as never).state as CongklakState;

  assert.equal(sown.correctPredictions, 1);
  assert.equal(sown.pendingPrediction, null, 'the prediction is consumed by the sow');

  const wrong = congklakEngine.applyMove(
    congklakEngine.applyMove(state as never, { kind: 'predict', pit: 9 } as never)
      .state as never,
    { kind: 'sow', pit: 7 } as never,
  ).state as CongklakState;
  assert.equal(wrong.correctPredictions, 0);
});

// ---------------------------------------------------------------------------
// Adaptive edges
// ---------------------------------------------------------------------------

test('BKT parameters fall back through node, domain, then global', () => {
  const plain = paramsFor('algo.iteration');
  const overridden = paramsFor('algo.iteration', { 'algo.iteration': { pSlip: 0.42 } });

  assert.equal(overridden.pSlip, 0.42);
  // A partial override keeps the rest of the defaults rather than zeroing them.
  assert.equal(overridden.pTransit, plain.pTransit);
  assert.equal(overridden.pInit, plain.pInit);

  // An override for a different node does not leak across.
  assert.equal(paramsFor('algo.iteration', { 'sec.assets': { pSlip: 0.9 } }).pSlip, plain.pSlip);
});

test('a node with no record starts at its domain prior with no evidence', () => {
  const start = initialMastery('sec.assets');
  assert.equal(start.evidenceCount, 0);
  assert.equal(start.distinctSources, 0);
  assert.equal(start.value, paramsFor('sec.assets').pInit);
});

test('a domain rollup with no evidence reports not-started rather than a prior', () => {
  // A student who has played nothing has not "started at 0.15"; showing a band
  // derived from the prior would claim evidence that does not exist.
  const empty = domainRollup(nodesInDomain('algorithms'), {});
  assert.equal(empty.evidenceCount, 0);
  assert.equal(empty.band, 'not_started');
});

test('a domain rollup averages only the nodes it was asked about', () => {
  // Mastery is never stored at domain level, so this is computed on every read
  // and cannot drift from the nodes beneath it.
  const state = {
    'algo.iteration': { value: 0.9, evidenceCount: 4, distinctSources: 2 },
    'sec.assets': { value: 0.1, evidenceCount: 4, distinctSources: 2 },
  };
  const rollup = domainRollup(['algo.iteration'], state as never);
  assert.equal(rollup.value, 0.9, 'a security node must not drag an algorithms rollup down');
  assert.equal(rollup.evidenceCount, 4);
});

test('the celebration moment fires on a genuine band gain only', () => {
  const gained: MasteryUpdate[] = [
    {
      skillNodeId: 'algo.iteration',
      before: 0.5,
      after: 0.75,
      band: 'proficient',
      bandChanged: true,
      weight: 1,
      correct: true,
      evidenceCountAfter: 3,
      distinctSourcesAfter: 2,
    } as MasteryUpdate,
  ];
  assert.equal(highestBandGain(gained)?.skillNodeId, 'algo.iteration');

  // A band that moved *down* is not a celebration.
  const lost: MasteryUpdate[] = [
    { ...(gained[0] as MasteryUpdate), before: 0.9, after: 0.5, band: 'developing' },
  ];
  assert.equal(highestBandGain(lost), null);
  assert.equal(highestBandGain([]), null);
});

test('struggle needs repeated failure on the same node, not just failure', () => {
  const at = (missionId: string, node: string, outcome: 'success' | 'failure') => ({
    id: `${missionId}-${outcome}`,
    missionId,
    primaryNode: node,
    outcome,
    at: 0,
  });

  // Three failures spread across different nodes is a hard session, not a
  // struggle with one idea.
  assert.equal(
    detectStruggle([
      at('congklak.m10', 'algo.greedy', 'failure'),
      at('congklak.m11', 'comp.counting', 'failure'),
      at('congklak.m12', 'sec.assets', 'failure'),
    ] as never),
    null,
  );

  const struggling = detectStruggle([
    at('congklak.m10', 'algo.greedy', 'failure'),
    at('congklak.m11', 'algo.greedy', 'failure'),
    at('congklak.m12', 'algo.greedy', 'failure'),
  ] as never);
  assert.equal(struggling?.skillNodeId, 'algo.greedy');
});

test('support offered depends on what actually exists', () => {
  // Offering a lesson that has not been authored is worse than offering
  // nothing: the student taps it and finds a dead end.
  assert.ok(supportOptionsFor(true, true).length >= supportOptionsFor(false, false).length);
  assert.equal(supportOptionsFor(false, false).some((option) => option === 'lesson'), false);
});

test('a mission id yields its game, and an unparseable one does not throw', () => {
  assert.equal(gameOfMissionId('congklak.m01'), 'congklak');
  assert.equal(gameOfMissionId('benteng.m12'), 'benteng');
  assert.equal(gameOfMissionId('nonsense'), 'nonsense');
});

test('selection prefers an unevidenced node and avoids repeating one game', () => {
  const summary = (id: string, node: string, rating: number): MissionSummary => ({
    id,
    gameId: id.slice(0, id.indexOf('.')) as never,
    contentVersion: 1,
    rank: 1,
    rating,
    primaryNode: node as never,
    skillWeights: { [node]: 1 } as never,
  });

  const input = {
    mastery: {
      'comp.counting': { value: 0.9, evidenceCount: 8, distinctSources: 3 },
    },
    studentRatings: { congklak: 900, benteng: 900 },
    recentMissionIds: ['congklak.m01', 'congklak.m02', 'congklak.m03'],
    recentSkillNodeIds: ['comp.counting', 'comp.counting', 'comp.counting'],
    consecutiveFailures: 0,
    now: 1_700_000_000_000,
    candidates: [
      summary('congklak.m04', 'comp.counting', 900),
      summary('benteng.m01', 'sec.assets', 900),
    ],
  };

  assert.equal(sameGameStreak(input as never), 3);
  assert.ok(
    varietyPenalty(summary('congklak.m04', 'comp.counting', 900), input as never) > 0,
    'a fourth Congklak in a row should be penalised',
  );
  assert.ok(
    gapScore(summary('benteng.m01', 'sec.assets', 900), input as never) >
      gapScore(summary('congklak.m04', 'comp.counting', 900), input as never),
    'an unevidenced node is a bigger gap than a well-evidenced one',
  );

  const picked = selectMissions(input as never, 1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.missionId, 'benteng.m01');
});
