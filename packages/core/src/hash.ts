/**
 * Deterministic hashing, implemented from scratch.
 *
 * The rules core has no runtime dependencies (TRD-ENG-001) and must run
 * unchanged in Hermes on a phone and in goja on the server — where there is no
 * `crypto`, no `Buffer`, and no Node built-ins at all (20-02). So SHA-256 is
 * written out here in plain ES5-compatible arithmetic.
 *
 * Two properties matter and neither is negotiable:
 *
 *  - **Same input, same digest, on every platform.** A client and server that
 *    disagree about a state hash reject honest attempts (20-07 "Version skew").
 *  - **Canonical serialisation.** JSON.stringify does not guarantee key order
 *    across engines, so `canonicalJson` sorts keys before hashing. Without it,
 *    two identical states could hash differently purely because of insertion
 *    order.
 *
 * `finalStateHash` is a consistency check, not the security boundary — the
 * server re-executes every move regardless (TRD-ENG-004). The tamper case it
 * catches is the fourth one in 20-07's list: moves edited *and* the hash
 * recomputed still fails, because the recomputed hash will not match what
 * re-execution produces.
 */

const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** UTF-8 encode without TextEncoder, which goja does not reliably provide. */
export function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);

    // Combine surrogate pairs into a single code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      }
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** SHA-256 over a byte array, returned as lowercase hex. */
export function sha256Bytes(bytes: number[]): string {
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const bitLength = bytes.length * 8;
  const padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);

  // 64-bit big-endian length. Inputs never approach 2^32 bits, so the high
  // word is always zero — written out rather than assumed.
  const hi = Math.floor(bitLength / 0x100000000);
  padded.push(
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff,
  );

  const w = new Array<number>(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        (((padded[offset + i * 4] as number) << 24) |
          ((padded[offset + i * 4 + 1] as number) << 16) |
          ((padded[offset + i * 4 + 2] as number) << 8) |
          (padded[offset + i * 4 + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0;
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0;
      w[i] = (((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0);
    }

    let [a, b, c, d, e, f, g, hh] = h as [
      number, number, number, number, number, number, number, number,
    ];

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) {
    const word = h[i] as number;
    for (let shift = 28; shift >= 0; shift -= 4) {
      hex += ((word >>> shift) & 0xf).toString(16);
    }
  }
  return hex;
}

/** SHA-256 of a string, lowercase hex. */
export function sha256(input: string): string {
  return sha256Bytes(utf8Bytes(input));
}

/**
 * JSON with deterministic key ordering.
 *
 * Object key order is insertion order in every engine we target, but the
 * *insertion* order differs between a state built by the client and the same
 * state rebuilt by server re-execution. Sorting removes that as a source of
 * false rejections.
 *
 * Numbers are emitted via `JSON.stringify`'s own conversion, which is
 * specified exactly (ECMA-262 Number::toString) and therefore identical across
 * engines. Non-finite numbers are rejected rather than silently becoming null,
 * because a NaN in a game state is a bug that should surface loudly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'number') {
    const n = value as number;
    if (!isFinite(n)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(n);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function') return 'null';

  if (Object.prototype.toString.call(value) === '[object Array]') {
    const arr = value as unknown[];
    const parts: string[] = [];
    for (let i = 0; i < arr.length; i++) parts.push(canonicalJson(arr[i]));
    return '[' + parts.join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) keys.push(key);
  }
  keys.sort();

  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    parts.push(JSON.stringify(key) + ':' + canonicalJson(obj[key]));
  }
  return '{' + parts.join(',') + '}';
}

/** Canonical hash of any JSON-serialisable value. */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Constant-time string comparison.
 *
 * Used wherever a hash or MAC is compared. Length is compared without an early
 * return so the timing does not leak it either.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}
