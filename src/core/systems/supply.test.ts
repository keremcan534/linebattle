import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import {
  addTestDivision,
  createTestWorld,
} from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { computeWeather } from '@core/weather/weather';
import { divisionId, factionId } from '@core/world/ids';
import type { World } from '@core/world/world';

const RED = factionId('red');
const BLUE = factionId('blue');

/** A test theatre whose passable land belongs to the capital's alliance. */
function connectedWorld(): World {
  const world = createTestWorld({ seed: 'capital-connectivity' });
  world.enableSupply(
    [
      {
        name: 'capital',
        alliance: 'a',
        position: { x: 100, y: 100 },
        rangeKm: 1,
        capturable: false,
        networkRoot: true,
      },
    ],
    'temperate',
  );
  const field = world.supply!;
  const owner = field.allianceIndex('a') + 1;
  for (let i = 0; i < field.control.length; i++) {
    if (field.throughput[i]! > 0) field.control[i] = owner;
  }
  return world;
}

const run = (world: World, ticks: number) => {
  const engine = new GameEngine(world);
  for (let i = 0; i < ticks; i++) engine.step();
  return engine;
};

describe('capital connectivity', () => {
  it('fully supplies connected territory regardless of distance', () => {
    const world = connectedWorld();
    const division = addTestDivision(world, 'far-front', 900, 900, {
      faction: RED,
      supply: 0,
    });

    run(world, 1);

    expect(world.supply!.networkAt('a', division.position)).toBe(true);
    expect(division.supply).toBe(1);
  });

  it('cuts supply when hostile control severs every land route', () => {
    const world = connectedWorld();
    const field = world.supply!;
    const blue = field.allianceIndex('b') + 1;
    for (let y = 0; y < field.height; y++) {
      for (let x = 29; x <= 31; x++) {
        const i = y * field.width + x;
        if (field.throughput[i]! > 0) field.control[i] = blue;
      }
    }
    const division = addTestDivision(world, 'cut-off', 850, 200, {
      faction: RED,
    });

    run(world, 1);

    expect(field.networkAt('a', division.position)).toBe(false);
    expect(division.supply).toBe(0);
    expect(division.encircled).toBe(false);
  });

  it('never connects through water', () => {
    const world = connectedWorld();
    run(world, 1);
    expect(world.supply!.networkAt('a', { x: 500, y: 500 })).toBe(false);
  });

  it('does not let an isolated forward hub become a second capital', () => {
    const world = createTestWorld({ seed: 'networked-hubs' });
    world.enableSupply(
      [
        {
          name: 'capital',
          alliance: 'a',
          position: { x: 100, y: 200 },
          rangeKm: 1,
          capturable: false,
          networkRoot: true,
        },
        {
          name: 'isolated hub',
          alliance: 'a',
          position: { x: 850, y: 200 },
          rangeKm: 999,
          capturable: true,
          networkRoot: false,
        },
      ],
      'temperate',
    );
    const field = world.supply!;
    const red = field.allianceIndex('a') + 1;
    const blue = field.allianceIndex('b') + 1;
    for (let y = 0; y < field.height; y++) {
      for (let x = 0; x < field.width; x++) {
        const i = y * field.width + x;
        if (field.throughput[i]! <= 0) continue;
        field.control[i] = x < 20 || x > 45 ? red : blue;
      }
    }

    new GameEngine(world).step();

    expect(field.networkAt('a', { x: 850, y: 200 })).toBe(false);
  });
});

describe('encirclement', () => {
  function pocket(): World {
    const world = connectedWorld();
    addTestDivision(world, 'trapped', 700, 700, {
      faction: RED,
      supply: 1,
    });
    let n = 0;
    for (
      let angle = 0;
      angle < Math.PI * 2;
      angle += Math.PI / 10
    ) {
      addTestDivision(
        world,
        `ring-${n++}`,
        700 + Math.cos(angle) * 55,
        700 + Math.sin(angle) * 55,
        { faction: BLUE },
      );
    }
    return world;
  }

  it('cuts and flags a surrounded formation', () => {
    const world = pocket();
    const engine = new GameEngine(world);
    const events: string[] = [];
    engine.events.onAny((event) => {
      if (event.type !== 'tick') events.push(event.type);
    });
    engine.step();
    engine.step();

    const trapped = world.getDivision(divisionId('trapped'))!;
    expect(trapped.supply).toBe(0);
    expect(trapped.encircled).toBe(true);
    expect(events).toContain('divisionEncircled');
  });

  it('destroys a sealed pocket after sustained isolation', () => {
    const world = pocket();
    const engine = new GameEngine(world);
    let destroyed = false;
    engine.events.on('divisionDestroyed', () => {
      destroyed = true;
    });

    for (
      let i = 0;
      i < TICKS_PER_DAY * 8 && !destroyed;
      i++
    ) {
      engine.step();
    }

    expect(destroyed).toBe(true);
    expect(world.getDivision(divisionId('trapped'))).toBeUndefined();
  });

  it('resets collapse when a friendly corridor reconnects the pocket', () => {
    const world = pocket();
    const engine = new GameEngine(world);
    const trapped = world.getDivision(divisionId('trapped'))!;
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.step();
    expect(trapped.encircled).toBe(true);

    for (const id of [...world.divisions.keys()]) {
      if (String(id).startsWith('ring-')) world.divisions.delete(id);
    }
    const field = world.supply!;
    const red = field.allianceIndex('a') + 1;
    for (let i = 0; i < field.control.length; i++) {
      if (field.throughput[i]! > 0) field.control[i] = red;
    }
    engine.step();

    expect(trapped.encircled).toBe(false);
    expect(trapped.encircledTicks).toBe(0);
    expect(trapped.supply).toBe(1);
  });
});

describe('weather', () => {
  it('mires the Eastern Front in autumn and freezes it in winter', () => {
    const summer = computeWeather(
      new Date('1941-07-15T00:00:00Z'),
      'continental',
    );
    const mud = computeWeather(
      new Date('1941-10-20T00:00:00Z'),
      'continental',
    );
    const winter = computeWeather(
      new Date('1941-12-20T00:00:00Z'),
      'continental',
    );

    expect(summer.movement).toBe(1);
    expect(mud.movement).toBeLessThan(0.6);
    expect(winter.attrition).toBeGreaterThan(2);
    expect(winter.recovery).toBeLessThan(1);
  });

  it('does not put mud in the desert', () => {
    const october = computeWeather(
      new Date('1942-10-23T00:00:00Z'),
      'desert',
    );
    expect(october.movement).toBe(1);
  });

  it('derives weather from the date', () => {
    const world = connectedWorld();
    world.climate = 'continental';
    const engine = new GameEngine(world);
    engine.step();
    expect(world.weather.season).toBe('Summer');

    world.clock.tick += TICKS_PER_DAY * 150;
    engine.step();
    expect(world.weather.season).toBe('Autumn rasputitsa');
  });

  it('slows movement when the ground turns', () => {
    const march = (climate: 'continental' | 'desert') => {
      const world = createTestWorld({ seed: 'mud' });
      world.climate = climate;
      const division = addTestDivision(world, 'a', 100, 100, {
        speedKmh: 3,
      });
      const engine = new GameEngine(world);
      engine.issue({
        type: 'move',
        divisions: [division.id],
        destination: { x: 900, y: 100 },
        append: false,
      });
      world.clock.tick = TICKS_PER_DAY * 120;
      world.weather = computeWeather(world.clock.date, climate);
      for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();
      return division.position.x - 100;
    };

    expect(march('continental')).toBeLessThan(march('desert') * 0.7);
  });
});
