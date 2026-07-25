import { describe, expect, it } from 'vitest';
import { GameEngine, createFrontSystems } from '@core/engine/gameEngine';
import { CommandQueue } from '@core/commands/commands';
import {
  FRONT_STANDOFF_KM,
  RANK_CAPACITY,
} from '@core/front/frontFormation';
import {
  buildFrontSectors,
  nearestSectorIndex,
  sectorPosition,
  type FrontState,
} from '@core/front/frontSector';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { factionId } from '@core/world/ids';
import type { World } from '@core/world/world';

const WEST = factionId('red'); // alliance 'a'
const EAST = factionId('blue'); // alliance 'b'
const SECTOR_COUNT = 30;
const PER_SIDE = 60;

/** A north-south front across the test world, 30 sectors, 60 v 60 divisions. */
function frontWorld(): World {
  const world = createTestWorld({ seed: 'front-model' });
  const line = [
    { x: 500, y: 40 },
    { x: 520, y: 300 },
    { x: 500, y: 600 },
    { x: 540, y: 960 },
  ];
  const front = buildFrontSectors(line, SECTOR_COUNT, { x: 1, y: 0 }, 'a', 'b');
  world.front = front;

  for (let i = 0; i < PER_SIDE; i++) {
    const sector = front.sectors[i % SECTOR_COUNT]!;
    const at = sectorPosition(sector);
    const west = addTestDivision(world, `west-${i}`, at.x - 40, at.y, {
      faction: WEST,
    });
    west.sector = sector.index;
    const east = addTestDivision(world, `east-${i}`, at.x + 40, at.y, {
      faction: EAST,
      // A weaker defender, so the line actually has somewhere to go.
      organisation: 34,
    });
    east.sector = sector.index;
  }
  return world;
}

describe('front sector geometry', () => {
  it('cuts a polyline into equal sectors with east-facing normals', () => {
    const front = buildFrontSectors(
      [
        { x: 0, y: 0 },
        { x: 0, y: 300 },
      ],
      3,
      { x: 1, y: 0 },
      'a',
      'b',
    );

    expect(front.sectors).toHaveLength(3);
    for (const sector of front.sectors) {
      expect(sector.widthKm).toBeCloseTo(100);
      // Normal points toward the eastern army for every sector.
      expect(sector.normal.x).toBeGreaterThan(0);
      expect(Math.hypot(sector.normal.x, sector.normal.y)).toBeCloseTo(1);
    }
    expect(front.sectors.map((s) => s.origin.y)).toEqual([50, 150, 250]);
  });

  it('seats a division in the sector nearest its historical position', () => {
    const front = buildFrontSectors(
      [
        { x: 0, y: 0 },
        { x: 0, y: 300 },
      ],
      3,
      { x: 1, y: 0 },
      'a',
      'b',
    );
    expect(nearestSectorIndex(front, { x: 20, y: 10 })).toBe(0);
    expect(nearestSectorIndex(front, { x: -20, y: 260 })).toBe(2);
  });
});

describe('front model stability', () => {
  /**
   * The acceptance test for the sector model: 60 divisions a side over 30
   * sectors must run for ten simulated days without any of the failure modes
   * the free-moving model kept producing.
   */
  it('runs 60 v 60 over 30 sectors without overlap, crossings or holes', () => {
    const world = frontWorld();
    const front = world.front!;
    const engine = new GameEngine(world, {
      systems: createFrontSystems(new CommandQueue()),
    });

    for (let tick = 0; tick < TICKS_PER_DAY * 10; tick++) {
      engine.step();

      // No enemy crossings: every counter stays on its own side of its sector.
      for (const d of world.divisions.values()) {
        if (d.sector === null) continue;
        const sector = front.sectors[d.sector]!;
        const at = sectorPosition(sector);
        const offset =
          (d.position.x - at.x) * sector.normal.x +
          (d.position.y - at.y) * sector.normal.y;
        const alliance = world.getFaction(d.faction)?.alliance;
        if (alliance === 'a') expect(offset).toBeLessThan(0);
        else expect(offset).toBeGreaterThan(0);
      }

      // No frontline holes: adjacent sectors never separate into a tear.
      for (let i = 1; i < front.sectors.length; i++) {
        const step = Math.abs(
          front.sectors[i]!.advanceKm - front.sectors[i - 1]!.advanceKm,
        );
        expect(step).toBeLessThanOrEqual(46);
      }

      // No extreme spikes: the line stays within the bounds of a ten-day
      // advance at the model's own maximum rate.
      for (const sector of front.sectors) {
        expect(Math.abs(sector.advanceKm)).toBeLessThan(30 * 11);
        expect(Number.isFinite(sector.advanceKm)).toBe(true);
      }
    }

    // No counter overlap: distinct slots stay distinct.
    const seen: { x: number; y: number }[] = [];
    for (const d of world.divisions.values()) {
      for (const other of seen) {
        expect(Math.hypot(d.position.x - other.x, d.position.y - other.y)).toBeGreaterThan(1);
      }
      seen.push({ ...d.position });
    }

    // The front did its job: it moved, and it is still continuous.
    const moved = front.sectors.some((s) => Math.abs(s.advanceKm) > 1);
    expect(moved).toBe(true);
  });

  it('never lets a formation march in world space: no orders are issued', () => {
    const world = frontWorld();
    const engine = new GameEngine(world, {
      systems: createFrontSystems(new CommandQueue()),
    });

    for (let tick = 0; tick < TICKS_PER_DAY * 3; tick++) engine.step();

    for (const d of world.divisions.values()) {
      expect(d.order).toBeNull();
      expect(d.stance).not.toBe('move');
      expect(d.stance).not.toBe('retreat');
    }
  });

  it('stacks a crowded sector into ranks behind its own line', () => {
    const world = createTestWorld({ seed: 'front-ranks' });
    const front: FrontState = buildFrontSectors(
      [
        { x: 500, y: 0 },
        { x: 500, y: 200 },
      ],
      2,
      { x: 1, y: 0 },
      'a',
      'b',
    );
    world.front = front;
    for (let i = 0; i < RANK_CAPACITY + 1; i++) {
      const d = addTestDivision(world, `west-${i}`, 400, 50, { faction: WEST });
      d.sector = 0;
    }
    // Sector 1 is manned too, so the allocator has no gap to fill and nobody is
    // in transit while the ranks are inspected.
    addTestDivision(world, 'west-hold', 400, 150, { faction: WEST }).sector = 1;

    const engine = new GameEngine(world, {
      systems: createFrontSystems(new CommandQueue()),
    });
    engine.step();

    const held = [...world.divisions.values()]
      .filter((d) => d.sector === 0)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const line = sectorPosition(front.sectors[0]!);
    // The first rank stands at the standoff distance; the fourth counter has
    // started a second rank further back.
    expect(line.x - held[0]!.position.x).toBeCloseTo(FRONT_STANDOFF_KM, 0);
    expect(line.x - held[RANK_CAPACITY]!.position.x).toBeGreaterThan(
      FRONT_STANDOFF_KM,
    );
  });
});
