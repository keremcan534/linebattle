import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { divisionId, factionId } from '@core/world/ids';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { Terrain, TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import { effectiveSpeedKmh } from '@core/world/division';
import {
  ENEMY_MIN_SEPARATION_KM,
  FORMED_ENEMY_MIN_SEPARATION_KM,
  MovementSystem,
} from './movementSystem';

describe('MovementSystem', () => {
  it('does not turn organisation or strength loss into a movement-speed penalty', () => {
    const world = createTestWorld();
    const fresh = addTestDivision(world, 'fresh', 100, 100, {
      speedKmh: 3,
      organisation: 50,
      manpower: 10_000,
    });
    const battered = addTestDivision(world, 'battered', 100, 200, {
      speedKmh: 3,
      organisation: 3,
      manpower: 2_000,
    });
    fresh.stance = 'move';
    battered.stance = 'move';

    expect(effectiveSpeedKmh(battered)).toBe(effectiveSpeedKmh(fresh));
  });

  it('moves a retreating formation faster than an ordinary advance', () => {
    const world = createTestWorld();
    const advancing = addTestDivision(world, 'advancing', 100, 100, {
      speedKmh: 3,
      supply: 1,
    });
    const retreating = addTestDivision(world, 'retreating', 100, 200, {
      speedKmh: 3,
      supply: 0,
      organisation: 1,
    });
    advancing.stance = 'advance';
    retreating.stance = 'retreat';

    expect(effectiveSpeedKmh(retreating)).toBeGreaterThan(
      effectiveSpeedKmh(advancing),
    );
  });

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

  it('gives up on an order it can never fulfil', () => {
    // Regression test for the shore livelock: coast-sliding "succeeds" every
    // tick, so nothing used to report the order impossible and the division
    // ground against the water forever, bleeding organisation.
    //
    // Since Milestone 2 the pathfinder routes such orders around the obstacle,
    // so this sets the waypoint DIRECTLY rather than going through
    // OrderSystem — the stall guard is the safety net for orders no path can
    // satisfy, and it still has to work.
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 300, 500, { speedKmh: 5 });
    const engine = new GameEngine(world);

    let blocked = 0;
    engine.events.on('orderBlocked', () => blocked++);
    d.order = {
      kind: 'move',
      waypoints: [{ x: 700, y: 500 }], // straight through the lake
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    d.stance = 'move';

    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.step();

    expect(blocked).toBe(1);
    expect(d.order).toBeNull();
    expect(d.stance).toBe('hold');
    // And it must not have burned a day of cohesion doing it.
    expect(d.organisation).toBeGreaterThan(49);
  });

  it('now routes around the lake rather than stalling at it', () => {
    // The same order, issued properly: the pathfinder makes it achievable.
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 300, 500, { speedKmh: 6 });
    const engine = new GameEngine(world);

    let blocked = 0;
    engine.events.on('orderBlocked', () => blocked++);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 700, y: 500 }, append: false });
    for (let i = 0; i < TICKS_PER_DAY * 8; i++) engine.step();

    expect(blocked).toBe(0);
    expect(Math.hypot(d.position.x - 700, d.position.y - 500)).toBeLessThan(5);
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
    expect(d.position.x - d.prevPosition.x).toBeLessThan(36.1); // one twelve-hour tick
  });

  it('treats every enemy as a solid circle and never crosses its centre', () => {
    // Use a coarse grid and a very fast mover so one tick could otherwise
    // tunnel completely through the defender.
    const world = createTestWorld({ cellSize: 100 });
    const attacker = addTestDivision(world, 'attacker', 100, 100, {
      faction: factionId('red'),
      speedKmh: 200,
    });
    const defender = addTestDivision(world, 'defender', 125, 100, {
      faction: factionId('blue'),
    });
    attacker.order = {
      kind: 'move',
      waypoints: [{ x: 200, y: 100 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    attacker.stance = 'move';

    const engine = new GameEngine(world, { systems: [new MovementSystem()] });
    for (let i = 0; i < 20; i++) {
      engine.step();
      const separation = Math.hypot(
        defender.position.x - attacker.position.x,
        defender.position.y - attacker.position.y,
      );
      expect(separation).toBeGreaterThanOrEqual(FORMED_ENEMY_MIN_SEPARATION_KM);
      expect(attacker.position.x).toBeLessThan(defender.position.x);
    }

    // Enemy geometry blocks movement, but does not silently cancel the intent
    // before combat gets a chance to resolve it.
    expect(attacker.order).not.toBeNull();
  });

  it('lets mobile formations exploit a real gap between hostile zones of control', () => {
    const world = createTestWorld({ cellSize: 100 });
    const attacker = addTestDivision(world, 'attacker', 100, 100, {
      faction: factionId('red'),
      branch: 'armoured',
      speedKmh: 200,
    });
    addTestDivision(world, 'north', 150, 80, { faction: factionId('blue') });
    addTestDivision(world, 'south', 150, 120, { faction: factionId('blue') });
    attacker.order = {
      kind: 'move',
      waypoints: [{ x: 200, y: 100 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    attacker.stance = 'move';

    new GameEngine(world, { systems: [new MovementSystem()] }).step();

    expect(attacker.position.x).toBeGreaterThan(150);
  });

  it('keeps a shattered enemy solid after its wider zone of control collapses', () => {
    const world = createTestWorld({ cellSize: 100 });
    const attacker = addTestDivision(world, 'attacker', 100, 100, {
      faction: factionId('red'),
      speedKmh: 200,
    });
    const shattered = addTestDivision(world, 'shattered', 150, 100, {
      faction: factionId('blue'),
      organisation: 5,
    });
    attacker.order = {
      kind: 'move',
      waypoints: [{ x: 200, y: 100 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    attacker.stance = 'move';

    new GameEngine(world, { systems: [new MovementSystem()] }).step();

    const separation = Math.hypot(
      shattered.position.x - attacker.position.x,
      shattered.position.y - attacker.position.y,
    );
    expect(separation).toBeGreaterThanOrEqual(ENEMY_MIN_SEPARATION_KM);
    expect(separation).toBeLessThan(FORMED_ENEMY_MIN_SEPARATION_KM);
    expect(attacker.position.x).toBeLessThan(shattered.position.x);
  });
});

describe('OrderSystem', () => {
  it('translates a group while preserving its formation', () => {
    const world = createTestWorld();
    const north = addTestDivision(world, 'north', 100, 100);
    const south = addTestDivision(world, 'south', 100, 200);
    const engine = new GameEngine(world);

    engine.issue({
      type: 'move',
      divisions: [north.id, south.id],
      destination: { x: 300, y: 150 },
      append: false,
    });
    engine.step();

    expect(north.order?.waypoints.at(-1)).toEqual({ x: 300, y: 100 });
    expect(south.order?.waypoints.at(-1)).toEqual({ x: 300, y: 200 });
  });

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
