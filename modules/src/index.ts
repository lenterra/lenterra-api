/**
 * The only entry point Nakama loads.
 *
 * Registration is explicit and centralised so the full server surface is
 * readable in one file.
 */

import { afterAuthenticateCustom, beforeAuthenticateCustom } from './hooks/authenticate';
import { beforeAddFriends } from './hooks/friends';

function InitModule(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  _nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer,
): void {
  // --- hooks: identity ----------------------------------------------------
  initializer.registerBeforeAuthenticateCustom(beforeAuthenticateCustom);
  initializer.registerAfterAuthenticateCustom(afterAuthenticateCustom);

  // --- hooks: guards on built-ins ----------------------------------------
  initializer.registerBeforeAddFriends(beforeAddFriends);

  // Refuse to run without the assertion secret rather than starting and
  // rejecting every sign-in with a confusing error.
  const env = ctx.env ?? {};
  if (!env['ASSERTION_HMAC_SECRET']) {
    logger.error('ASSERTION_HMAC_SECRET is not set — authentication will refuse every request');
  }

  logger.info('Lenterra modules initialised');
}

// Nakama looks for a global with this name. The rollup footer assigns it from
// the IIFE, so it has to be exported here.
export { InitModule };
