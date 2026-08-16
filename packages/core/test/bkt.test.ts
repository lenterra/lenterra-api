import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BKT_PARAMS,
  applyDecay,
  applyMasteryCaps,
  bktPosterior,
  bktPredict,
  bktUpdate,
  bktUpdateWeighted,
  effectiveWeight,
  SINGLE_SOURCE_CEILING,
  type BktParams,
} from '../dist/adaptive/bkt.js';
import { createRng } from '../dist/math.js';

const P: BktParams = DEFAULT_BKT_PARAMS;
const EPS = 1e-9;

test('fixed vectors — posterior matches the closed form to 1e-9', () => {
  // p·(1−S) / (p·(1−S) + (1−p)·G)  with p = 0.15, S = 0.10, G = 0.20
  const correct = (0.15 * 0.9) / (0.15 * 0.9 + 0.85 * 0.2);
  assert.ok(Math.abs(bktPosterior(0.15, true, P) - correct) < EPS);

  // p·S / (p·S + (1−p)·(1−G))
  const wrong = (0.15 * 0.1) / (0.15 * 0.1 + 0.85 * 0.8);
  assert.ok(Math.abs(bktPosterior(0.15, false, P) - wrong) < EPS);

  // Full update applies learning on top of the posterior.
  assert.ok(Math.abs(bktUpdate(0.15, true, P) - (correct + (1 - correct) * 0.12)) < EPS);
});

test('bounds hold over 10,000 random sequences', () => {
  const rng = createRng(20260816);
  for (let run = 0; run < 200; run++) {
    let p = rng();
    for (let step = 0; step < 50; step++) {
      p = bktUpdateWeighted(p, rng() > 0.5, P, rng());
      assert.ok(p >= 0 && p <= 1, `mastery escaped [0,1]: ${p}`);
      assert.ok(p === p, 'mastery became NaN');
    }
  }
});

test('monotonicity — a success never lowers mastery, a failure never raises it', () => {
  const rng = createRng(7);
  for (let i = 0; i < 500; i++) {
    const prior = rng();
    const weight = rng();
    assert.ok(bktUpdateWeighted(prior, true, P, weight) >= prior - EPS, 'success lowered mastery');
    assert.ok(bktUpdateWeighted(prior, false, P, weight) <= prior + EPS, 'failure raised mastery');
  }
});

test('weight zero leaves mastery exactly unchanged', () => {
  for (const prior of [0, 0.15, 0.5, 0.84, 1]) {
    assert.equal(bktUpdateWeighted(prior, true, P, 0), prior);
    assert.equal(bktUpdateWeighted(prior, false, P, 0), prior);
  }
});

test('convergence — 20 consecutive successes reach at least 0.95', () => {
  let p = P.pInit;
  for (let i = 0; i < 20; i++) p = bktUpdate(p, true, P);
  assert.ok(p >= 0.95, `converged only to ${p}`);
});

test('a hint discounts the update without erasing it', () => {
  const unhinted = bktUpdateWeighted(0.5, true, P, effectiveWeight(1, false, false, 'game'));
  const hinted = bktUpdateWeighted(0.5, true, P, effectiveWeight(1, true, true, 'game'));

  assert.ok(hinted > 0.5, 'a hinted success must still count for something');
  assert.ok(hinted < unhinted, 'a hinted success must count for less');
});

test('cap enforcement — single-source evidence never exceeds Proficient', () => {
  let p = P.pInit;
  for (let i = 0; i < 40; i++) {
    p = applyMasteryCaps(bktUpdate(p, true, P), 1, i + 1);
  }
  assert.ok(p <= SINGLE_SOURCE_CEILING + EPS, `single-source mastery reached ${p}`);

  // The cap lifts once a second mission contributes.
  const lifted = applyMasteryCaps(0.97, 2, 10);
  assert.equal(lifted, 0.97);
});

test('thin evidence is capped below certainty even with two sources', () => {
  assert.equal(applyMasteryCaps(0.99, 2, 2), 0.92);
  assert.equal(applyMasteryCaps(0.99, 2, 3), 0.99);
});

test('bktPredict sits between guess and 1 − slip', () => {
  assert.ok(Math.abs(bktPredict(0, P) - P.pGuess) < EPS);
  assert.ok(Math.abs(bktPredict(1, P) - (1 - P.pSlip)) < EPS);
});

test('effectiveWeight multiplies skill weight, hint discount, and source factor', () => {
  assert.ok(Math.abs(effectiveWeight(0.5, false, false, 'game') - 0.5) < EPS);
  assert.ok(Math.abs(effectiveWeight(0.5, true, true, 'game') - 0.2) < EPS);
  assert.ok(Math.abs(effectiveWeight(0.5, true, false, 'game') - 0.4) < EPS);
  assert.ok(Math.abs(effectiveWeight(1, false, false, 'check') - 0.8) < EPS);
  assert.ok(Math.abs(effectiveWeight(1, false, false, 'repeat') - 0.5) < EPS);
});

test('a degenerate parameter set returns the prior rather than NaN', () => {
  const degenerate: BktParams = { pInit: 0.5, pTransit: 0, pSlip: 0, pGuess: 1 };
  // Denominator vanishes for an incorrect observation with these parameters.
  assert.equal(bktPosterior(0, false, degenerate), 0);
});

test('decay leaves recent evidence alone and floors previously-mastered nodes', () => {
  assert.equal(applyDecay(0.9, 10, true), 0.9, 'inside the grace period');
  assert.equal(applyDecay(0.9, 30, true), 0.9, 'at the grace boundary');
  assert.ok(Math.abs(applyDecay(0.9, 37, true) - 0.89) < EPS, 'one week past grace');
  assert.equal(applyDecay(0.9, 3650, true), 0.5, 'floored for a mastered node');
  assert.equal(applyDecay(0.3, 3650, false), 0, 'unfloored otherwise');
});
