/**
 * In-app notifications (PRD-APP-060).
 *
 * Nakama's own notification system, delivered in-app. Push is deliberately out
 * of scope for R1: it needs store presence and a consent conversation about
 * minors that the pilot does not need to have (OQ-05).
 *
 * Two limits are enforced here rather than left to call sites, because a call
 * site that forgets produces exactly the behaviour the limits exist to prevent:
 *
 *  - **Three per day.** A product that notifies a child every time anything
 *    happens teaches them to dismiss it, and the one notification that
 *    mattered goes with the rest.
 *  - **Quiet hours, 21:00–06:00.** Nothing this product has to say is worth
 *    lighting up a phone at eleven at night. Notifications inside the window
 *    are dropped rather than queued: a streak reminder delivered at 06:00 for
 *    a streak that lapsed at midnight is a message about something the student
 *    can no longer act on.
 *
 * The window is computed in the student's own timezone offset when we have one
 * and WIB otherwise, because "21:00" means a local evening, not a UTC instant.
 */

import { DAILY_CAP, isQuietHour, underDailyCap } from '@lenterra/core';

import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';

/** Nakama reserves codes below 100 for its own use. */
export const NOTIFICATION_CODE = {
  achievement: 101,
  streakKept: 102,
  streakAtRisk: 103,
  certificate: 104,
  assignment: 105,
} as const;

export { DAILY_CAP };

export interface Notification {
  code: number;
  /** A translation key. Notifications are localised on the device. */
  subjectKey: string;
  params?: Record<string, string | number>;
}

/**
 * Send, subject to the cap and the quiet window.
 *
 * Returns whether it was delivered, so a caller that cares can tell the
 * difference between "sent" and "suppressed" — but no caller is required to.
 */
export function notify(c: Ctx, userId: string, notification: Notification): boolean {
  if (isQuietHour(c.now)) return false;

  const rows = c.nk.sqlQuery(Q.notificationCountToday, [userId]);
  const today = rows.length > 0 ? Number((rows[0] as { n: number }).n) : 0;
  if (!underDailyCap(today)) return false;

  try {
    c.nk.notificationSend(
      userId,
      // The subject is a key, not a sentence: the device knows the student's
      // language and the server does not need to.
      notification.subjectKey,
      { params: notification.params ?? {} },
      notification.code,
      undefined,
      // Persistent, so a student who was offline still sees it.
      true,
    );
  } catch (err) {
    // A notification is never worth failing the operation that produced it.
    c.logger.warn('notification failed: %s', String(err));
    return false;
  }

  c.nk.sqlExec(Q.notificationRecord, [c.nk.uuidv4(), userId, notification.code]);
  return true;
}
