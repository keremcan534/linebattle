import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import type { FrontlineSegmentId } from '@core/world/frontline';
import { factionId } from '@core/world/ids';
import { FrontlineSystem } from './frontlineSystem';

const RED = factionId('red');
const BLUE = factionId('blue');

function controlledFront() {
  const world = createTestWorld({ seed: 'frontline' });
  for (let i = 0; i < 4; i++) {
    addTestDivision(world, `red-${i}`, 220, 140 + i * 220, { faction: RED });
    addTestDivision(world, `blue-${i}`, 780, 140 + i * 220, { faction: BLUE });
  }
  world.enableSupply(
    [
      {
        name: 'red-depot',
        alliance: 'a',
        position: { x: 100, y: 500 },
        rangeKm: 600,
        capturable: false,
      },
      {
        name: 'blue-depot',
        alliance: 'b',
        position: { x: 900, y: 500 },
        rangeKm: 600,
        capturable: false,
      },
    ],
    'temperate',
  );
  return world;
}

describe('FrontlineSystem', () => {
  it('makes the liquid boundary primary and assigns every division to it', () => {
    const world = controlledFront();
    const engine = new GameEngine(world);
    engine.step();

    expect(world.frontlineSegments.size).toBeGreaterThan(2);
    for (const d of world.divisions.values()) {
      expect(d.frontlineSegment).not.toBeNull();
      const segment = world.frontlineSegments.get(d.frontlineSegment!);
      const alliance = world.getFaction(d.faction)!.alliance;
      expect(segment?.alliances).toContain(alliance);
    }

    const redAssignments = new Set(
      [...world.divisions.values()]
        .filter((d) => d.faction === RED)
        .map((d) => d.frontlineSegment),
    );
    const blueAssignments = new Set(
      [...world.divisions.values()]
        .filter((d) => d.faction === BLUE)
        .map((d) => d.frontlineSegment),
    );
    expect(redAssignments.size).toBe(4);
    expect(blueAssignments.size).toBe(4);
  });

  it('bridges a narrow neutral seam into an assignable operational front', () => {
    const world = controlledFront();
    const field = world.supply!;
    field.control.fill(0);
    const middle = Math.floor(field.width / 2);
    for (let y = 0; y < field.height; y++) {
      for (let x = 0; x < field.width; x++) {
        const i = y * field.width + x;
        if (field.throughput[i]! <= 0) continue;
        if (x < middle - 3) field.control[i] = 1;
        if (x > middle + 3) field.control[i] = 2;
      }
    }

    new GameEngine(world);

    expect(world.frontlineSegments.size).toBeGreaterThan(0);
    for (const d of world.divisions.values()) expect(d.frontlineSegment).not.toBeNull();
    // Frontline extraction must not claim the neutral political cells.
    expect([...field.control].some((owner) => owner === 0)).toBe(true);
  });

  it('does not reassign a valid sector merely because a division moved', () => {
    const world = controlledFront();
    const engine = new GameEngine(world);
    engine.step();

    const division = world.getDivision([...world.divisions.keys()].sort()[0]!)!;
    const assigned = division.frontlineSegment;
    division.position = { x: 50, y: 50 };

    // The next half-day rebuilds geometry, but the daily operational
    // reassignment is still ahead. Drift cannot silently change responsibility.
    engine.step();
    expect(division.frontlineSegment).toBe(assigned);
  });

  it('does not erase the main front around a temporarily encircled router', () => {
    const world = controlledFront();
    const engine = new GameEngine(world);
    engine.step();
    const before = world.frontlineSegments.size;
    const segment = [...world.frontlineSegments.values()][0]!;
    const router = [...world.divisions.values()].find(
      (d) => world.getFaction(d.faction)?.alliance === segment.alliances[0],
    )!;
    router.position = { ...segment.position };
    router.encircled = true;
    router.stance = 'retreat';

    // A sound same-alliance formation makes this the main line, not the
    // circumference of an isolated rear pocket.
    addTestDivision(
      world,
      'mainline-support',
      segment.position.x + 20,
      segment.position.y,
      { faction: router.faction },
    );
    new FrontlineSystem().update({
      world,
      events: engine.events,
      dtSeconds: 12 * 3600,
      tick: 0,
    });

    expect(world.frontlineSegments.size).toBeGreaterThanOrEqual(before - 1);
  });

  it('rejects a player move that would treat an assigned division as a free agent', () => {
    const world = controlledFront();
    const engine = new GameEngine(world);
    engine.step();

    const division = world.getDivision([...world.divisions.keys()].sort()[0]!)!;
    let sectorLocked = 0;
    engine.events.on('orderBlocked', (event) => {
      if (event.reason === 'sector-locked') sectorLocked++;
    });

    engine.issue({
      type: 'move',
      divisions: [division.id],
      destination: { x: 900, y: 900 },
      append: false,
      issuer: 'player',
    });
    engine.step();

    expect(sectorLocked).toBe(1);
    expect(division.order).toBeNull();
    expect(division.frontlineSegment).not.toBeNull();
  });

  it('orders an assigned division toward its sector, not toward a nearby lure', () => {
    const world = createTestWorld({ seed: 'sector-not-lure' });
    const division = addTestDivision(world, 'line', 100, 100, { faction: RED });
    addTestDivision(world, 'lure', 100, 150, { faction: BLUE });

    const id = 'a:b:5:1' as FrontlineSegmentId;
    world.frontlineSegments.set(id, {
      id,
      alliances: ['a', 'b'],
      position: { x: 300, y: 100 },
      normal: { x: 1, y: 0 },
      lengthKm: 60,
      updatedTick: 0,
    });
    division.frontlineSegment = id;

    const engine = new GameEngine(world, { aiAlliances: ['a'] });
    engine.step();

    const destination = division.order?.waypoints.at(-1);
    expect(destination).toBeDefined();
    expect(destination!.x).toBeGreaterThan(250);
    expect(destination!.y).toBeCloseTo(100, 4);
    expect(Math.hypot(destination!.x - 100, destination!.y - 150)).toBeGreaterThan(150);
  });
});
