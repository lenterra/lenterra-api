/**
 * Certificate and achievement rules.
 *
 * Certificates are the artefact a student may show to someone outside this
 * product, so the tests here are mostly about what *fails* to qualify. Every
 * condition is asserted individually, because a certificate that issues one
 * condition too early is worse than one that never issues: it makes a claim
 * about a child to a stranger.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACHIEVEMENTS,
  CERTIFICATES,
  achievementsFrom,
  certificateById,
  certificatesEarned,
  checkCertificate,
  isGreedyTrapRank,
  type AchievementFacts,
  type NodeEvidence,
} from '../dist/index.js';

const found = certificateById('cert.algo.foundations');
if (!found) throw new Error('cert.algo.foundations is missing from the definitions');
const ALGO_FOUNDATIONS = found;

/** Evidence that satisfies every condition, to be degraded per test. */
function goodEvidence(overrides: Partial<NodeEvidence> = {}) {
  const base: NodeEvidence = {
    mastery: 0.9,
    evidenceCount: 6,
    distinctSources: 3,
    distinctDays: 5,
    ...overrides,
  };
  const out: Record<string, NodeEvidence> = {};
  for (const node of ALGO_FOUNDATIONS.requiredNodes) out[node] = { ...base };
  return out;
}

describe('certificate definitions', () => {
  test('every required node is a real taxonomy node id', () => {
    // A definition naming a node that does not exist would silently never
    // issue, which reads as "no student has earned it yet".
    const valid = /^(comp|algo|sec)\.[a-z-]+$/;
    for (const definition of CERTIFICATES) {
      assert.ok(definition.requiredNodes.length > 0, `${definition.id} requires no nodes`);
      for (const node of definition.requiredNodes) {
        assert.match(node, valid, `${definition.id} names ${node}`);
      }
    }
  });

  test('no certificate can be earned from a single mission', () => {
    for (const definition of CERTIFICATES) {
      assert.ok(definition.minEvidenceSources >= 2, `${definition.id} accepts one source`);
    }
  });

  test('no certificate can be earned in one sitting', () => {
    for (const definition of CERTIFICATES) {
      assert.ok(definition.minDistinctDays >= 3, `${definition.id} accepts one day`);
    }
  });
});

describe('checkCertificate', () => {
  test('issues when every condition is met', () => {
    const result = checkCertificate(ALGO_FOUNDATIONS, goodEvidence());
    assert.equal(result.qualifies, true);
    assert.deepEqual(result.blockedBy, []);
  });

  test('refuses a node that is merely proficient', () => {
    // 0.84 is deliberately just under the 0.85 mastered floor.
    const result = checkCertificate(ALGO_FOUNDATIONS, goodEvidence({ mastery: 0.84 }));
    assert.equal(result.qualifies, false);
    assert.equal(result.blockedBy[0]?.reason, 'not_mastered');
  });

  test('refuses high mastery with no evidence behind it', () => {
    // The prior alone can look like a number; it is not a demonstration.
    const result = checkCertificate(ALGO_FOUNDATIONS, goodEvidence({ evidenceCount: 0 }));
    assert.equal(result.qualifies, false);
    assert.equal(result.blockedBy[0]?.reason, 'no_evidence');
  });

  test('refuses a single well-played mission', () => {
    const result = checkCertificate(ALGO_FOUNDATIONS, goodEvidence({ distinctSources: 1 }));
    assert.equal(result.qualifies, false);
    assert.equal(result.blockedBy[0]?.reason, 'too_few_sources');
  });

  test('refuses a whole ladder cleared in one evening', () => {
    // This is the case the day condition exists for: the mastery model is
    // right that the student performed, and wrong that they learned.
    const result = checkCertificate(ALGO_FOUNDATIONS, goodEvidence({ distinctDays: 1 }));
    assert.equal(result.qualifies, false);
    assert.equal(result.blockedBy[0]?.reason, 'too_few_days');
  });

  test('refuses when one required node is missing entirely', () => {
    const evidence = goodEvidence();
    delete evidence[ALGO_FOUNDATIONS.requiredNodes[2] as string];
    const result = checkCertificate(ALGO_FOUNDATIONS, evidence);
    assert.equal(result.qualifies, false);
    assert.equal(result.blockedBy.length, 1);
  });

  test('reports every blocked node, not just the first', () => {
    const evidence = goodEvidence();
    (evidence[ALGO_FOUNDATIONS.requiredNodes[0] as string] as NodeEvidence).mastery = 0.5;
    (evidence[ALGO_FOUNDATIONS.requiredNodes[1] as string] as NodeEvidence).distinctDays = 1;
    const result = checkCertificate(ALGO_FOUNDATIONS, evidence);
    assert.equal(result.blockedBy.length, 2);
  });

  test('boundary: exactly at each minimum still qualifies', () => {
    const result = checkCertificate(
      ALGO_FOUNDATIONS,
      goodEvidence({
        mastery: 0.85,
        evidenceCount: 1,
        distinctSources: ALGO_FOUNDATIONS.minEvidenceSources,
        distinctDays: ALGO_FOUNDATIONS.minDistinctDays,
      }),
    );
    assert.equal(result.qualifies, true);
  });
});

