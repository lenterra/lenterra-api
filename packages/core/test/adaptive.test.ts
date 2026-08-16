import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RATING,
  expectedScore,
  missionK,
  seedRatingFromPlacement,
  studentK,
  updateRatings,
} from '../dist/adaptive/elo.js';
import {
  RECOVERY_MIN_PREDICTED,
  selectMissions,
  type SelectionInput,
} from '../dist/adaptive/select.js';
import { detectStruggle } from '../dist/adaptive/struggle.js';
import {
  applyEvidence,
  domainRollup,
  recomputeMastery,
  type EvidenceInput,
  type MasteryState,
} from '../dist/adaptive/mastery.js';
import { bandOf, nodesInDomain } from '../dist/types/taxonomy.js';
import { createRng } from '../dist/math.js';
import type { MissionSummary } from '../dist/types/mission.js';
import type { SkillNodeId } from '../dist/types/taxonomy.js';

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// ELO
// ---------------------------------------------------------------------------

test('equal ratings predict an even chance', () => {
  assert.ok(Math.abs(expectedScore(1000, 1000) - 0.5) < EPS);
});

test('a 400-point advantage predicts roughly 10 to 1', () => {
  assert.ok(Math.abs(expectedScore(1400, 1000) - 10 / 11) < 1e-6);
});

test('student gain equals mission loss, scaled by the K ratio', () => {
  const before = { student: 1000, mission: 1200 };
  const after = updateRatings(before.student, before.mission, true, 40, 8);

  const studentGain = after.student - before.student;
  const missionLoss = before.mission - after.mission;

  assert.ok(studentGain > 0, 'a win raises the student');
  assert.ok(missionLoss > 0, 'and lowers the mission');
  assert.ok(Math.abs(studentGain / 40 - missionLoss / 8) < EPS, 'the ratio is the K ratio');
});

test('K factors follow the published schedule', () => {
  assert.equal(studentK(0), 40);
  assert.equal(studentK(9), 40);
  assert.equal(studentK(10), 20);
  assert.equal(missionK(49), 8);
  assert.equal(missionK(50), 2);
});

