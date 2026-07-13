/**
 * Seeded pseudo-random number generation.
 *
 * The whole simulation must be reproducible: given the same seed, a run must
 * produce byte-for-byte identical results so that a demo can be replayed and so
 * that unit tests are stable. JavaScript's built-in Math.random() is not
 * seedable, so we carry our own small, fast, well-distributed PRNG.
 *
 * mulberry32 is a 32-bit generator with a period of 2^32. That is more than
 * enough for a few thousand passengers and keeps the implementation tiny and
 * auditable.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force the seed into a 32-bit unsigned integer. `>>> 0` is the standard
    // idiom for that in JS.
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Exponentially distributed sample with the given rate (events per unit time). */
  exponential(rate: number): number {
    // Inverse-CDF sampling. Guard against Math.log(0) by clamping the uniform
    // draw away from exactly 0.
    const u = 1 - this.next(); // in (0, 1]
    return -Math.log(u) / rate;
  }

  /**
   * Standard normal sample (mean 0, variance 1) via the Box–Muller transform.
   * We only need one of the two generated values; discarding the second keeps
   * the RNG stream simple and deterministic.
   */
  standardNormal(): number {
    let u1 = this.next();
    const u2 = this.next();
    // Avoid log(0).
    if (u1 < 1e-12) u1 = 1e-12;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
