/**
 * Redeeming and wearing.
 *
 * The shop worked and the wardrobe did not: twelve items debited real points
 * and changed nothing on any screen, because nothing recorded what a student
 * had *on*. `v1.reward.equip` is that record, and the two checks it makes are
 * the whole of its security surface — you may only wear what you bought, and
 * only in the slot it belongs to.
 *
 * The second check is easy to dismiss as tidiness. It is not: item ids carry no
 * type, so without it a client could put `title.pemikir` into the colour slot,
 * and that string is sent to every classmate's leaderboard as a colour. What
 * renders then is decided by the phone, not by us.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Q } from '../modules/src/db/queries.ts';
import { rewardEquip, rewardRedeem, wornBy } from '../modules/src/rpc/social.ts';
import { fakeCtx, refusal, stub, type Responder } from './fake-nk.mts';

const ME = '55555555-5555-4555-8555-555555555555';
const CLASSMATE = '66666666-6666-4666-8666-666666666666';

const CATALOG = {
  'avatar.color.laut': { cost: 100, kind: 'avatar_color', value: '#0E7C86' },
  'board.congklak.kayu': { cost: 300, kind: 'board_skin', value: 'congklak.kayu' },
  'title.pemikir': { cost: 800, kind: 'title', value: 'pemikir' },
};

const catalogStubs: [string, Responder][] = [
  [Q.currentCatalog, () => [{ version: 'v1', manifest: {} }]],
  [Q.catalogPull, () => [{ part: 'rewards.catalog', sha256: 'x', body: CATALOG }]],
];

/** The slots as they stand after an update; the handler echoes all three back. */
const slots = (over: Record<string, unknown> = {}): Responder => () =>
  [
    {
      equipped_avatar_color: null,
      equipped_board_skin: null,
      equipped_title: null,
      ...over,
    },
  ];

