/**
 * The last reachable branches.
 *
 * Bounds, tiers, placement mode, and the paths that only run when content is
 * malformed. Nothing here is a headline behaviour; all of it is what happens
 * when something upstream is already wrong, which is exactly when a student is
 * least able to tell a bug from their own mistake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TIERS,
  GAME_IDS,
  MAX_REPLAY_MOVES,
  bandOf,
  bandRank,
  bentengEngine,
  certificateById,
  checkCertificate,
  classGoal,
  congklakEngine,
  domainOf,
  isGameId,
  isSkillNodeId,
  nodesInDomain,
  primaryNodeOf,
  selectMissions,
  validateReplay,
  ReplayRecorder,
  CERTIFICATES,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { CongklakMove, CongklakState } from '../dist/index.js';
import type { MissionSummary } from '../dist/types/mission.js';

const MISSION: Mission = {
  id: 'congklak.m02',
  game: 'congklak',
  rank: 2,
  contentVersion: 1,
  skillWeights: { 'comp.arithmetic': 1 },
  eloDifficulty: 850,
  goal: { kind: 'collect', count: 99 },
  setup: {
    game: 'congklak',
    pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
    playerSide: 1,
    toMove: 1,
  },
  constraints: { maxMoves: 40, aiTier: 'sedang' },
  config: { extraTurnOnStore: true, captureEnabled: false, continuationEnabled: false, sweepOnEnd: true },
  seed: 4242,
  rationale: 'Counting seeds in a pit and predicting the landing pit to reach the lumbung.',
  titleKey: 'x.title',
  briefKey: 'x.brief',
  hintKeys: [],
  failureKeys: { ranOut: 'x.fail' },
};

// ---------------------------------------------------------------------------
// Taxonomy and identifiers
// ---------------------------------------------------------------------------

test('identifier guards accept what exists and reject what does not', () => {
  for (const game of GAME_IDS) assert.equal(isGameId(game), true);
  assert.equal(isGameId('engklek'), false);
  assert.equal(isGameId(''), false);

  assert.equal(isSkillNodeId('algo.iteration'), true);
  assert.equal(isSkillNodeId('algo.nonsense'), false);
});

test('every node maps to a domain, and every domain back to its nodes', () => {
  const all = [
    ...nodesInDomain('computation'),
    ...nodesInDomain('algorithms'),
    ...nodesInDomain('security'),
  ];
  assert.equal(all.length, 17);
  assert.equal(domainOf('comp.counting'), 'computation');
  assert.equal(domainOf('algo.greedy'), 'algorithms');
  assert.equal(domainOf('sec.risk'), 'security');
});

test('bands are ordered and evidence-gated', () => {
  // Zero evidence is not-started whatever the value: a student carrying only
  // the prior has not started, and rendering that as "Baru mulai" would claim
  // evidence that does not exist.
  assert.equal(bandOf(0.99, 0), 'not_started');
  assert.equal(bandOf(0.9, 1), 'mastered');
  assert.equal(bandOf(0.75, 1), 'proficient');
  assert.equal(bandOf(0.5, 1), 'developing');
  assert.equal(bandOf(0.1, 1), 'emerging');

  assert.ok(bandRank('mastered') > bandRank('proficient'));
  assert.ok(bandRank('not_started') < bandRank('emerging'));
});

test('a primary node comes from the weights, or nothing does', () => {
  assert.equal(primaryNodeOf({ 'algo.greedy': 0.7, 'algo.lookahead': 0.3 }), 'algo.greedy');
  assert.equal(primaryNodeOf({}), null);
});

// ---------------------------------------------------------------------------
// Replay bounds
// ---------------------------------------------------------------------------

test('an absurdly long replay is refused on length before anything is executed', () => {
  // Re-executing an unbounded move list is a denial-of-service on the
  // validator, and no honest 2–5 minute mission approaches this.
  const moves = Array.from({ length: MAX_REPLAY_MOVES + 1 }, (_, seq) => ({
    seq,
    actor: 'player' as const,
    move: { kind: 'sow', pit: 7 },
    elapsedMs: seq * 100,
  }));

  const result = validateReplay(
    {
      gameId: 'congklak',
      missionId: MISSION.id,
      missionContentVersion: 1,
      engineVersion: congklakEngine.version,
      configHash: 'whatever',
      seed: MISSION.seed,
      moves,
      finalStateHash: 'whatever',
      claimedOutcome: 'success',
    },
    MISSION,
    congklakEngine as never,
  );
  assert.equal(result.valid === false && result.reason, 'too_many_moves');
});

test('a replay that continues past a finished game is refused', () => {
  const winnable: Mission = { ...MISSION, goal: { kind: 'collect', count: 1 } };
  const recorder = new ReplayRecorder<CongklakState, CongklakMove>(
    congklakEngine as never,
    winnable,
  );

  let elapsed = 0;
  for (let i = 0; i < 12 && !recorder.isTerminal(); i++) {
    const state = recorder.state;
    const mine = congklakEngine.sideToMove(state) === congklakEngine.playerSide(state);
    elapsed += 900;
    if (mine) {
      const legal = congklakEngine.legalMoves(state) as CongklakMove[];
      if (legal.length === 0) break;
      recorder.play(legal[legal.length - 1] as CongklakMove, 'player', elapsed);
    } else {
      const ai = recorder.aiMove();
      if (!ai) break;
      recorder.play(ai, 'ai', elapsed);
    }
  }

  const replay = recorder.finish();
  if (replay.moves.length < 2) return; // nothing to append past

  // Duplicate the last move so the list runs on past the terminal position.
  const last = replay.moves[replay.moves.length - 1];
  assert.ok(last);
  const extended = {
    ...replay,
    moves: [...replay.moves, { ...last, seq: replay.moves.length }],
  };
  const result = validateReplay(extended, winnable, congklakEngine as never);
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// AI tiers
// ---------------------------------------------------------------------------

test('every tier produces a legal move, and the tiers are not all identical', () => {
  const state = congklakEngine.init(
    { game: 'congklak', pits: [0, 4, 2, 7, 1, 3, 0, 5, 2, 6, 1, 3], playerSide: 1, toMove: 2 },
    {},
  ) as CongklakState;

  const chosen = AI_TIERS.map((tier) => congklakEngine.aiMove(state as never, tier, 11));
  for (const move of chosen) {
    assert.ok(move);
    assert.equal(congklakEngine.isLegal(state as never, move as never), true);
  }

  // A ladder whose three tiers play identically is a ladder with one tier, and
  // the difficulty curve every mission is authored against would be fiction.
  const distinct = new Set(chosen.map((move) => JSON.stringify(move)));
  assert.ok(distinct.size > 1, 'the tiers should not all pick the same move here');
});

test('Benteng tiers also differ, and all stay legal', () => {
  const state = bentengEngine.init(
    {
      game: 'benteng',
      width: 5,
      height: 5,
      bases: [
        { side: 1, x: 2, y: 4 },
        { side: 2, x: 2, y: 0 },
      ],
      units: [
        { id: 'p1', side: 1, x: 1, y: 3 },
        { id: 'p2', side: 1, x: 3, y: 3 },
        { id: 'e1', side: 2, x: 2, y: 1, freshness: 3 },
        { id: 'e2', side: 2, x: 0, y: 1 },
      ],
      toMove: 2,
    },
    {},
  );

  for (const tier of AI_TIERS) {
    const move = bentengEngine.aiMove(state as never, tier, 5);
    assert.ok(move);
    assert.equal(bentengEngine.isLegal(state as never, move as never), true);
  }
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function summary(id: string, node: string, rating: number): MissionSummary {
  return {
    id,
    gameId: id.slice(0, id.indexOf('.')) as never,
    contentVersion: 1,
    rank: 1,
    rating,
    primaryNode: node as never,
    skillWeights: { [node]: 1 } as never,
  };
}

const BASE_INPUT = {
  mastery: {},
  studentRatings: { congklak: 900, benteng: 900 },
  recentMissionIds: [],
  recentSkillNodeIds: [],
  consecutiveFailures: 0,
  now: 1_700_000_000_000,
  candidates: [
    summary('congklak.m01', 'comp.counting', 700),
    summary('congklak.m10', 'algo.greedy', 900),
    summary('benteng.m01', 'sec.assets', 1200),
  ],
};

test('an empty catalog recommends nothing rather than throwing', () => {
  assert.deepEqual(selectMissions({ ...BASE_INPUT, candidates: [] } as never, 3), []);
});

test('the limit is respected', () => {
  assert.equal(selectMissions(BASE_INPUT as never, 2).length, 2);
  assert.equal(selectMissions(BASE_INPUT as never, 99).length, 3);
});

test('repeated failure steers toward something easier', () => {
  const struggling = {
    ...BASE_INPUT,
    consecutiveFailures: 3,
    recentSkillNodeIds: ['algo.greedy', 'algo.greedy', 'algo.greedy'],
  };
  const picked = selectMissions(struggling as never, 1);
  assert.equal(picked.length, 1);
  // A student who has failed three times running should not be handed the
  // hardest thing in the catalogue.
  assert.notEqual(picked[0]?.missionId, 'benteng.m01');
});

test('placement mode recommends without needing any history', () => {
  const placement = { ...BASE_INPUT, inPlacement: true };
  const picked = selectMissions(placement as never, 3);
  assert.ok(picked.length > 0);
  assert.ok(picked.every((entry) => typeof entry.displayReasonKey === 'string'));
});

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

test('an unknown certificate id resolves to nothing', () => {
  assert.equal(certificateById('cert.imaginary'), null);
  const first = CERTIFICATES[0];
  assert.ok(first);
  assert.equal(certificateById(first.id)?.id, first.id);
});

test('a certificate names why it was refused, node by node', () => {
  // A locked badge with no explanation tells a student nothing they can act on,
  // which is the same reason a recommendation carries its reason.
  const definition = CERTIFICATES[0];
  assert.ok(definition);

  const none = checkCertificate(definition, {});
  assert.equal(none.qualifies, false);
  assert.ok(none.blockedBy.every((entry) => entry.reason === 'no_evidence'));

  // Evidence exists but the band is short of mastered.
  const partial: Record<string, unknown> = {};
  for (const node of definition.requiredNodes) {
    partial[node] = { mastery: 0.5, evidenceCount: 6, distinctSources: 3, distinctDays: 5 };
  }
  assert.ok(
    checkCertificate(definition, partial as never).blockedBy.every(
      (entry) => entry.reason === 'not_mastered',
    ),
  );

  // Mastered, but from one source on one day — the two conditions that stop a
  // single lucky session becoming a credential an employer might read.
  const shallow: Record<string, unknown> = {};
  for (const node of definition.requiredNodes) {
    shallow[node] = { mastery: 0.95, evidenceCount: 9, distinctSources: 1, distinctDays: 1 };
  }
  assert.ok(
    checkCertificate(definition, shallow as never).blockedBy.every(
      (entry) => entry.reason === 'too_few_sources',
    ),
  );

  // Enough sources, still one day.
  const oneDay: Record<string, unknown> = {};
  for (const node of definition.requiredNodes) {
    oneDay[node] = { mastery: 0.95, evidenceCount: 9, distinctSources: 4, distinctDays: 1 };
  }
  assert.ok(
    checkCertificate(definition, oneDay as never).blockedBy.every(
      (entry) => entry.reason === 'too_few_days',
    ),
  );

  // Everything satisfied.
  const full: Record<string, unknown> = {};
  for (const node of definition.requiredNodes) {
    full[node] = { mastery: 0.95, evidenceCount: 12, distinctSources: 4, distinctDays: 6 };
  }
  const earned = checkCertificate(definition, full as never);
  assert.equal(earned.qualifies, true);
  assert.deepEqual(earned.blockedBy, []);
});

// ---------------------------------------------------------------------------
// Class goal
// ---------------------------------------------------------------------------

test('a class with no members still reports a floor target, not zero', () => {
  // A target of zero would render as already achieved on an empty class.
  const goal = classGoal(0, []);
  assert.ok(goal.target > 0);
  assert.equal(goal.achieved, false);
  assert.equal(goal.progress, 0);
});