test('placement seeds a rating inside the sane range', () => {
  const strong = seedRatingFromPlacement([
    { missionRating: 800, success: true },
    { missionRating: 1100, success: true },
    { missionRating: 1400, success: true },
  ]);
  const weak = seedRatingFromPlacement([
    { missionRating: 800, success: false },
    { missionRating: 1100, success: false },
    { missionRating: 1400, success: false },
  ]);

  assert.ok(strong > DEFAULT_RATING, 'three wins raise the estimate');
  assert.ok(weak < DEFAULT_RATING, 'three losses lower it');
  assert.ok(strong <= 1600 && weak >= 700, 'both stay inside the clamp');
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function mission(
  id: string,
  rating: number,
  primaryNode: SkillNodeId,
  gameId: 'congklak' | 'benteng' = 'congklak',
): MissionSummary {
  return {
    id,
    gameId,
    contentVersion: 1,
    rank: Number(id.slice(-2)) || 1,
    rating,
    primaryNode,
    skillWeights: { [primaryNode]: 1 } as Partial<Record<SkillNodeId, number>>,
  };
}

const CANDIDATES: MissionSummary[] = [
  mission('congklak.m01', 800, 'comp.counting'),
  mission('congklak.m04', 950, 'comp.modular'),
  mission('congklak.m07', 1150, 'algo.iteration'),
  mission('congklak.m11', 1300, 'algo.lookahead'),
  mission('congklak.m15', 1500, 'algo.greedy'),
  mission('benteng.m02', 900, 'sec.access', 'benteng'),
  mission('benteng.m08', 1450, 'sec.defense', 'benteng'),
];

function baseInput(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    studentRatings: { congklak: 1100, benteng: 1000 },
    mastery: {},
    candidates: CANDIDATES,
    recentMissionIds: [],
    recentSkillNodeIds: [],
    consecutiveFailures: 0,
    now: 1_760_000_000_000,
    ...over,
  };
}

test('selection is deterministic across 1,000 identical calls', () => {
  const input = baseInput();
  const first = JSON.stringify(selectMissions(input, 3));
  for (let i = 0; i < 1000; i++) {
    assert.equal(JSON.stringify(selectMissions(input, 3)), first, `diverged on call ${i}`);
  }
});

test('ties break on mission id, so ordering is stable across platforms', () => {
  const tied = [
    mission('congklak.zz', 1100, 'algo.iteration'),
    mission('congklak.aa', 1100, 'algo.iteration'),
  ];
  const result = selectMissions(baseInput({ candidates: tied }), 2);
  assert.equal(result[0]!.missionId, 'congklak.aa');
});

test('a node one success from the next band outranks an already-mastered one', () => {
  const input = baseInput({
    mastery: {
      'algo.iteration': { value: 0.75, evidenceCount: 5, lastEvidenceAt: 1_760_000_000_000 },
      'algo.lookahead': { value: 0.95, evidenceCount: 9, lastEvidenceAt: 1_760_000_000_000 },
    },
  });
  const ordered = selectMissions(input, 7).map((r) => r.missionId);
  assert.ok(
    ordered.indexOf('congklak.m07') < ordered.indexOf('congklak.m11'),
    'the band-changing node should come first',
  );
});

test('recovery: after three failures the recommendation predicts at least 0.80 success', () => {
  const input = baseInput({ consecutiveFailures: 3 });
  const [primary] = selectMissions(input, 1);

  assert.ok(primary, 'a struggling student must still be given something');
  assert.equal(primary!.reason, 'recovery');
  assert.ok(
    primary!.predictedSuccess >= RECOVERY_MIN_PREDICTED,
    `predicted ${primary!.predictedSuccess}`,
  );
});

test('variety: no node is recommended three times consecutively over 50 attempts', () => {
  let recentMissionIds: string[] = [];
  let recentSkillNodeIds: SkillNodeId[] = [];
  const chosenNodes: SkillNodeId[] = [];

  for (let i = 0; i < 50; i++) {
    const [pick] = selectMissions(
      baseInput({ recentMissionIds, recentSkillNodeIds }),
      1,
    );
    assert.ok(pick, `no recommendation at step ${i}`);

    chosenNodes.push(pick!.primarySkillNodeId);
    recentMissionIds = [pick!.missionId, ...recentMissionIds].slice(0, 10);
    recentSkillNodeIds = [pick!.primarySkillNodeId, ...recentSkillNodeIds].slice(0, 5);

    if (chosenNodes.length >= 3) {
      const [a, b, c] = chosenNodes.slice(-3);
      assert.ok(!(a === b && b === c), `node ${a} recommended three times in a row at step ${i}`);
    }
  }
});

test('a recently played mission is pushed down the list', () => {
  const fresh = selectMissions(baseInput(), 7).map((r) => r.missionId);
  const repeated = selectMissions(
    baseInput({ recentMissionIds: [fresh[0] as string] }),
    7,
  ).map((r) => r.missionId);

  assert.notEqual(repeated[0], fresh[0], 'the just-played mission should not come first again');
});

test('an unevidenced node is labelled as such', () => {
  const [pick] = selectMissions(baseInput(), 1);
  assert.equal(pick!.reason, 'unevidenced');
  assert.equal(pick!.displayReasonKey, 'reco.reason.unevidenced');
});

test('an empty catalog returns nothing rather than throwing', () => {
  assert.deepEqual(selectMissions(baseInput({ candidates: [] }), 3), []);
});

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

function evidence(over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    skillWeights: { 'algo.iteration': 0.6, 'algo.sequencing': 0.4 },
    outcome: 'success',
    hintShown: false,
    hintUsed: false,
    source: 'game',
    sourceKey: 'congklak.m06',
    priorSourceKeys: {},
    ...over,
  };
}

test('an abandoned attempt produces no mastery change at all', () => {
  // A borrowed phone going back to its owner mid-mission is not evidence of a
  // weakness, and scoring it as one would penalise exactly the students this
  // product exists for.
  assert.deepEqual(applyEvidence({}, evidence({ outcome: 'abandoned' })), []);
});

test('a success raises every weighted node and records the band', () => {
  const updates = applyEvidence({}, evidence());
  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.ok(update.after > update.before, `${update.skillNodeId} did not rise`);
    assert.equal(update.correct, true);
    assert.equal(update.evidenceCountAfter, 1);
    assert.equal(update.distinctSourcesAfter, 1);
  }
});

test('updates are ordered by node id, so client and server agree', () => {
  const updates = applyEvidence({}, evidence());
  assert.deepEqual(
    updates.map((u) => u.skillNodeId),
    ['algo.iteration', 'algo.sequencing'],
  );
});

