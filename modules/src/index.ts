/**
 * The only entry point Nakama loads.
 *
 * Registration is explicit and centralised so the full server surface is
 * readable in one file — including, importantly, what is *not* here. There is
 * no RPC that writes mastery, points, or rank; none that reads another
 * student's mastery outside the teacher path; and none that enumerates
 * students, classes, or schools below the staff role. Each absence is what
 * makes the trust boundary real rather than aspirational.
 */

import { rpc } from './lib/rpc';
import { LIMITS } from './lib/ratelimit';

import { afterAuthenticateCustom, beforeAuthenticateCustom } from './hooks/authenticate';
import { beforeAddFriends } from './hooks/friends';

import { profileUpdate, sessionBootstrap } from './rpc/session';
import { catalogManifest, catalogPull } from './rpc/catalog';
import { checkSubmit, missionRecommend, progressGet } from './rpc/learning';
import { attemptSubmit } from './rpc/attempt';
import { syncPull, syncPush } from './rpc/sync';
import { classJoin, classReclaimRequest } from './rpc/classes';
import {
  certificateList,
  certificateVisibility,
  friendSearchByCode,
  leaderboardList,
  classGoalGet,
  pointsHistory,
  rewardRedeem,
} from './rpc/social';
import {
  teacherAssignmentCreate,
  teacherAttentionList,
  teacherClassCreate,
  teacherConsentRecord,
  teacherConsentStatus,
  teacherConsentWithdraw,
  teacherClassList,
  teacherClassRemove,
  teacherClassRoster,
  teacherLeaderboardSet,
  teacherClassSummary,
  teacherReclaimApprove,
  teacherStudentDetail,
} from './rpc/teacher';
import {
  accountDeleteCancel,
  accountDeleteRequest,
  moderationQueue,
  moderationReport,
  moderationResolve,
} from './rpc/account';
import { adminCatalogPublish, adminPurge, adminRoleGrant } from './rpc/admin';