describe('rewardEquip', () => {
  test('an owned item goes into its own slot', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => [{ '?column?': 1 }]],
        ...catalogStubs,
        [Q.equipAvatarColor, slots({ equipped_avatar_color: 'avatar.color.laut' })],
      ]),
    });

    const result = rewardEquip(fake.ctx, { kind: 'avatar_color', itemId: 'avatar.color.laut' });

    assert.equal(result.equipped.avatarColor, 'avatar.color.laut');
    assert.deepEqual(fake.paramsOf(Q.equipAvatarColor), [ME, 'avatar.color.laut']);
  });

  test('each kind writes to its own statement, and only that one', () => {
    const cases: [string, string, string][] = [
      ['avatar_color', 'avatar.color.laut', Q.equipAvatarColor],
      ['board_skin', 'board.congklak.kayu', Q.equipBoardSkin],
      ['title', 'title.pemikir', Q.equipTitle],
    ];

    for (const [kind, itemId, statement] of cases) {
      const fake = fakeCtx(Q, {
        userId: ME,
        queries: stub([
          [Q.redemptionExists, () => [{ '?column?': 1 }]],
          ...catalogStubs,
          [statement, slots()],
        ]),
      });

      rewardEquip(fake.ctx, { kind, itemId });

      assert.equal(fake.countOf(statement), 1, `${kind} must write ${statement.slice(0, 20)}`);
      for (const [, , other] of cases) {
        if (other !== statement) assert.equal(fake.countOf(other), 0);
      }
    }
  });

  test('an item the student does not own is refused', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.redemptionExists, () => []]]),
    });

    const err = refusal(() =>
      rewardEquip(fake.ctx, { kind: 'title', itemId: 'title.pemikir' }),
    );

    assert.equal(err.code, 'FORBIDDEN');
    assert.equal(fake.countOf(Q.equipTitle), 0, 'and nothing is written');
  });

  test('ownership is checked before the catalogue is consulted', () => {
    // Otherwise an unowned id is an oracle for what exists in the catalogue —
    // a small leak, but a free one to close and the ordering is easy to lose.
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.redemptionExists, () => []]]),
    });

    refusal(() => rewardEquip(fake.ctx, { kind: 'title', itemId: 'title.pemikir' }));
    assert.equal(fake.countOf(Q.currentCatalog), 0);
  });

  test('an owned item cannot go in the wrong slot', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => [{ '?column?': 1 }]],
        ...catalogStubs,
      ]),
    });

    const err = refusal(() =>
      // Owned, and genuinely a title — but a title in the colour slot is sent
      // to every classmate as a colour.
      rewardEquip(fake.ctx, { kind: 'avatar_color', itemId: 'title.pemikir' }),
    );

    assert.equal(err.code, 'INVALID_ARGUMENT');
    assert.equal(fake.countOf(Q.equipAvatarColor), 0);
  });

  test('a null item clears the slot without checking ownership', () => {
    // Taking something off must keep working after the item leaves the
    // catalogue, or a withdrawn item becomes permanently stuck on.
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.equipTitle, slots()]]),
    });

    const result = rewardEquip(fake.ctx, { kind: 'title', itemId: null });

    assert.equal(result.equipped.title, null);
    assert.deepEqual(fake.paramsOf(Q.equipTitle), [ME, null]);
    assert.equal(fake.countOf(Q.redemptionExists), 0);
  });

  test('an omitted item id clears the slot too', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub([[Q.equipBoardSkin, slots()]]) });
    rewardEquip(fake.ctx, { kind: 'board_skin' });
    assert.deepEqual(fake.paramsOf(Q.equipBoardSkin), [ME, null]);
  });

  test('an unknown slot is refused before anything is read', () => {
    for (const kind of ['avatar_colour', 'badge', '', 'AVATAR_COLOR']) {
      const fake = fakeCtx(Q, { userId: ME, queries: stub([]) });
      const err = refusal(() => rewardEquip(fake.ctx, { kind, itemId: null }));
      assert.equal(
        err.code,
        'INVALID_ARGUMENT',
        `kind ${JSON.stringify(kind)} must be refused`,
      );
    }
  });

  test('equipping never touches the ledger', () => {
    // Switching between two owned colours must be free. A redemption that
    // charged again on every change would make owning four colours a trap.
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => [{ '?column?': 1 }]],
        ...catalogStubs,
        [Q.equipAvatarColor, slots()],
      ]),
    });

    rewardEquip(fake.ctx, { kind: 'avatar_color', itemId: 'avatar.color.laut' });

    assert.equal(fake.countOf(Q.pointsAward), 0);
    assert.equal(fake.countOf(Q.redemptionInsert), 0);
  });

  test('equipping the same thing twice is idempotent', () => {
    const build = () =>
      fakeCtx(Q, {
        userId: ME,
        queries: stub([
          [Q.redemptionExists, () => [{ '?column?': 1 }]],
          ...catalogStubs,
          [Q.equipAvatarColor, slots({ equipped_avatar_color: 'avatar.color.laut' })],
        ]),
      });

    const first = rewardEquip(build().ctx, { kind: 'avatar_color', itemId: 'avatar.color.laut' });
    const second = rewardEquip(build().ctx, { kind: 'avatar_color', itemId: 'avatar.color.laut' });
    assert.deepEqual(first, second);
  });

  test('a profile that vanished mid-request is not found', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => [{ '?column?': 1 }]],
        ...catalogStubs,
        [Q.equipTitle, () => []],
      ]),
    });

    assert.equal(
      refusal(() => rewardEquip(fake.ctx, { kind: 'title', itemId: 'title.pemikir' })).code,
      'NOT_FOUND',
    );
  });
});

