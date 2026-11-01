/**
 * Deterministic, serialisable pseudo random number generator (sfc32).
 *
 * Every stochastic component (market, agent, failures) owns its own stream
 * derived from the run seed, so adding randomness in one component does not
 * change the draws in another. The full state can be persisted and restored,
 * which is what makes restarts and replays reproducible.
 */

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

function hashString(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class SeededRandom {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number | RngState) {
    if (typeof seed === "object") {
      this.a = seed.a >>> 0;
      this.b = seed.b >>> 0;
      this.c = seed.c >>> 0;
      this.d = seed.d >>> 0;
      return;
    }
    const s = String(seed);
    this.a = hashString(s + "#a");
    this.b = hashString(s + "#b");
    this.c = hashString(s + "#c");
    this.d = hashString(s + "#d") | 1;
    for (let i = 0; i < 16; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  nextInt(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Standard normal via Box-Muller. */
  gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /** Lognormal with given median and sigma (of the underlying normal). */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.gaussian());
  }

  /** Poisson draw (Knuth for small lambda, normal approximation for large). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 60) {
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.gaussian()));
    }
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Cannot pick from empty array");
    return items[Math.floor(this.next() * items.length)];
  }

  /** Weighted pick: weights need not be normalised. */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Derive an independent stream. Deterministic for a given parent state + name. */
  fork(name: string): SeededRandom {
    const salt = Math.floor(this.next() * 4294967296);
    return new SeededRandom(`${name}:${salt}`);
  }

  getState(): RngState {
    return { a: this.a >>> 0, b: this.b >>> 0, c: this.c >>> 0, d: this.d >>> 0 };
  }

  static fromState(state: RngState): SeededRandom {
    return new SeededRandom(state);
  }
}
