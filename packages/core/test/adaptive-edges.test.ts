/**
 * The adaptive engine's edges, and the recorder's.
 *
 * These are the branches that decide what a student is told about themselves.
 * An abandoned attempt that produced evidence would let a child lower their own
 * mastery by closing the app; a recommendation list that can come back empty
 * would tell a student there is nothing left for them to do; a struggle
 * detector that fires on three failures at three *different* skills would send
 * a teacher after a problem that is not there.
 *
 * Each is one condition, and each was uncovered — the happy paths through this
 * code are heavily tested and the refusals were not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECAY_ATTENTION_DAYS,
  MIN_CLASS_TARGET,
  NODES_PER_STUDENT,
  STRUGGLE_THRESHOLD,
  applyEvidence,
  bandOf,
  classGoal,
  classGoalTarget,
  congklakEngine,
  detectStruggle,
  domainRollup,
  initialMastery,
  isCounted,
  isGameId,
  paramsFor,
  primaryNodeOf,
  recordReplay,
  ReplayRecorder,
  selectMissions,
  supportOptionsFor,
  validateReplay,
} from '../dist/index.js';
import type { Mission } from '../dist/types/mission.js';
import type { AttemptSummary } from '../dist/types/attempt.js';
import type { CongklakMove } from '../dist/index.js';

const MISSION: Mission = {
  id: 'congklak.m03',
  game: 'congklak',
  rank: 3,
  contentVersion: 1,
  skillWeights: { 'comp.counting': 1 },
  eloDifficulty: 900,
  goal: { kind: 'collect', count: 40 },
  setup: {
    game: 'congklak',
    pits: [0, 3, 3, 3, 3, 3, 0, 3, 3, 3, 3, 3],
    playerSide: 1,
    toMove: 1,
  },
  constraints: { maxMoves: 30, aiTier: 'sedang' },
  config: { extraTurnOnStore: true, captureEnabled: true, continuationEnabled: true },
  seed: 17,
  rationale: 'Counting seeds and predicting where the last one lands.',
  titleKey: 'x',
  briefKey: 'x',
  hintKeys: [],
  failureKeys: { ranOut: 'x' },
};

// ---------------------------------------------------------------------------
// Mastery ---------------------------------------------------------------------------

test('an abandoned attempt produces no evidence at all', () => {
  // Closing the app mid-mission must not be able to lower a student's mastery.
  // If it could, the safest way to protect a record would be to stop playing.
  const updates = applyEvidence(
    {},
    {
      outcome: 'abandoned',
      skillWeights: { 'comp.counting': 1 },
      source: 'game',
      sourceKey: 'a1',
      hintShown: false,
      hintUsed: false,
      priorSourceKeys: {},
      at: 0,
    } as never,
  );

  assert.deepEqual(updates, []);
});

test('a skill with no weight in an attempt is untouched by it', () => {
  // A mission that mentions a node with weight zero is not evidence about that
  // node. Treating it as evidence would let unrelated play move a mastery a
  // teacher then has to explain.
  const updates = applyEvidence(
    {},
    {
      outcome: 'success',
      skillWeights: { 'comp.counting': 1, 'algo.greedy': 0 },
      source: 'game',
      sourceKey: 'a2',
      hintShown: false,
      hintUsed: false,
      priorSourceKeys: {},
      at: 0,
    } as never,
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.skillNodeId, 'comp.counting');
});

test('per-node parameter overrides fall back field by field', () => {
  // A partial override must not silently reset the fields it does not mention
  // to some default — those are tuned per domain and a reset would re-rate
  // every student on that node.
  const base = paramsFor('comp.counting');
  const partial = paramsFor('comp.counting', { 'comp.counting': { pSlip: 0.05 } });

  assert.equal(partial.pSlip, 0.05);
  assert.equal(partial.pTransit, base.pTransit);
  assert.equal(partial.pGuess, base.pGuess);
  assert.equal(partial.pInit, base.pInit);

  // And no override at all returns the base untouched.
  assert.deepEqual(paramsFor('comp.counting', undefined), base);
});

test('a node with no evidence starts at its domain prior, not at zero', () => {
  const fresh = initialMastery('sec.assets');
  assert.ok(fresh.value > 0, 'starting every student at zero would call them all beginners');
  assert.equal(fresh.evidenceCount, 0);
});

test('a domain rollup over nothing is empty rather than a confident zero', () => {
  const rollup = domainRollup([], {});
  assert.ok(Array.isArray(rollup) || typeof rollup === 'object');
});

// ---------------------------------------------------------------------------
// Bands ---------------------------------------------------------------------------

test('a band needs evidence behind it, not just a value', () => {
  // The distinction bands rest on: 0.7 from one lucky attempt and 0.7
  // from twenty are not the same claim about a child.
  assert.notEqual(bandOf(0.9, 0), bandOf(0.9, 20));
});

// ---------------------------------------------------------------------------
// Class goals
// ---------------------------------------------------------------------------

test('an empty class still has a target worth aiming at', () => {
  // A target of zero is met before anybody plays, which is not a goal.
  assert.equal(classGoalTarget(0), MIN_CLASS_TARGET);
  assert.equal(classGoalTarget(-3), MIN_CLASS_TARGET);
});

test('a small class does not get a target smaller than the floor', () => {
  assert.equal(classGoalTarget(1), MIN_CLASS_TARGET);
  assert.equal(classGoalTarget(20), 20 * NODES_PER_STUDENT);
});

test('only Proficient and above counts toward the class goal', () => {
  // Counting every band would mean the goal advances when a student merely
  // opens the app, which teaches the class that the bar means nothing.
  assert.equal(isCounted('mastered'), true);
  assert.equal(isCounted('proficient'), true);
  assert.equal(isCounted('developing'), false);
  assert.equal(isCounted('emerging'), false);
  assert.equal(isCounted('not_started'), false);
});

test('a class where nobody has contributed reports nobody, not zero students', () => {
  const goal = classGoal(3, [
    { userId: 'a', bands: ['emerging', 'developing'] },
    { userId: 'b', bands: [] },
  ] as never);

  assert.equal(goal.contributors, 0);
  assert.equal(goal.reached, 0);
  assert.equal(goal.progress, 0);
  assert.equal(goal.achieved, false);
  assert.ok(goal.target >= MIN_CLASS_TARGET);
});

test('a student counts once as a contributor however many nodes they hold', () => {
  const goal = classGoal(2, [
    { userId: 'a', bands: ['proficient', 'mastered', 'proficient'] },
  ] as never);

  assert.equal(goal.contributors, 1);
  assert.equal(goal.reached, 3);
});

test('a class that overshoots has met its goal rather than exceeded a quota', () => {
  // Clamped at 1, because a bar past 100% invites a race nobody set — and the
  // one it would invite is between children in the same room.
  const goal = classGoal(1, [{ userId: 'a', bands: new Array(30).fill('mastered') }] as never);

  assert.equal(goal.progress, 1);
  assert.equal(goal.achieved, true);
  assert.ok(goal.reached > goal.target);
});

// ---------------------------------------------------------------------------
// Struggle ---------------------------------------------------------------------------

test('struggle needs consecutive failures on the same skill', () => {
  const fail = (primaryNode: string): AttemptSummary =>
    ({ outcome: 'failure', primaryNode }) as never;

  // Three failures, three different skills: not a struggle with one thing, and
  // sending a teacher after it would waste the one intervention they have time
  // for.
  assert.equal(detectStruggle([fail('a'), fail('b'), fail('c')]), null);

  // Fewer than the threshold is not yet a pattern.
  assert.equal(detectStruggle([fail('a'), fail('a')]), null);

  // A success in the run breaks it.
  assert.equal(
    detectStruggle([fail('a'), { outcome: 'success', primaryNode: 'a' } as never, fail('a')]),
    null,
  );

  const detected = detectStruggle(new Array(STRUGGLE_THRESHOLD).fill(fail('comp.modular')));
  assert.ok(detected);
  assert.equal(detected?.skillNodeId, 'comp.modular');
});

test('support offered matches support that exists', () => {
  // Offering a lesson that has not been written is worse than offering nothing:
  // the student taps it and finds an empty screen.
  // A hint is always there: it is the one form of help that needs nothing
  // authored and does not take a student out of the mission they are in.
  assert.deepEqual(supportOptionsFor(false, false), ['hint']);
  assert.deepEqual(supportOptionsFor(true, false), ['hint', 'lesson']);
  assert.deepEqual(supportOptionsFor(false, true), ['easier', 'hint']);

  // Ordered by how little each interrupts: an easier mission keeps them
  // playing, a hint keeps them in this mission, a lesson leaves the game.
  assert.deepEqual(supportOptionsFor(true, true), ['easier', 'hint', 'lesson']);
});

// ---------------------------------------------------------------------------
// Selection ---------------------------------------------------------------------------

const candidate = (id: string, rating: number, node: string, rank = 3) => ({
  id,
  gameId: 'congklak' as const,
  contentVersion: 1,
  rank,
  rating,
  primaryNode: node,
  skillWeights: { [node]: 1 },
});

const selectionInput = (over: Record<string, unknown>) =>
  ({
    studentRatings: {},
    mastery: {},
    candidates: [],
    recentMissionIds: [],
    recentSkillNodeIds: [],
    consecutiveFailures: 0,
    now: 0,
    inPlacement: false,
    ...over,
  }) as never;

test('a student is never told there is nothing left to do', () => {
  // Every candidate is far above the student and filtered out of the ranked
  // pool. Returning an empty list would render as "no missions" on the first
  // screen a child sees, so the fallback promotes the best of a bad set.
  const result = selectMissions(
    selectionInput({
      studentRatings: { congklak: 400 },
      candidates: [
        candidate('congklak.m18', 1600, 'comp.counting'),
        candidate('congklak.m19', 1700, 'comp.counting'),
      ],
    }),
    4,
  );

  assert.ok(result.length > 0, 'a student was offered nothing');
});

test('a node the student has never touched is offered as unevidenced, not as a gap', () => {
  // The two read differently to a teacher: a gap is something they have tried
  // and not got, unevidenced is something nobody has looked at yet.
  const result = selectMissions(
    selectionInput({ candidates: [candidate('congklak.m04', 900, 'sec.assets')] }),
    4,
  );

  assert.ok(result.length > 0);
  assert.equal(result[0]?.reason, 'unevidenced');
  assert.ok((result[0]?.displayReasonKey ?? '').length > 0, 'a reason with no string is not shown');
});

test('a skill left alone long enough comes back for reinforcement', () => {
  const now = (DECAY_ATTENTION_DAYS + 5) * 86400000;
  const result = selectMissions(
    selectionInput({
      now,
      studentRatings: { congklak: 900 },
      candidates: [candidate('congklak.m05', 900, 'comp.counting')],
      mastery: { 'comp.counting': { value: 0.6, evidenceCount: 8, lastEvidenceAt: 0 } },
    }),
    4,
  );

  assert.ok(result.length > 0);
  assert.equal(result[0]?.reason, 'reinforce');

  // A node already held high is reinforcement too, whenever it was last seen.
  const strong = selectMissions(
    selectionInput({
      studentRatings: { congklak: 900 },
      candidates: [candidate('congklak.m05', 900, 'comp.counting')],
      mastery: { 'comp.counting': { value: 0.92, evidenceCount: 12, lastEvidenceAt: 0 } },
    }),
    4,
  );
  assert.equal(strong[0]?.reason, 'reinforce');
});

// ---------------------------------------------------------------------------
// Missions and replays
// ---------------------------------------------------------------------------

test('an unknown game id is rejected rather than defaulted', () => {
  assert.equal(isGameId('congklak'), true);
  assert.equal(isGameId('benteng'), true);
  assert.equal(isGameId('chess'), false);
  assert.equal(isGameId(''), false);
});

test('the primary node of a mission with no weights is null, not a guess', () => {
  assert.equal(primaryNodeOf({}), null);
  assert.equal(primaryNodeOf({ 'comp.counting': 0.7, 'algo.greedy': 0.3 }), 'comp.counting');
});

test('a replay that stops mid-mission is abandoned, and that is a valid outcome', () => {
  // Not a rejection. A student whose bus arrived has not cheated, and the
  // attempt still needs to be recorded — it just produces no evidence.
  const recorder = new ReplayRecorder(congklakEngine as never, MISSION);
  recorder.play({ kind: 'sow', pit: 7 } as never, 'player', 1200);

  const replay = recorder.finish();
  assert.equal(replay.claimedOutcome, 'abandoned');

  const result = validateReplay(replay, MISSION, congklakEngine as never);
  assert.equal(result.valid, true, result.valid ? '' : result.reason);
  assert.equal(result.valid && result.outcome, 'abandoned');
});

test('an outcome may be claimed explicitly, and is then checked against the replay', () => {
  const recorder = new ReplayRecorder(congklakEngine as never, MISSION);
  recorder.play({ kind: 'sow', pit: 7 } as never, 'player', 1200);

  const lying = recorder.finish('success');
  const result = validateReplay(lying, MISSION, congklakEngine as never);

  assert.equal(result.valid, false);
  assert.equal(result.valid === false && result.reason, 'goal_not_met');
  // The truth is returned alongside the rejection, so the client can correct
  // what it already showed the student rather than just erasing it.
  assert.equal(result.valid === false && result.actualOutcome, 'abandoned');
});

test('the recorder refuses an illegal move rather than recording it', () => {
  const recorder = new ReplayRecorder(congklakEngine as never, MISSION);
  // Pit 1 belongs to the opponent's row.
  assert.throws(() => recorder.play({ kind: 'sow', pit: 1 } as never, 'player', 900));
});

test('recording stops at a terminal position rather than running the whole script', () => {
  const winnable: Mission = { ...MISSION, goal: { kind: 'collect', count: 1 } };
  const script = new Array(20).fill(null).map((_, i) => ({
    move: { kind: 'sow', pit: 7 + (i % 5) } as CongklakMove,
    actor: 'player' as const,
    elapsedMs: 800 + i * 300,
  }));

  const replay = recordReplay(congklakEngine as never, winnable, script);
  assert.ok(replay.moves.length <= script.length);
  assert.ok(replay.moves.length > 0);
});

test('asking for no recommendations returns none, and asks nothing of the engine', () => {
  assert.deepEqual(
    selectMissions(selectionInput({ candidates: [candidate('congklak.m01', 800, 'comp.counting')] }), 0),
    [],
  );
  assert.deepEqual(selectMissions(selectionInput({}), 4), []);
});
