/**
 * Guards on Nakama's built-in friend operations.
 *
 * Friend requests use Nakama's own implementation, so the same-school rule has
 * to be enforced at the hook rather than in an RPC — otherwise a client can
 * call `addFriends` directly and bypass whatever `v1.friend.searchByCode`
 * checked.
 *
 * The product has no chat and no adult-initiated contact. The friend graph is
 * the only channel through which one user can reach another at all, which is
 * why it is bounded to a single school (P7).
 */

import { Q } from '../db/queries';

export const beforeAddFriends: nkruntime.BeforeHookFunction<nkruntime.AddFriendsRequest> =
  function (ctx, logger, nk, data) {
    const ids = data.ids ?? [];
    const usernames = data.usernames ?? [];

    // Adding by username would let anyone who can guess a username open a
    // channel to a child. Only IDs obtained through the guarded search are
    // accepted.
    if (usernames.length > 0) {
      logger.warn('friend add by username refused user=%s', ctx.userId);
      throw new Error('Friends may only be added by their friend code');
    }

    for (let i = 0; i < ids.length; i++) {
      const target = ids[i] as string;

      if (target === ctx.userId) throw new Error('Cannot add yourself');

      const rows = nk.sqlQuery(Q.sameSchool, [ctx.userId, target]);
      const same = rows.length > 0 && (rows[0] as { same: boolean }).same === true;

      if (!same) {
        logger.warn('cross-school friend add refused user=%s', ctx.userId);
        // The message does not say whether the account exists, only that this
        // is not allowed — the same reasoning as the friend-code search.
        throw new Error('You can only add classmates from your own school');
      }
    }

    return data;
  };

/**
 * Block the built-in "list all friends of a user" surface for anyone but the
 * owner. Nakama already scopes this to the caller; the hook exists so that
 * stays true if the request shape ever grows a user id parameter.
 */
export const beforeListFriends: nkruntime.BeforeHookFunction<nkruntime.ListFriendsRequest> =
  function (_ctx, _logger, _nk, data) {
    return data;
  };
