/**
 * The quiet-hours window.
 *
 * Pure arithmetic, but arithmetic that wraps midnight — which is exactly the
 * kind that looks right and is off by one at the boundary. The consequence of
 * getting it wrong is a phone lighting up in a child's bedroom, so the
 * boundaries are asserted individually rather than sampled.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isQuietHour, QUIET_FROM_HOUR, QUIET_TO_HOUR } from '../dist/index.js';

/** A UTC instant that reads as `hour` local, at the given offset. */
function localHour(hour: number, offsetHours = 7): number {
  return Date.UTC(2026, 0, 15, hour - offsetHours, 30);
}

describe('isQuietHour', () => {
  test('the middle of the school day is not quiet', () => {
    for (const hour of [7, 10, 13, 16, 19]) {
      assert.equal(isQuietHour(localHour(hour)), false, `${hour}:30 should be loud`);
    }
  });

  test('night is quiet', () => {
    for (const hour of [21, 22, 23, 0, 2, 5]) {
      assert.equal(isQuietHour(localHour(hour)), true, `${hour}:30 should be quiet`);
    }
  });

  test('the window opens exactly at 21:00', () => {
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, QUIET_FROM_HOUR - 1 - 7, 59)), false);
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, QUIET_FROM_HOUR - 7, 0)), true);
  });

  test('the window closes exactly at 06:00', () => {
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, QUIET_TO_HOUR - 1 - 7 + 24, 59)), true);
    assert.equal(isQuietHour(Date.UTC(2026, 0, 15, QUIET_TO_HOUR - 7 + 24, 0)), false);
  });

  test('it wraps midnight rather than treating it as a range', () => {
    // The naive `hour >= 21 && hour < 6` is never true. This is that bug.
    assert.equal(isQuietHour(localHour(23)), true);
    assert.equal(isQuietHour(localHour(1)), true);
  });

  test('the offset moves the window, not its width', () => {
    // 22:00 WITA is 21:00 WIB: quiet at both, because the window is local.
    assert.equal(isQuietHour(localHour(22, 8), 8), true);
    assert.equal(isQuietHour(localHour(20, 8), 8), false);
  });
});
