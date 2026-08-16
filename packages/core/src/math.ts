/**
 * Small numeric helpers used across the adaptive engine and rules.
 *
 * Everything here is pure and platform-independent (TRD-ENG-001). No
 * `Date.now()`, no `Math.random()`, no locale-sensitive formatting.
 */

/** Clamp to the closed unit interval. NaN collapses to 0 rather than propagating. */
export function clamp01(value: number): number {
  if (!(value === value)) return 0; // NaN
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  if (!(value === value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Round to a fixed number of decimal places.
 *
 * Used only at storage and comparison boundaries. Mastery is compared to 1e-9
 * (TRD-ADPT-001), so intermediate values are never rounded — rounding mid-chain
 * is how a reproducible engine stops reproducing.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** Sum, order-independent to the limits of floating point. */
export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i] as number;
  return total;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Deterministic 32-bit PRNG (mulberry32).
 *
 * The rules core must never call `Math.random()` — an AI move that is not a
 * pure function of (state, tier, seed) cannot be re-executed server-side, and
 * replay validation is the whole basis of trusting offline play (20-07).
 * Mission definitions carry their seed, so a mission plays identically for
 * every student and for the validator.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, bound). Deterministic given the rng. */
export function rngInt(rng: () => number, bound: number): number {
  return Math.floor(rng() * bound) % Math.max(1, bound);
}