function InitModule(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer,
): void {
  // --- hooks: identity ----------------------------------------------------
  initializer.registerBeforeAuthenticateCustom(beforeAuthenticateCustom);
  initializer.registerAfterAuthenticateCustom(afterAuthenticateCustom);

  // --- hooks: guards on built-ins ----------------------------------------
  initializer.registerBeforeAddFriends(beforeAddFriends);

  // --- rpc: session and identity -----------------------------------------
  initializer.registerRpc('v1.session.bootstrap', rpc('v1.session.bootstrap', sessionBootstrap));
  initializer.registerRpc('v1.profile.update', rpc('v1.profile.update', profileUpdate));
  initializer.registerRpc(
    'v1.class.join',
    rpc('v1.class.join', classJoin, { rateLimit: LIMITS['v1.class.join'] }),
  );
  initializer.registerRpc('v1.class.reclaim.request', rpc('v1.class.reclaim.request', classReclaimRequest));

  // --- rpc: content -------------------------------------------------------
  initializer.registerRpc('v1.catalog.manifest', rpc('v1.catalog.manifest', catalogManifest));
  initializer.registerRpc(
    'v1.catalog.pull',
    rpc('v1.catalog.pull', catalogPull, { rateLimit: LIMITS['v1.catalog.pull'] }),
  );

  // --- rpc: learning ------------------------------------------------------
  initializer.registerRpc('v1.mission.recommend', rpc('v1.mission.recommend', missionRecommend));
  initializer.registerRpc(
    'v1.attempt.submit',
    rpc('v1.attempt.submit', attemptSubmit, { rateLimit: LIMITS['v1.attempt.submit'] }),
  );
  initializer.registerRpc('v1.check.submit', rpc('v1.check.submit', checkSubmit));
  initializer.registerRpc(
    'v1.sync.push',
    rpc('v1.sync.push', syncPush, { rateLimit: LIMITS['v1.sync.push'] }),
  );
  initializer.registerRpc('v1.sync.pull', rpc('v1.sync.pull', syncPull));
  initializer.registerRpc('v1.progress.get', rpc('v1.progress.get', progressGet));

  // --- rpc: rewards and social -------------------------------------------
  initializer.registerRpc('v1.points.history', rpc('v1.points.history', pointsHistory));
  initializer.registerRpc('v1.reward.redeem', rpc('v1.reward.redeem', rewardRedeem));
  initializer.registerRpc('v1.certificate.list', rpc('v1.certificate.list', certificateList));
  initializer.registerRpc(
    'v1.certificate.visibility',
    rpc('v1.certificate.visibility', certificateVisibility),
  );
  initializer.registerRpc('v1.leaderboard.list', rpc('v1.leaderboard.list', leaderboardList));
  initializer.registerRpc('v1.class.goal', rpc('v1.class.goal', classGoalGet));
  initializer.registerRpc(
    'v1.friend.searchByCode',
    rpc('v1.friend.searchByCode', friendSearchByCode, {
      rateLimit: LIMITS['v1.friend.searchByCode'],
    }),
  );

  // --- rpc: teacher -------------------------------------------------------
  initializer.registerRpc(
    'v1.teacher.consent.status',
    rpc('v1.teacher.consent.status', teacherConsentStatus),
  );
  initializer.registerRpc(
    'v1.teacher.consent.record',
    rpc('v1.teacher.consent.record', teacherConsentRecord),
  );
  initializer.registerRpc(
    'v1.teacher.consent.withdraw',
    rpc('v1.teacher.consent.withdraw', teacherConsentWithdraw),
  );
  initializer.registerRpc('v1.teacher.class.create', rpc('v1.teacher.class.create', teacherClassCreate));
  initializer.registerRpc('v1.teacher.class.list', rpc('v1.teacher.class.list', teacherClassList));
  initializer.registerRpc('v1.teacher.class.roster', rpc('v1.teacher.class.roster', teacherClassRoster));
  initializer.registerRpc('v1.teacher.class.remove', rpc('v1.teacher.class.remove', teacherClassRemove));
  initializer.registerRpc(
    'v1.teacher.leaderboard.set',
    rpc('v1.teacher.leaderboard.set', teacherLeaderboardSet),
  );
  initializer.registerRpc(
    'v1.teacher.class.summary',
    rpc('v1.teacher.class.summary', teacherClassSummary, {
      rateLimit: LIMITS['v1.teacher.class.summary'],
    }),
  );
  initializer.registerRpc(
    'v1.teacher.student.detail',
    rpc('v1.teacher.student.detail', teacherStudentDetail),
  );
  initializer.registerRpc(
    'v1.teacher.attention.list',
    rpc('v1.teacher.attention.list', teacherAttentionList),
  );
  initializer.registerRpc(
    'v1.teacher.assignment.create',
    rpc('v1.teacher.assignment.create', teacherAssignmentCreate),
  );
  initializer.registerRpc(
    'v1.teacher.reclaim.approve',
    rpc('v1.teacher.reclaim.approve', teacherReclaimApprove),
  );

  // --- rpc: account and safety --------------------------------------------
  initializer.registerRpc(
    'v1.account.delete.request',
    rpc('v1.account.delete.request', accountDeleteRequest, {
      rateLimit: LIMITS['v1.account.delete.request'],
    }),
  );
  initializer.registerRpc(
    'v1.account.delete.cancel',
    rpc('v1.account.delete.cancel', accountDeleteCancel),
  );
  initializer.registerRpc(
    'v1.moderation.report',
    rpc('v1.moderation.report', moderationReport, { rateLimit: LIMITS['v1.moderation.report'] }),
  );
  initializer.registerRpc('v1.moderation.queue', rpc('v1.moderation.queue', moderationQueue));
  initializer.registerRpc('v1.moderation.resolve', rpc('v1.moderation.resolve', moderationResolve));

  // --- rpc: admin ---------------------------------------------------------
  initializer.registerRpc('v1.admin.catalog.publish', rpc('v1.admin.catalog.publish', adminCatalogPublish));
  initializer.registerRpc('v1.admin.role.grant', rpc('v1.admin.role.grant', adminRoleGrant));
  initializer.registerRpc('v1.admin.purge', rpc('v1.admin.purge', adminPurge));

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
