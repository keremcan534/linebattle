import { describe, expect, it } from 'vitest';
import { Rng, hashStringToSeed } from './random';

describe('Rng', () => {
  it('reproduces a sequence from the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 50 }, () => a.nextUint32());
    const seqB = Array.from({ length: 50 }, () => b.nextUint32());
    expect(seqB).toEqual(seqA);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 20 }, (_, i) => new Rng(i).nextUint32());
    expect(new Set(a).size).toBe(a.length);
  });

  it('accepts string seeds', () => {
    expect(Array.from({ length: 10 }, () => new Rng('barbarossa').next())).toEqual(
      Array.from({ length: 10 }, () => new Rng('barbarossa').next()),
    );
    expect(new Rng('barbarossa').next()).not.toBe(new Rng('bagration').next());
  });

  it('never returns the degenerate all-zero state', () => {
    for (const seed of [0, -1, 1, 0x7fffffff]) {
      const s = new Rng(seed).getState();
      expect(s.s0 | s.s1 | s.s2 | s.s3).not.toBe(0);
    }
  });

  it('stays within [0, 1)', () => {
    const rng = new Rng('range');
    for (let i = 0; i < 20000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('emits unsigned 32-bit integers', () => {
    const rng = new Rng('uint');
    for (let i = 0; i < 5000; i++) {
      const v = rng.nextUint32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is roughly uniform', () => {
    // Not a rigorous statistical test — just enough to catch a generator that
    // is badly broken (stuck bits, short period, biased range mapping).
    const rng = new Rng('uniformity');
    const buckets = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]!++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n * 0.01);
      expect(count).toBeLessThan(n / 10 + n * 0.01);
    }
  });

  it('keeps int() inside the requested half-open range', () => {
    const rng = new Rng('int');
    for (let i = 0; i < 10000; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(7);
    }
  });

  it('centres variance() on 1 and bounds it by the spread', () => {
    const rng = new Rng('variance');
    let sum = 0;
    const n = 50000;
    for (let i = 0; i < n; i++) {
      const v = rng.variance(0.2);
      expect(v).toBeGreaterThanOrEqual(0.8);
      expect(v).toBeLessThanOrEqual(1.2);
      sum += v;
    }
    expect(Math.abs(sum / n - 1)).toBeLessThan(0.005);
  });

  it('round-trips its state', () => {
    const rng = new Rng('state');
    for (let i = 0; i < 13; i++) rng.next();
    const saved = rng.getState();
    const expected = [rng.nextUint32(), rng.nextUint32()];
    expect([Rng.fromState(saved).nextUint32(), Rng.fromState(saved).nextUint32()][0]).toBe(expected[0]);

    const restored = Rng.fromState(saved);
    expect([restored.nextUint32(), restored.nextUint32()]).toEqual(expected);
  });

  it('survives a JSON round-trip', () => {
    const rng = new Rng('json');
    rng.next();
    const revived = Rng.fromState(JSON.parse(JSON.stringify(rng.getState())));
    expect(revived.nextUint32()).toBe(Rng.fromState(rng.getState()).nextUint32());
  });

  it('forks independent streams', () => {
    const parent = new Rng('fork');
    const a = parent.fork();
    const b = parent.fork();
    const seqA = Array.from({ length: 10 }, () => a.nextUint32());
    const seqB = Array.from({ length: 10 }, () => b.nextUint32());
    expect(seqB).not.toEqual(seqA);
  });

  it('forks reproducibly', () => {
    const one = new Rng('repeat').fork().nextUint32();
    const two = new Rng('repeat').fork().nextUint32();
    expect(two).toBe(one);
  });
});

describe('hashStringToSeed', () => {
  it('is stable and unsigned', () => {
    expect(hashStringToSeed('barbarossa')).toBe(hashStringToSeed('barbarossa'));
    expect(hashStringToSeed('barbarossa')).toBeGreaterThanOrEqual(0);
  });

  it('separates similar strings', () => {
    expect(hashStringToSeed('scenario-1')).not.toBe(hashStringToSeed('scenario-2'));
  });
});
