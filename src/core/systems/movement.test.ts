import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { divisionId } from '@core/world/ids';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { Terrain, TERRAIN_PROFILES } from '@core/terrain/terrainTypes';

describe('MovementSystem', () => {
  it('advances a division at roughly its rated speed on plains', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 100, 100, { speedKmh: 3 });
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 900, y: 100 }, append: false });

    const start = { ...d.position };
    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();

    const travelled = Math.hypot(d.position.x - start.x, d.position.y - start.y);
    expect(travelled).toBeGreaterThan(60); // 3 km/h * 24 h = 72, minus modifiers
    expect(travelled).toBeLessThanOrEqual(72.5);
  });

  it('moves more slowly through forest than across plains', () => {
    const run = (y: number) => {
      const world = createTestWorld();
      const d = addTestDivision(world, 'a', 150, y, { speedKmh: 3 });
      const engine = new GameEngine(world);
      engine.issue({ type: 'move', divisions: [d.id], destination: { x: 280, y }, append: false });
      const start = d.position.x;
      for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();
      return d.position.x - start;
    };

    const acrossForest = run(700); // forest block spans 10..30 in cells => 100..300 km
    const acrossPlains = run(200);
    expect(acrossForest).toBeLessThan(acrossPlains);
    // Forest is 0.6x; allow slack for the partial cell at the start.
    expect(acrossForest / acrossPlains).toBeLessThan(0.85);
  });

  it('never walks into water', () => {
    const world = createTestWorld();
    // Aim straight through the central lake (cells 40..60 => km 400..600).
    const d = addTestDivision(world, 'a', 300, 500, { speedKmh: 5 });
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 900, y: 500 }, append: false });

    for (let i = 0; i < TICKS_PER_DAY * 5; i++) {
      engine.step();
      expect(world.terrain.isPassableAt(d.position)).toBe(true);
    }
  });

  it('gives up instead of grinding against an uncrossable shore', () => {
    // Regression test. The order is snapped to the far side of the lake, so
    // the division walks into the near shore and can slide but never approach.
    // It used to do that forever, silently bleeding organisation.
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 300, 500, { speedKmh: 5 });
    const engine = new GameEngine(world);

    let blocked = 0;
    engine.events.on('orderBlocked', () => blocked++);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 500, y: 500 }, append: false });

    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.step();

    expect(blocked).toBe(1);
    expect(d.order).toBeNull();
    expect(d.stance).toBe('hold');
    // And it must not have burned a day of cohesion doing it.
    expect(d.organisation).toBeGreaterThan(49);
  });

  it('walks a queued waypoint list in order', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 100, 100, { speedKmh: 4 });
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 300, y: 100 }, append: false });
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 300, y: 300 }, append: true });

    engine.step();
    expect(d.order?.waypoints).toHaveLength(2);

    let reached = 0;
    engine.events.on('destinationReached', () => reached++);
    // The route is 400 km at 4 km/h = 96 km/day, so 4 days is not enough.
    for (let i = 0; i < TICKS_PER_DAY * 6; i++) engine.step();

    expect(reached).toBe(1); // fired once, at the END of the queue
    // Arrival is within ARRIVAL_TOLERANCE_KM of the waypoint, not exactly on it.
    expect(Math.hypot(d.position.x - 300, d.position.y - 300)).toBeLessThan(1.5);
    expect(d.order).toBeNull();
  });

  it('snaps an order aimed at water onto the nearest passable ground', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 100, 500);
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 500, y: 500 }, append: false });
    engine.step();

    const target = d.order!.waypoints[0]!;
    expect(world.terrain.isPassableAt(target)).toBe(true);
  });

  it('moves a low-supply division more slowly', () => {
    const world = createTestWorld();
    const full = addTestDivision(world, 'full', 100, 100, { speedKmh: 3, supply: 1 });
    const starved = addTestDivision(world, 'starved', 100, 300, { speedKmh: 3, supply: 0.1 });
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [full.id], destination: { x: 900, y: 100 }, append: false });
    engine.issue({ type: 'move', divisions: [starved.id], destination: { x: 900, y: 300 }, append: false });

    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();
    expect(starved.position.x).toBeLessThan(full.position.x);
  });

  it('keeps prevPosition one tick behind, for render interpolation', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 100, 100, { speedKmh: 3 });
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 900, y: 100 }, append: false });

    engine.step();
    engine.step();
    expect(d.prevPosition.x).toBeLessThan(d.position.x);
    expect(d.position.x - d.prevPosition.x).toBeLessThan(2); // one tick of travel
  });
});

describe('OrderSystem', () => {
  it('ignores commands for unknown divisions', () => {
    const world = createTestWorld();
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [divisionId('ghost')], destination: { x: 1, y: 1 }, append: false });
    expect(() => engine.step()).not.toThrow();
  });

  it('replaces the route when append is false', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 100, 100);
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 300, y: 100 }, append: false });
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 100, y: 300 }, append: false });
    engine.step();
    expect(d.order?.waypoints).toHaveLength(1);
  });

  it('drops the order on stop', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 100, 100);
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 300, y: 100 }, append: false });
    engine.step();
    engine.issue({ type: 'stop', divisions: [d.id] });
    engine.step();
    expect(d.order).toBeNull();
    expect(d.stance).toBe('hold');
  });
});

describe('terrain profiles', () => {
  it('makes water impassable and everything else passable', () => {
    expect(TERRAIN_PROFILES[Terrain.Water].moveMultiplier).toBe(0);
    for (const t of [Terrain.Plains, Terrain.Forest, Terrain.Marsh, Terrain.Hills, Terrain.Mountains, Terrain.Urban]) {
      expect(TERRAIN_PROFILES[t].moveMultiplier).toBeGreaterThan(0);
    }
  });
});
