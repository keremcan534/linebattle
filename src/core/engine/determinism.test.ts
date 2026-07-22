import { describe, expect, it } from 'vitest';
import type { Command } from '@core/commands/commands';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { divisionId } from '@core/world/ids';
import { hashWorld, hashWorldHex } from '@core/world/worldHash';
import type { World } from '@core/world/world';

/**
 * The determinism contract.
 *
 * These tests are the reason `Rng` exists and the reason `Math.random` is
 * banned in `core/`. If any of them fails, replays, saves and multiplayer are
 * all broken — regardless of whether the game still looks fine on screen.
 */

/** A fixed script of orders, replayed identically by every run. */
function scriptedRun(seed: string, ticks = 400): World {
  const world = createTestWorld({ seed });
  addTestDivision(world, 'a', 100, 100, { speedKmh: 3 });
  addTestDivision(world, 'b', 900, 100, { speedKmh: 2.4, branch: 'armoured' });
  addTestDivision(world, 'c', 150, 700, { speedKmh: 1.4, supply: 0.6 });

  const engine = new GameEngine(world);

  const script: [number, Command][] = [
    [0, { type: 'move', divisions: [divisionId('a')], destination: { x: 800, y: 800 }, append: false }],
    [0, { type: 'move', divisions: [divisionId('b')], destination: { x: 200, y: 900 }, append: false }],
    [12, { type: 'move', divisions: [divisionId('c')], destination: { x: 950, y: 50 }, append: false }],
    [80, { type: 'move', divisions: [divisionId('a')], destination: { x: 50, y: 950 }, append: true }],
    [150, { type: 'stop', divisions: [divisionId('b')] }],
    [200, { type: 'setStance', divisions: [divisionId('c')], stance: 'entrench' }],
    [260, { type: 'move', divisions: [divisionId('c')], destination: { x: 500, y: 200 }, append: false }],
  ];

  for (let tick = 0; tick < ticks; tick++) {
    for (const [at, cmd] of script) if (at === tick) engine.issue(cmd);
    engine.step();
  }
  return world;
}

describe('simulation determinism', () => {
  it('produces an identical world from an identical command stream', () => {
    const a = hashWorld(scriptedRun('barbarossa'));
    const b = hashWorld(scriptedRun('barbarossa'));
    expect(b).toBe(a);
  });

  it('stays identical across many repeats, not just twice', () => {
    const reference = hashWorldHex(scriptedRun('barbarossa'));
    for (let i = 0; i < 5; i++) {
      expect(hashWorldHex(scriptedRun('barbarossa'))).toBe(reference);
    }
  });

  it('reaches the same state whether stepped in one batch or many', () => {
    // Guards the frame-rate independence claim: a player on 30fps and one on
    // 144fps run different numbers of ticks per frame and must still agree.
    const world = createTestWorld({ seed: 'batch' });
    addTestDivision(world, 'a', 100, 100, { speedKmh: 3 });
    const engineA = new GameEngine(world);
    engineA.issue({ type: 'move', divisions: [divisionId('a')], destination: { x: 900, y: 900 }, append: false });
    for (let i = 0; i < 300; i++) engineA.step();

    const world2 = createTestWorld({ seed: 'batch' });
    addTestDivision(world2, 'a', 100, 100, { speedKmh: 3 });
    const engineB = new GameEngine(world2);
    engineB.issue({ type: 'move', divisions: [divisionId('a')], destination: { x: 900, y: 900 }, append: false });
    for (let batch = 0; batch < 30; batch++) {
      for (let i = 0; i < 10; i++) engineB.step();
    }

    expect(hashWorld(world2)).toBe(hashWorld(world));
  });

  it('diverges when the seed differs', () => {
    // A hash that ignored the RNG would pass every test above while quietly
    // failing to protect anything. This is the control.
    const a = hashWorld(scriptedRun('seed-one'));
    const b = hashWorld(scriptedRun('seed-two'));
    expect(b).not.toBe(a);
  });

  it('detects a one-tick divergence', () => {
    // Proves the hash is actually sensitive to simulation state.
    const base = scriptedRun('sensitivity', 200);
    const extra = scriptedRun('sensitivity', 201);
    expect(hashWorld(extra)).not.toBe(hashWorld(base));
  });

  it('is insensitive to division insertion order', () => {
    // Map iteration order must never leak into the checksum, or two peers that
    // built the same world in a different order would falsely report a desync.
    const w1 = createTestWorld({ seed: 'order' });
    addTestDivision(w1, 'a', 100, 100);
    addTestDivision(w1, 'b', 200, 200);

    const w2 = createTestWorld({ seed: 'order' });
    addTestDivision(w2, 'b', 200, 200);
    addTestDivision(w2, 'a', 100, 100);

    expect(hashWorld(w2)).toBe(hashWorld(w1));
  });
});

describe('rng state is part of the world', () => {
  it('advances the world hash when the rng is consumed', () => {
    const world = createTestWorld({ seed: 'rng' });
    addTestDivision(world, 'a', 100, 100);
    const before = hashWorld(world);
    world.rng.next();
    expect(hashWorld(world)).not.toBe(before);
  });

  it('restores an identical stream from a saved state', () => {
    // This is what makes save/load possible mid-campaign.
    const world = createTestWorld({ seed: 'save' });
    for (let i = 0; i < 37; i++) world.rng.next();

    const snapshot = world.rng.getState();
    const expected = [world.rng.next(), world.rng.next(), world.rng.next()];

    world.rng.setState(snapshot);
    expect([world.rng.next(), world.rng.next(), world.rng.next()]).toEqual(expected);
  });
});
