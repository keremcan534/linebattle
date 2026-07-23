import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { factionId } from '@core/world/ids';
import { hashWorld } from '@core/world/worldHash';
import { TERRAIN_PROFILES, type Terrain } from '@core/terrain/terrainTypes';
import { NO_PROVINCE } from './province';
import { generateProvinces } from './provinceGenerator';

const RED = factionId('red');
const BLUE = factionId('blue');

describe('province generation', () => {
  it('assigns every passable cell to a province and no water cell', () => {
    const world = createTestWorld({ seed: 'gen' });
    const map = generateProvinces(world.terrain, world.alliances);

    for (let i = 0; i < world.terrain.cells.length; i++) {
      const passable = TERRAIN_PROFILES[world.terrain.cells[i] as Terrain].moveMultiplier > 0;
      const assigned = map.cellProvince[i] !== NO_PROVINCE;
      expect(assigned).toBe(passable);
    }
  });

  it('gives every province id k the index k, with valid neighbour ids', () => {
    const world = createTestWorld({ seed: 'ids' });
    const map = generateProvinces(world.terrain, world.alliances);
    map.provinces.forEach((p, k) => {
      expect(p.id).toBe(k);
      for (const nb of p.neighbours) {
        expect(nb).toBeGreaterThanOrEqual(0);
        expect(nb).toBeLessThan(map.count);
        expect(nb).not.toBe(p.id);
      }
    });
  });

  it('has symmetric adjacency', () => {
    const world = createTestWorld({ seed: 'adj' });
    const map = generateProvinces(world.terrain, world.alliances);
    for (const p of map.provinces) {
      for (const nb of p.neighbours) {
        expect(map.provinces[nb]!.neighbours).toContain(p.id);
      }
    }
  });

  it('produces chunky provinces, not one-cell slivers', () => {
    const world = createTestWorld({ seed: 'size' });
    const map = generateProvinces(world.terrain, world.alliances, { spacingKm: 45 });
    const avg = map.provinces.reduce((s, p) => s + p.cells, 0) / map.count;
    // 45 km province over a 10 km grid is ~4.5 cells across ≈ 16-20 cells.
    expect(avg).toBeGreaterThan(6);
    expect(map.count).toBeGreaterThan(4); // but still partitioned, not one blob
  });

  it('is reproducible and does not touch the world RNG', () => {
    const a = createTestWorld({ seed: 'repro' });
    const b = createTestWorld({ seed: 'repro' });
    const beforeA = a.rng.getState();

    const mapA = generateProvinces(a.terrain, a.alliances);
    const mapB = generateProvinces(b.terrain, b.alliances);

    expect(a.rng.getState()).toEqual(beforeA); // generation used a local RNG
    expect(mapA.cellProvince).toEqual(mapB.cellProvince);
    expect(mapA.count).toBe(mapB.count);
  });

  it('marks a province touching water as coastal', () => {
    const world = createTestWorld({ seed: 'coast' });
    const map = generateProvinces(world.terrain, world.alliances);
    // The test world has a central lake, so at least one province borders it.
    expect(map.provinces.some((p) => p.coastal)).toBe(true);
  });
});

describe('province ownership', () => {
  it('seeds ownership from nearby forces', () => {
    const world = createTestWorld({ seed: 'own' });
    addTestDivision(world, 'red-1', 150, 500, { faction: RED });
    addTestDivision(world, 'blue-1', 850, 500, { faction: BLUE });
    world.enableProvinces();

    const map = world.provinces!;
    expect(map.ownerAllianceAt({ x: 180, y: 500 })).toBe('a');
    expect(map.ownerAllianceAt({ x: 820, y: 500 })).toBe('b');
  });

  it('flips a province when an army seizes it', () => {
    const world = createTestWorld({ seed: 'seize' });
    const red = addTestDivision(world, 'red-1', 120, 150, { faction: RED, speedKmh: 10 });
    addTestDivision(world, 'blue-1', 880, 880, { faction: BLUE });
    world.enableProvinces();
    const map = world.provinces!;
    // Re-seed with a tight range so the ground red marches into starts NEUTRAL,
    // making the seizure a real gain rather than territory it already held.
    map.seedOwnership(
      [
        { x: 120, y: 150, alliance: 'a' },
        { x: 880, y: 880, alliance: 'b' },
      ],
      200,
    );

    const ai = map.allianceIndex('a');
    const redProvinces = () => [...map.owner].filter((o) => o === ai).length;
    const before = redProvinces();

    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [red.id], destination: { x: 700, y: 150 }, append: false });
    for (let i = 0; i < TICKS_PER_DAY * 5; i++) engine.step();

    // The march east across neutral ground must have flipped territory red, and
    // red must own the province it is standing in.
    expect(redProvinces()).toBeGreaterThan(before);
    expect(map.ownerAllianceAt(red.position)).toBe('a');
  });

  it('is part of the world hash', () => {
    const world = createTestWorld({ seed: 'hash' });
    addTestDivision(world, 'red-1', 150, 500, { faction: RED });
    world.enableProvinces();
    const before = hashWorld(world);

    world.provinces!.owner[0] = world.provinces!.owner[0] === 0 ? 1 : 0;
    expect(hashWorld(world)).not.toBe(before);
  });
});
