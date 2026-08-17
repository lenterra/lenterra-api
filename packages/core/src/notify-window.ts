/**
 * When the product is allowed to interrupt a student (PRD-APP-060).
 *
 * Two limits, pure so they can be asserted at their boundaries:
 *
 *  - **Three notifications per day.** A product that pings a child every time
 *    anything happens teaches them to dismiss it, and the one that mattered
 *    goes with the rest.
 *  - **Quiet from 21:00 to 06:00.** Nothing this product has to say is worth
 *    lighting up a phone at eleven at night.
 *
 * The window wraps midnight, which is where this kind of arithmetic usually
 * goes wrong: `hour >= 21 && hour < 6` is never true.
 */

export const DAILY_CAP = 3;
export const QUIET_FROM_HOUR = 21;
export const QUIET_TO_HOUR = 6;

/**
 * WIB (+7).
 *
 * Most of the pilot region is WITA (+8). The hour of difference does not move
 * the window enough to matter, and guessing low errs toward quieter — a
 * notification suppressed is recoverable, one delivered at 22:00 is not.
 */
export const DEFAULT_UTC_OFFSET_HOURS = 7;

export function isQuietHour(epochMs: number, offsetHours = DEFAULT_UTC_OFFSET_HOURS): boolean {
  const localHour = new Date(epochMs + offsetHours * 3_600_000).getUTCHours();
  // An OR, not a range: the window crosses midnight.
  return localHour >= QUIET_FROM_HOUR || localHour < QUIET_TO_HOUR;
}

export function underDailyCap(sentInLast24h: number): boolean {
  return sentInLast24h < DAILY_CAP;
}
