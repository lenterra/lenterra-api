/**
 * The reward catalogue checks.
 *
 * `rewardRedeem` debits `item.cost` from a points ledger, and the ledger is the
 * one number in the product that must never drift from the reasons behind it.
 * A cost that reached it wrong would not fail loudly — it would quietly make an
 * item free forever, or, if negative, pay a student every time they took it.
 *
 * These run the checker against catalogues written for each case rather than
 * against the authored one, so they still mean something after the shop is
 * rewritten.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkRewards } from '../scripts/content-lib.mjs';

/** Write a candidate catalogue into a throwaway content directory and check it. */
function checkWith(catalogYaml, names = '') {
  const dir = mkdtempSync(join(tmpdir(), 'lenterra-rewards-'));
  try {
    mkdirSync(join(dir, 'rewards'), { recursive: true });
    mkdirSync(join(dir, 'strings'), { recursive: true });

    writeFileSync(join(dir, 'rewards', 'catalog.yaml'), catalogYaml);
    for (const locale of ['id', 'en']) {
      writeFileSync(join(dir, 'strings', `${locale}.yaml`), names ? `reward:\n${names}` : '');
    }

    return checkRewards(dir).issues;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NAMED = '  a.b: "Nama"\n';

describe('reward catalogue', () => {
  test('a well-formed item raises nothing', () => {
    assert.deepEqual(checkWith('a.b:\n  cost: 100\n  kind: title\n  value: rajin\n', NAMED), []);
  });

  test('a zero or negative cost is an error, not a warning', () => {
    // Zero makes the item free permanently. Negative makes redeeming it *award*
    // points — a balance that grows every time a student spends it.
    for (const cost of [0, -50]) {
      const issues = checkWith(`a.b:\n  cost: ${cost}\n  kind: title\n  value: rajin\n`, NAMED);
      assert.equal(issues.length, 1, `cost ${cost} must be rejected`);
      assert.equal(issues[0].level, 'error');
      assert.equal(issues[0].rule, 'reward_cost');
    }
  });

  test('a fractional cost is rejected', () => {
    // The ledger column is BIGINT. A fraction would be truncated somewhere
    // between here and the debit, and which end truncates decides whether the
    // student or the system absorbs the difference.
    const issues = checkWith('a.b:\n  cost: 99.5\n  kind: title\n  value: rajin\n', NAMED);
    assert.equal(issues[0]?.rule, 'reward_cost');
  });

  test('an unknown kind is rejected, which is what keeps rewards cosmetic', () => {
    // Not a typo check. Only cosmetic kinds exist, so a reward that changed how
    // a game plays cannot be authored by accident — somebody would have to add
    // the kind first, deliberately.
    const issues = checkWith('a.b:\n  cost: 100\n  kind: extra_hint\n  value: x\n', NAMED);
    assert.equal(issues[0]?.rule, 'reward_kind');
  });

  test('a missing Indonesian name is an error and a missing English one is a warning', () => {
    // Indonesian is the source locale (ADR-010). An item with no name renders
    // as its id, and `board.congklak.kayu` in a shop reads as a bug.
    const issues = checkWith('a.b:\n  cost: 100\n  kind: title\n  value: rajin\n');
    const levels = Object.fromEntries(issues.map((i) => [i.message.slice(-2), i.level]));
    assert.equal(levels.id, 'error');
    assert.equal(levels.en, 'warning');
  });

  test('two items with the same effect are rejected', () => {
    // Two ids for one colour means a student can buy the same thing twice and
    // the second purchase does nothing visible.
    const issues = checkWith(
      'a.b:\n  cost: 100\n  kind: title\n  value: rajin\nc.d:\n  cost: 200\n  kind: title\n  value: rajin\n',
      '  a.b: "Satu"\n  c.d: "Dua"\n',
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0].rule, 'reward_duplicate');
  });

  test('an absent catalogue is not an error', () => {
    // Rewards are optional content. The server refuses redemptions cleanly when
    // no part is published, and a deployment with no shop is a valid one.
    assert.deepEqual(checkWith(''), []);
  });

  test('the authored catalogue is valid, and every item is cosmetic', () => {
    // The one test that reads the real file. What it protects is the rule
    // rather than the list: nothing in the shop may affect play, and nothing in
    // it may be worth money.
    const { rewards, issues } = checkRewards();
    assert.deepEqual(issues.filter((i) => i.level === 'error'), []);

    for (const [id, item] of Object.entries(rewards)) {
      assert.ok(
        ['avatar_color', 'board_skin', 'title'].includes(item.kind),
        `${id} must be cosmetic, got ${item.kind}`,
      );
      assert.ok(item.cost > 0, `${id} must cost something`);
    }
  });
});
