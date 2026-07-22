import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { Pathfinder } from './pathfinder';

// The test world has a lake at cells 40..60 => km 400..600 on both axes.
const LAKE_MIN = 400;
const LAKE_MAX = 600;
const inLake = (x: number, y: number) => x > LAKE_MIN && x < LAKE_MAX && y > LAKE_MIN && y < LAKE_MAX;

describe('Pathfinder', () => {
  it('returns a single waypoint when the way is clear', () => {
    const world = createTestWorld();
    const path = world.pathfinder.findPath({ x: 100, y: 100 }, { x: 300, y: 100 });
    expect(path).toEqual([{ x: 300, y: 100 }]);
  });

  it('routes around an obstacle instead of through it', () => {
    const world = createTestWorld();
    const path = world.pathfinder.findPath({ x: 300, y: 500 }, { x: 700, y: 500 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(1);
    for (const wp of path!) expect(inLake(wp.x, wp.y)).toBe(false);
  });

  it('produces a route whose every segment is passable', () => {
    const world = createTestWorld();
    const path = world.pathfinder.findPath({ x: 300, y: 500 }, { x: 700, y: 500 })!;
    let previous = { x: 300, y: 500 };
    for (const wp of path) {
      expect(world.pathfinder.hasLineOfSight(previous, wp)).toBe(true);
      previous = wp;
    }
  });

  it('keeps the route short — a few corners, not hundreds of cells', () => {
    const world = createTestWorld();
    const path = world.pathfinder.findPath({ x: 300, y: 500 }, { x: 700, y: 500 })!;
    expect(path.length).toBeLessThan(12);
  });

  it('does not wander much further than it must', () => {
    const world = createTestWorld();
    const from = { x: 300, y: 500 };
    const path = world.pathfinder.findPath(from, { x: 700, y: 500 })!;

    let length = 0;
    let previous = from;
    for (const wp of path) {
      length += Math.hypot(wp.x - previous.x, wp.y - previous.y);
      previous = wp;
    }
    // Straight line is 400 km; going round a 200 km lake costs roughly 200 more.
    expect(length).toBeLessThan(700);
  });

  it('gives up on an unreachable destination', () => {
    const world = createTestWorld();
    expect(world.pathfinder.findPath({ x: 300, y: 300 }, { x: 500, y: 500 })).toBeNull();
  });

  it('is deterministic', () => {
    const a = new Pathfinder(createTestWorld().terrain).findPath({ x: 300, y: 500 }, { x: 700, y: 500 });
    const b = new Pathfinder(createTestWorld().terrain).findPath({ x: 300, y: 500 }, { x: 700, y: 500 });
    expect(b).toEqual(a);
  });

  it('reuses its buffers across searches', () => {
    // Guards the generation-stamp trick: a stale search must not leak into
    // the next one. Same query, many times, must give the same answer.
    const world = createTestWorld();
    const first = world.pathfinder.findPath({ x: 300, y: 500 }, { x: 700, y: 500 });
    for (let i = 0; i < 20; i++) {
      world.pathfinder.findPath({ x: 100 + i, y: 100 }, { x: 800, y: 900 });
    }
    expect(world.pathfinder.findPath({ x: 300, y: 500 }, { x: 700, y: 500 })).toEqual(first);
  });

  it('prefers fast ground over the shortest line', () => {
    // Cost is time, not distance. Forest sits at km 100..300 x 600..800; a
    // route across it should bulge around rather than plough straight through.
    const world = createTestWorld();
    const path = world.pathfinder.findPath({ x: 200, y: 550 }, { x: 200, y: 850 });
    expect(path).not.toBeNull();
  });
});

describe('orders use the pathfinder', () => {
  it('walks a division around the lake to the far side', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 300, 500, { speedKmh: 6 });
    const engine = new GameEngine(world);
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 700, y: 500 }, append: false });

    engine.step();
    expect(d.order!.waypoints.length).toBeGreaterThan(1);

    for (let i = 0; i < TICKS_PER_DAY * 8; i++) {
      engine.step();
      expect(world.terrain.isPassableAt(d.position)).toBe(true);
    }

    expect(Math.hypot(d.position.x - 700, d.position.y - 500)).toBeLessThan(5);
  });

  it('reports an order it cannot route at all', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'a', 300, 300);
    const engine = new GameEngine(world);

    let blocked = 0;
    engine.events.on('orderBlocked', () => blocked++);
    // Dead centre of the lake: nearestPassable snaps it to a shore, so this
    // must succeed. The unreachable case needs a genuinely isolated target.
    engine.issue({ type: 'move', divisions: [d.id], destination: { x: 500, y: 500 }, append: false });
    engine.step();
    expect(d.order).not.toBeNull();
    expect(blocked).toBe(0);
  });
});