describe('certificatesEarned', () => {
  test('earns only the certificate whose nodes are evidenced', () => {
    const earned = certificatesEarned(goodEvidence());
    assert.deepEqual(earned, ['cert.algo.foundations']);
  });

  test('earns nothing from an empty history', () => {
    assert.deepEqual(certificatesEarned({}), []);
  });
});

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

function facts(overrides: Partial<AchievementFacts> = {}): AchievementFacts {
  return {
    missionId: 'congklak.m03',
    game: 'congklak',
    rank: 3,
    success: true,
    totalValidatedAttempts: 10,
    distinctGamesPlayed: 1,
    priorSuccesses: 2,
    chainMaxLength: 0,
    unitsLost: 0,
    streakDays: 1,
    masteryAfter: [{ mastery: 0.4, evidenceCount: 3 }],
    ...overrides,
  };
}

describe('achievementsFrom', () => {
  test('a failed attempt earns nothing', () => {
    // Including the ones whose other conditions are met.
    const earned = achievementsFrom(
      facts({ success: false, totalValidatedAttempts: 1, chainMaxLength: 8 }),
    );
    assert.deepEqual(earned, []);
  });

  test('the first validated attempt earns Langkah Pertama', () => {
    assert.ok(
      achievementsFrom(facts({ totalValidatedAttempts: 1 })).includes(ACHIEVEMENTS.firstMission),
    );
  });

  test('the second does not', () => {
    assert.ok(
      !achievementsFrom(facts({ totalValidatedAttempts: 2 })).includes(ACHIEVEMENTS.firstMission),
    );
  });

  test('Penjelajah needs two games played, not two won', () => {
    assert.ok(achievementsFrom(facts({ distinctGamesPlayed: 2 })).includes(ACHIEVEMENTS.bothGames));
    assert.ok(
      !achievementsFrom(facts({ distinctGamesPlayed: 1 })).includes(ACHIEVEMENTS.bothGames),
    );
  });

  test('Rantai Emas needs a six-link chain', () => {
    assert.ok(!achievementsFrom(facts({ chainMaxLength: 5 })).includes(ACHIEVEMENTS.goldenChain));
    assert.ok(achievementsFrom(facts({ chainMaxLength: 6 })).includes(ACHIEVEMENTS.goldenChain));
  });

  test('Penjaga Benteng needs the fortress mission won intact', () => {
    const intact = facts({ missionId: 'benteng.m08', game: 'benteng', rank: 8, unitsLost: 0 });
    assert.ok(achievementsFrom(intact).includes(ACHIEVEMENTS.fortressKeeper));

    const costly = { ...intact, unitsLost: 1 };
    assert.ok(!achievementsFrom(costly).includes(ACHIEVEMENTS.fortressKeeper));
  });

  test('Bukan Serakah is first-attempt only', () => {
    // Once you have solved a greedy trap, solving it again proves nothing
    // about resisting the greedy move — you already know the answer.
    const first = facts({ rank: 16, priorSuccesses: 0 });
    assert.ok(achievementsFrom(first).includes(ACHIEVEMENTS.notGreedy));

    const repeat = facts({ rank: 16, priorSuccesses: 1 });
    assert.ok(!achievementsFrom(repeat).includes(ACHIEVEMENTS.notGreedy));
  });

  test('Bukan Serakah only applies to the greedy-trap tier', () => {
    assert.equal(isGreedyTrapRank('congklak', 14), false);
    assert.equal(isGreedyTrapRank('congklak', 15), true);
    assert.equal(isGreedyTrapRank('congklak', 18), true);
    assert.equal(isGreedyTrapRank('congklak', 19), false);
    // Benteng has no greedy move to resist.
    assert.equal(isGreedyTrapRank('benteng', 16), false);
  });

  test('Ahli Pertama needs a node genuinely mastered', () => {
    const mastered = facts({ masteryAfter: [{ mastery: 0.86, evidenceCount: 4 }] });
    assert.ok(achievementsFrom(mastered).includes(ACHIEVEMENTS.firstMastery));

    // High value, no evidence — the prior, not a demonstration.
    const unevidenced = facts({ masteryAfter: [{ mastery: 0.95, evidenceCount: 0 }] });
    assert.ok(!achievementsFrom(unevidenced).includes(ACHIEVEMENTS.firstMastery));
  });

  test('the teacher-awarded one is never granted automatically', () => {
    const everything = facts({
      missionId: 'benteng.m08',
      game: 'benteng',
      rank: 8,
      totalValidatedAttempts: 1,
      distinctGamesPlayed: 2,
      priorSuccesses: 0,
      chainMaxLength: 9,
      unitsLost: 0,
      streakDays: 30,
      masteryAfter: [{ mastery: 1, evidenceCount: 20 }],
    });
    assert.ok(!achievementsFrom(everything).includes(ACHIEVEMENTS.littleTeacher));
  });

  test('at least three achievements need no competition with anyone', () => {
    // A student with no classmates must still have things to earn.
    const solo = facts({
      totalValidatedAttempts: 1,
      distinctGamesPlayed: 2,
      streakDays: 7,
      chainMaxLength: 6,
    });
    assert.ok(achievementsFrom(solo).length >= 3);
  });
});
