/**
 * Seeded, serialisable pseudo-random number generator.
 *
 * WHY THIS EXISTS, AND WHY IT EXISTS *BEFORE* COMBAT DOES:
 *
 * The simulation promises determinism — same start state plus same command
 * stream must produce the same world, every time, on every machine. That
 * promise is what makes replays, saves, desync-free multiplayer and
 * reproducible bug reports possible.
 *
 * `Math.random()` breaks that promise irreversibly. Its state is global,
 * unseedable and unsaveable: once one combat roll uses it, no replay can ever
 * be reproduced, and there is no way to retrofit the fix except by rewriting
 * every system that touched it. Combat is the first system that will want
 * randomness, so the generator has to land first.
 *
 * Algorithm: xoshiro128** — 128 bits of state, passes PractRand, and is fast
 * in plain 32-bit integer ops. Crucially its whole state is four uint32s, so
 * it round-trips through JSON and belongs in a save file next to unit
 * positions.
 *
 * `Math.random` is banned inside `src/core/` by an ESLint rule so this cannot
 * silently regress.
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** SplitMix32 — expands a single seed into well-distributed state words. */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** FNV-1a, so a scenario can be seeded with a human-readable string. */
export function hashStringToSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number | string = 0) {
    const numeric = typeof seed === 'string' ? hashStringToSeed(seed) : seed;
    const mix = splitmix32(numeric);
    // Never allow the all-zero state, which xoshiro cannot escape.
    do {
      this.s0 = mix();
      this.s1 = mix();
      this.s2 = mix();
      this.s3 = mix();
    } while ((this.s0 | this.s1 | this.s2 | this.s3) === 0);
  }

  static fromState(state: RngState): Rng {
    const rng = new Rng(0);
    rng.setState(state);
    return rng;
  }

  /** Raw 32-bit output. */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);

    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max));
  }

  /** True with probability `p`. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items.length ? items[this.int(0, items.length)] : undefined;
  }

  /**
   * A multiplier centred on 1, in [1-spread, 1+spread], triangular so extreme
   * results are rare. This is the shape combat should use: variance changes
   * how fast and how costly a battle is, never who was going to win it.
   */
  variance(spread: number): number {
    return 1 + (this.next() + this.next() - 1) * spread;
  }

  getState(): RngState {
    return { s0: this.s0, s1: this.s1, s2: this.s2, s3: this.s3 };
  }

  setState(state: RngState): void {
    this.s0 = state.s0 >>> 0;
    this.s1 = state.s1 >>> 0;
    this.s2 = state.s2 >>> 0;
    this.s3 = state.s3 >>> 0;
  }

  /**
   * An independent stream derived from this one.
   *
   * Use this to give a subsystem its own generator (per-battle rolls, map
   * generation) so that adding a call site in one system cannot shift every
   * other system's sequence — the classic source of "my replay desyncs after
   * I added a log line".
   */
  fork(): Rng {
    return Rng.fromState({
      s0: this.nextUint32(),
      s1: this.nextUint32(),
      s2: this.nextUint32(),
      s3: this.nextUint32(),
    });
  }
}