describe('rewardRedeem', () => {
  const affordable: [string, Responder][] = [
    [Q.redemptionExists, () => []],
    ...catalogStubs,
    [Q.pointsBalance, () => [{ balance: 1000 }]],
    [Q.pointsAward, () => [{ id: 'ledger-1' }]],
    [Q.redemptionInsert, () => [{ id: 'redemption-1' }]],
  ];

  test('buying debits the ledger and records the redemption', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub(affordable) });

    const result = rewardRedeem(fake.ctx, { itemId: 'title.pemikir', idempotencyKey: 'k' });

    assert.equal(result.itemId, 'title.pemikir');
    assert.equal((fake.paramsOf(Q.pointsAward) as unknown[])[2], -800, 'a debit, not a credit');
    assert.equal(fake.countOf(Q.redemptionInsert), 1);
  });

  test('buying does not put the item on', () => {
    // Deliberate: a student choosing between four colours should not have the
    // fourth forced on the moment they buy it.
    const fake = fakeCtx(Q, { userId: ME, queries: stub(affordable) });
    rewardRedeem(fake.ctx, { itemId: 'avatar.color.laut', idempotencyKey: 'k' });

    assert.equal(fake.countOf(Q.equipAvatarColor), 0);
  });

  test('an item already owned is not sold twice', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.redemptionExists, () => [{ '?column?': 1 }]]]),
    });

    assert.equal(
      refusal(() => rewardRedeem(fake.ctx, { itemId: 'title.pemikir', idempotencyKey: 'k' })).code,
      'CONFLICT',
    );
    assert.equal(fake.countOf(Q.pointsAward), 0);
  });

  test('too few points refuses before the ledger is touched', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => []],
        ...catalogStubs,
        [Q.pointsBalance, () => [{ balance: 799 }]],
      ]),
    });

    assert.equal(
      refusal(() => rewardRedeem(fake.ctx, { itemId: 'title.pemikir', idempotencyKey: 'k' })).code,
      'CONFLICT',
    );
    assert.equal(fake.countOf(Q.pointsAward), 0);
  });

  test('exactly enough points is enough', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => []],
        ...catalogStubs,
        [Q.pointsBalance, () => [{ balance: 800 }]],
        [Q.pointsAward, () => [{ id: 'ledger-1' }]],
        [Q.redemptionInsert, () => [{ id: 'r' }]],
      ]),
    });

    assert.doesNotThrow(() =>
      rewardRedeem(fake.ctx, { itemId: 'title.pemikir', idempotencyKey: 'k' }),
    );
  });

  test('an item not in the catalogue cannot be bought', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.redemptionExists, () => []], ...catalogStubs]),
    });

    assert.equal(
      refusal(() => rewardRedeem(fake.ctx, { itemId: 'title.gratis', idempotencyKey: 'k' })).code,
      'NOT_FOUND',
    );
  });

  test('a replayed idempotency key does not debit twice', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [Q.redemptionExists, () => []],
        ...catalogStubs,
        [Q.pointsBalance, () => [{ balance: 1000 }]],
        // The unique constraint on the key swallowed the insert.
        [Q.pointsAward, () => []],
      ]),
    });

    assert.equal(
      refusal(() => rewardRedeem(fake.ctx, { itemId: 'title.pemikir', idempotencyKey: 'k' })).code,
      'CONFLICT',
    );
    assert.equal(fake.countOf(Q.redemptionInsert), 0, 'and no redemption row is left behind');
  });
});

describe('wornBy', () => {
  test('an empty list asks the database nothing', () => {
    const fake = fakeCtx(Q, { userId: ME, queries: stub([]) });
    assert.deepEqual(wornBy(fake.ctx, []), {});
    assert.equal(fake.calls.length, 0);
  });

  test('rows come back keyed by user id', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([
        [
          Q.equippedForUsers,
          () => [
            { user_id: ME, equipped_avatar_color: 'avatar.color.laut', equipped_title: null },
            { user_id: CLASSMATE, equipped_avatar_color: null, equipped_title: 'title.pemikir' },
          ],
        ],
      ]),
    });

    const worn = wornBy(fake.ctx, [ME, CLASSMATE]);

    assert.equal(worn[ME]?.avatarColor, 'avatar.color.laut');
    assert.equal(worn[ME]?.title, null);
    assert.equal(worn[CLASSMATE]?.title, 'title.pemikir');
  });

  test('a student with no row is simply absent', () => {
    const fake = fakeCtx(Q, {
      userId: ME,
      queries: stub([[Q.equippedForUsers, () => []]]),
    });

    assert.equal(wornBy(fake.ctx, [ME])[ME], undefined);
  });

  test('board skins are not sent to other people', () => {
    // A skin is what you see on your own board. Shipping everybody else's would
    // be payload no screen reads.
    assert.equal(
      /equipped_board_skin/.test(Q.equippedForUsers),
      false,
      'equippedForUsers must not select the board skin',
    );
  });
});
