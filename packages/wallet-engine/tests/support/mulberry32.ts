/* oxlint-disable eslint/no-bitwise, unicorn/prefer-math-trunc, eslint/operator-assignment --
 * mulberry32 is integer arithmetic; | 0 is the load-bearing int32 wrap. */

/** Deterministic PRNG for fuzz input generation. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