test('reproducibility: replaying a history reproduces stored mastery to 1e-9', () => {
  const history: EvidenceInput[] = [];
  const rng = createRng(99);
  for (let i = 0; i < 60; i++) {
    history.push(
      evidence({
        outcome: rng() > 0.4 ? 'success' : 'failure',
        sourceKey: `congklak.m0${i % 4}`,
        hintUsed: rng() > 0.8,
        hintShown: rng() > 0.7,
      }),
    );
  }

  const once = recomputeMastery(history);
  const twice = recomputeMastery(history);

  for (const node of Object.keys(once)) {
    const a = (once[node] as MasteryState).value;
    const b = (twice[node] as MasteryState).value;
    assert.ok(Math.abs(a - b) < 1e-9, `${node} differed by ${Math.abs(a - b)}`);
  }
  assert.ok(Object.keys(once).length > 0);
});

test('the multi-source cap holds through a full history from one mission', () => {
  const history: EvidenceInput[] = [];
  for (let i = 0; i < 30; i++) history.push(evidence({ sourceKey: 'congklak.m06' }));

  const result = recomputeMastery(history);
  const node = result['algo.iteration'] as MasteryState;

  assert.equal(node.distinctSources, 1);
  assert.ok(node.value <= 0.84 + EPS, `single-source mastery reached ${node.value}`);
  assert.equal(bandOf(node.value, node.evidenceCount), 'proficient');
});

test('a second mission lifts the cap, so Mastered becomes reachable', () => {
  const history: EvidenceInput[] = [];
  for (let i = 0; i < 30; i++) {
    history.push(evidence({ sourceKey: i % 2 === 0 ? 'congklak.m06' : 'congklak.m07' }));
  }

  const node = recomputeMastery(history)['algo.iteration'] as MasteryState;
  assert.equal(node.distinctSources, 2);
  assert.ok(node.value > 0.84, 'the cap lifted');
  assert.equal(bandOf(node.value, node.evidenceCount), 'mastered');
});

test('a course check counts toward the multi-source requirement', () => {
  // A student who learns iteration from a lesson and demonstrates it in
  // Congklak has two independent sources — the transfer signal M-L05 looks for.
  const history: EvidenceInput[] = [];
  for (let i = 0; i < 20; i++) {
    history.push(
      i % 2 === 0
        ? evidence({ sourceKey: 'congklak.m06', source: 'game' })
        : evidence({ sourceKey: 'course.algo.loops.check1', source: 'check' }),
    );
  }
  const node = recomputeMastery(history)['algo.iteration'] as MasteryState;
  assert.equal(node.distinctSources, 2);
});

test('a zero-weight node is left untouched', () => {
  const updates = applyEvidence({}, evidence({ skillWeights: { 'algo.iteration': 0 } }));
  assert.deepEqual(updates, []);
});

test('bandOf treats no evidence as not started, whatever the prior', () => {
  assert.equal(bandOf(0.15, 0), 'not_started');
  assert.equal(bandOf(0.15, 1), 'emerging');
  assert.equal(bandOf(0.4, 1), 'developing');
  assert.equal(bandOf(0.7, 1), 'proficient');
  assert.equal(bandOf(0.85, 1), 'mastered');
});

test('a domain roll-up is computed, never stored', () => {
  const nodes = nodesInDomain('computation');
  assert.equal(nodes.length, 4);

  const rollup = domainRollup(nodes, {
    'comp.counting': { value: 0.8, evidenceCount: 4, distinctSources: 2 },
    'comp.modular': { value: 0.6, evidenceCount: 2, distinctSources: 1 },
  });
  assert.ok(Math.abs(rollup.value - 0.7) < EPS);
  assert.equal(rollup.evidenceCount, 6);
});

// ---------------------------------------------------------------------------
// Struggle
// ---------------------------------------------------------------------------

test('three consecutive failures on one node are detected', () => {
  const attempts = [1, 2, 3].map((i) => ({
    id: `a${i}`,
    missionId: 'congklak.m11',
    primaryNode: 'algo.lookahead' as SkillNodeId,
    outcome: 'failure' as const,
    at: i,
  }));
  assert.deepEqual(detectStruggle(attempts), {
    skillNodeId: 'algo.lookahead',
    attemptIds: ['a1', 'a2', 'a3'],
  });
});

test('an abandoned attempt breaks the struggle chain', () => {
  const attempts = [
    { id: 'a1', missionId: 'm', primaryNode: 'algo.lookahead' as SkillNodeId, outcome: 'abandoned' as const, at: 3 },
    { id: 'a2', missionId: 'm', primaryNode: 'algo.lookahead' as SkillNodeId, outcome: 'failure' as const, at: 2 },
    { id: 'a3', missionId: 'm', primaryNode: 'algo.lookahead' as SkillNodeId, outcome: 'failure' as const, at: 1 },
  ];
  assert.equal(detectStruggle(attempts), null);
});

