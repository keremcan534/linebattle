import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { computeWeather } from '@core/weather/weather';
import { divisionId, factionId } from '@core/world/ids';
import type { World } from '@core/world/world';

const RED = factionId('red');
const BLUE = factionId('blue');

/** Test world with a single red depot in the north-west corner. */
function suppliedWorld(rangeKm = 400): World {
  const world = createTestWorld({ seed: 'supply' });
  world.enableSupply(
    [{ name: 'depot', alliance: 'a', position: { x: 100, y: 100 }, rangeKm, capturable: false }],
    'temperate',
  );
  return world;
}

const run = (world: World, ticks: number) => {
  const engine = new GameEngine(world);
  for (let i = 0; i < ticks; i++) engine.step();
  return engine;
};

describe('SupplySystem', () => {
  it('supplies ground near a depot and not the far corner', () => {
    const world = suppliedWorld();
    run(world, 1);
    const near = world.supply!.supplyAt('a', { x: 140, y: 140 });
    const far = world.supply!.supplyAt('a', { x: 950, y: 950 });
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(near);
  });

  it('falls off with distance', () => {
    const world = suppliedWorld();
    run(world, 1);
    const field = world.supply!;
    const samples = [150, 300, 450].map((d) => field.supplyAt('a', { x: 100 + d, y: 100 }));
    expect(samples[0]!).toBeGreaterThan(samples[1]!);
    expect(samples[1]!).toBeGreaterThan(samples[2]!);
  });

  it('does not flow across water', () => {
    // The lake sits at km 400..600 on both axes; a depot on one shore must not
    // supply the far shore any better than the route around it would.
    const world = suppliedWorld(600);
    run(world, 1);
    const field = world.supply!;
    expect(field.supplyAt('a', { x: 500, y: 500 })).toBe(0);
  });

  it('drains a division that outruns its depot', () => {
    const world = suppliedWorld(200);
    const d = addTestDivision(world, 'spearhead', 900, 900, { faction: RED, supply: 1 });
    run(world, TICKS_PER_DAY * 20);
    expect(d.supply).toBeLessThan(0.2);
  });

  it('lets a division run on stores for a while before starving', () => {
    // Supply must lag, not switch: a spearhead should be able to outrun its
    // trucks briefly and get away with it. That is the decision the whole
    // campaign turns on.
    const world = suppliedWorld(200);
    const d = addTestDivision(world, 'spearhead', 900, 900, { faction: RED, supply: 1 });
    run(world, TICKS_PER_DAY);
    expect(d.supply).toBeGreaterThan(0.6);
  });

  it('keeps a division near its depot supplied', () => {
    const world = suppliedWorld();
    const d = addTestDivision(world, 'rear', 150, 150, { faction: RED, supply: 0.5 });
    run(world, TICKS_PER_DAY * 10);
    expect(d.supply).toBeGreaterThan(0.85);
  });
});

describe('encirclement', () => {
  /** Ring of enemy divisions around a lone red formation. */
  function pocket(): World {
    const world = suppliedWorld();
    addTestDivision(world, 'trapped', 700, 700, { faction: RED, supply: 1 });

    // The ring has to be tight enough that no gap in the presence field lets
    // supply leak through.
    let n = 0;
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 10) {
      addTestDivision(world, `ring-${n++}`, 700 + Math.cos(angle) * 55, 700 + Math.sin(angle) * 55, {
        faction: BLUE,
      });
    }
    return world;
  }

  it('cuts supply to a surrounded division', () => {
    const world = pocket();
    run(world, 8);
    expect(world.supply!.supplyAt('a', { x: 700, y: 700 })).toBe(0);
  });

  it('flags it as encircled, not merely short of supply', () => {
    const world = pocket();
    const engine = new GameEngine(world);
    const events: string[] = [];
    engine.events.onAny((e) => {
      if (e.type !== 'tick') events.push(e.type);
    });
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.step();

    expect(events).toContain('divisionEncircled');
    expect(world.getDivision(divisionId('trapped'))?.encircled).toBe(true);
  });

  it('kills the pocket eventually, which battle alone cannot', () => {
    // This is the point of the whole milestone: combat breaks divisions but
    // cannot destroy them, so encirclement is the only reliable way to remove
    // a formation from the map — as it was in 1941.
    const world = pocket();
    const engine = new GameEngine(world);
    let destroyed = false;
    engine.events.on('divisionDestroyed', () => (destroyed = true));

    for (let i = 0; i < TICKS_PER_DAY * 90 && !destroyed; i++) engine.step();

    expect(destroyed).toBe(true);
    expect(world.getDivision(divisionId('trapped'))).toBeUndefined();
  });

  it('does not flag an unsupplied division in empty country', () => {
    // Out of range is not the same as cut off, and conflating them would cry
    // wolf every time a spearhead got ahead of its trucks.
    const world = suppliedWorld(200);
    const d = addTestDivision(world, 'lonely', 900, 900, { faction: RED });
    run(world, TICKS_PER_DAY * 5);
    expect(d.supply).toBeLessThan(0.5);
    expect(d.encircled).toBe(false);
  });
});

describe('weather', () => {
  it('mires the Eastern Front in autumn and freezes it in winter', () => {
    const summer = computeWeather(new Date('1941-07-15T00:00:00Z'), 'continental');
    const mud = computeWeather(new Date('1941-10-20T00:00:00Z'), 'continental');
    const winter = computeWeather(new Date('1941-12-20T00:00:00Z'), 'continental');

    expect(summer.movement).toBe(1);
    expect(mud.movement).toBeLessThan(0.6);
    expect(winter.attrition).toBeGreaterThan(2);
    expect(winter.recovery).toBeLessThan(1);
  });

  it('does not put mud in the desert', () => {
    const october = computeWeather(new Date('1942-10-23T00:00:00Z'), 'desert');
    expect(october.movement).toBe(1);
  });

  it('is derived from the date, never stored', () => {
    const world = suppliedWorld();
    world.climate = 'continental';
    const engine = new GameEngine(world);
    engine.step();
    expect(world.weather.season).toBe('Summer'); // scenario starts in June

    // Jump the clock forward; weather must follow with no other bookkeeping.
    world.clock.tick += TICKS_PER_DAY * 150;
    engine.step();
    expect(world.weather.season).toBe('Autumn rasputitsa');
  });

  it('slows movement when the ground turns', () => {
    const march = (climate: 'continental' | 'desert') => {
      const world = createTestWorld({ seed: 'mud' });
      world.climate = climate;
      const d = addTestDivision(world, 'a', 100, 100, { speedKmh: 3 });
      const engine = new GameEngine(world);
      engine.issue({ type: 'move', divisions: [d.id], destination: { x: 900, y: 100 }, append: false });
      // Start in October so the continental case is in the rasputitsa.
      world.clock.tick = TICKS_PER_DAY * 120;
      for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();
      return d.position.x - 100;
    };

    expect(march('continental')).toBeLessThan(march('desert') * 0.7);
  });
});