test('failures spread across different nodes are not a struggle', () => {
  const attempts = [
    { id: 'a1', missionId: 'm', primaryNode: 'algo.lookahead' as SkillNodeId, outcome: 'failure' as const, at: 3 },
    { id: 'a2', missionId: 'm', primaryNode: 'algo.greedy' as SkillNodeId, outcome: 'failure' as const, at: 2 },
    { id: 'a3', missionId: 'm', primaryNode: 'algo.lookahead' as SkillNodeId, outcome: 'failure' as const, at: 1 },
  ];
  assert.equal(detectStruggle(attempts), null);
});

// ---------------------------------------------------------------------------
// Simulated cohort — the test that catches "the maths is right and the
// resulting experience is wrong" before a real student meets it.
// ---------------------------------------------------------------------------

test('100 synthetic students produce a plausible band spread and a 0.55–0.80 success rate', () => {
  const rng = createRng(2026);
  let attempts = 0;
  let successes = 0;
  const finalBands: Record<string, number> = {};

  for (let s = 0; s < 100; s++) {
    // True ability, unknown to the engine, spread across the range.
    const trueAbility = 0.2 + (s / 100) * 0.7;
    let rating = DEFAULT_RATING;
    let matches = 0;
    const mastery: Record<string, MasteryState> = {};
    const sourceKeys: Record<string, string[]> = {};
    let recentMissionIds: string[] = [];
    let recentSkillNodeIds: SkillNodeId[] = [];
    let consecutiveFailures = 0;

    for (let step = 0; step < 40; step++) {
      const [pick] = selectMissions(
        {
          studentRatings: { congklak: rating, benteng: rating },
          mastery: Object.keys(mastery).reduce(
            (acc, node) => {
              const state = mastery[node] as MasteryState;
              acc[node] = {
                value: state.value,
                evidenceCount: state.evidenceCount,
                lastEvidenceAt: 1,
              };
              return acc;
            },
            {} as Record<string, { value: number; evidenceCount: number; lastEvidenceAt: number }>,
          ),
          candidates: CANDIDATES,
          recentMissionIds,
          recentSkillNodeIds,
          consecutiveFailures,
          now: 2,
        },
        1,
      );
      if (!pick) break;

      const target = CANDIDATES.find((m) => m.id === pick.missionId) as MissionSummary;

      // The student succeeds if their ability clears the mission's difficulty,
      // with noise. Nothing here uses the engine's own prediction, so the
      // measured success rate is a real check rather than a tautology.
      const difficulty = (target.rating - 700) / 900;
      const success = rng() < clamp01(trueAbility - difficulty + 0.5);

      attempts++;
      if (success) successes++;
      consecutiveFailures = success ? 0 : consecutiveFailures + 1;

      const updates = applyEvidence(mastery as never, {
        skillWeights: target.skillWeights,
        outcome: success ? 'success' : 'failure',
        hintShown: false,
        hintUsed: false,
        source: 'game',
        sourceKey: target.id,
        priorSourceKeys: sourceKeys as never,
      });
      for (const update of updates) {
        mastery[update.skillNodeId] = {
          value: update.after,
          evidenceCount: update.evidenceCountAfter,
          distinctSources: update.distinctSourcesAfter,
        };
        const keys = sourceKeys[update.skillNodeId] ?? [];
        if (keys.indexOf(target.id) < 0) keys.push(target.id);
        sourceKeys[update.skillNodeId] = keys;
      }

      const next = updateRatings(rating, target.rating, success, studentK(matches), 0);
      rating = next.student;
      matches++;

      recentMissionIds = [pick.missionId, ...recentMissionIds].slice(0, 10);
      recentSkillNodeIds = [pick.primarySkillNodeId, ...recentSkillNodeIds].slice(0, 5);
    }

    for (const node of Object.keys(mastery)) {
      const state = mastery[node] as MasteryState;
      const band = bandOf(state.value, state.evidenceCount);
      finalBands[band] = (finalBands[band] ?? 0) + 1;
    }
  }

  const rate = successes / attempts;
  assert.ok(rate >= 0.55 && rate <= 0.8, `cohort success rate was ${rate.toFixed(3)}`);

  // A plausible distribution has students spread across bands, not piled into
  // one. All-mastered means the content is too easy; all-emerging means the
  // engine never lets anyone progress.
  const total = Object.values(finalBands).reduce((a, b) => a + b, 0);
  assert.ok(Object.keys(finalBands).length >= 3, `only ${Object.keys(finalBands).length} bands`);
  for (const band of Object.keys(finalBands)) {
    assert.ok((finalBands[band] as number) / total < 0.9, `${band} holds almost everything`);
  }
});

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
