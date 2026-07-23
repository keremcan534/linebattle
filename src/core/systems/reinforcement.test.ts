import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { divisionId, factionId } from '@core/world/ids';
import { RecoverySystem } from './recoverySystem';
import { ReinforcementSystem } from './reinforcementSystem';
import { MobilizationSystem } from './mobilizationSystem';
import { SupplySystem } from './supplySystem';

describe('ReinforcementSystem', () => {
  it('sends supply-gated replacements to both alliances symmetrically', () => {
    const world = createTestWorld();
    const red = addTestDivision(world, 'red', 100, 100, {
      faction: factionId('red'),
      manpower: 5_000,
    });
    const blue = addTestDivision(world, 'blue', 900, 900, {
      faction: factionId('blue'),
      manpower: 5_000,
    });
    const engine = new GameEngine(world, { systems: [new ReinforcementSystem()] });

    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();

    expect(red.manpower).toBeCloseTo(5_200, 6);
    expect(blue.manpower).toBeCloseTo(red.manpower, 6);
  });

  it('does not reinforce an encircled or unsupplied formation', () => {
    const world = createTestWorld();
    const pocket = addTestDivision(world, 'pocket', 100, 100, {
      manpower: 5_000,
      encircled: true,
    });
    const starved = addTestDivision(world, 'starved', 900, 900, {
      manpower: 5_000,
      supply: 0.2,
    });
    const engine = new GameEngine(world, { systems: [new ReinforcementSystem()] });

    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();

    expect(pocket.manpower).toBe(5_000);
    expect(starved.manpower).toBe(5_000);
  });
});

describe('RecoverySystem', () => {
  it('does not let ordinary marching drain a sound formation to zero organisation', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'marcher', 100, 100);
    d.order = {
      kind: 'move',
      waypoints: [{ x: 900, y: 100 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    d.stance = 'move';
    const engine = new GameEngine(world, { systems: [new RecoverySystem()] });

    for (let i = 0; i < TICKS_PER_DAY * 60; i++) engine.step();

    expect(d.organisation / d.maxOrganisation).toBeGreaterThanOrEqual(0.69);
  });

  it('lets a broken formation regroup while making operational alignment moves', () => {
    const world = createTestWorld();
    const d = addTestDivision(world, 'regrouping', 100, 100, { organisation: 10 });
    d.order = {
      kind: 'move',
      waypoints: [{ x: 900, y: 100 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    d.stance = 'move';
    const engine = new GameEngine(world, { systems: [new RecoverySystem()] });

    for (let i = 0; i < TICKS_PER_DAY * 8; i++) engine.step();

    expect(d.organisation).toBeGreaterThan(10);
  });
});

describe('MobilizationSystem', () => {
  it('continuously grows both armies at their scenario-defined recruitment rates', () => {
    const world = createTestWorld({ seed: 'continuous-mobilization' });
    addTestDivision(world, 'red-a', 100, 100, { faction: factionId('red') });
    addTestDivision(world, 'blue-a', 900, 900, { faction: factionId('blue') });
    world.configureCampaign(
      [
        {
          alliance: 'a',
          daysPerDivision: 1,
          maxForceMultiplier: 2,
          divisionsPerFrontlineSegment: 0,
        },
        {
          alliance: 'b',
          daysPerDivision: 4,
          maxForceMultiplier: 2,
          divisionsPerFrontlineSegment: 0,
        },
      ],
      [],
    );
    world.enableSupply(
      [
        {
          name: 'red capital',
          alliance: 'a',
          position: { x: 100, y: 100 },
          rangeKm: 500,
          capturable: false,
        },
        {
          name: 'blue capital',
          alliance: 'b',
          position: { x: 900, y: 900 },
          rangeKm: 500,
          capturable: false,
        },
      ],
      'temperate',
    );
    const engine = new GameEngine(world, {
      systems: [new SupplySystem(), new MobilizationSystem()],
    });

    for (let i = 0; i < TICKS_PER_DAY + 1; i++) engine.step();
    const count = (alliance: string) =>
      [...world.divisions.values()].filter(
        (d) => world.getFaction(d.faction)?.alliance === alliance,
      ).length;
    expect(count('a')).toBe(2);
    expect(count('b')).toBe(1);

    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.step();
    expect(count('b')).toBe(2);
  });

  it('raises a replacement division for both alliances after sustained losses', () => {
    const world = createTestWorld({ seed: 'mobilization' });
    addTestDivision(world, 'red-a', 100, 100, { faction: factionId('red') });
    addTestDivision(world, 'red-b', 120, 100, { faction: factionId('red') });
    addTestDivision(world, 'blue-a', 880, 900, { faction: factionId('blue') });
    addTestDivision(world, 'blue-b', 900, 900, { faction: factionId('blue') });
    world.enableSupply(
      [
        {
          name: 'red capital',
          alliance: 'a',
          position: { x: 100, y: 100 },
          rangeKm: 500,
          capturable: false,
        },
        {
          name: 'blue capital',
          alliance: 'b',
          position: { x: 900, y: 900 },
          rangeKm: 500,
          capturable: false,
        },
      ],
      'temperate',
    );
    world.divisions.delete(divisionId('red-b'));
    world.divisions.delete(divisionId('blue-b'));

    const engine = new GameEngine(world, {
      systems: [new SupplySystem(), new MobilizationSystem()],
    });
    const raised: string[] = [];
    engine.events.on('divisionRaised', (event) => raised.push(String(event.division)));
    for (let i = 0; i < TICKS_PER_DAY * 15; i++) engine.step();

    expect(raised).toHaveLength(2);
    expect(
      [...world.divisions.values()].filter(
        (d) => world.getFaction(d.faction)?.alliance === 'a',
      ),
    ).toHaveLength(2);
    expect(
      [...world.divisions.values()].filter(
        (d) => world.getFaction(d.faction)?.alliance === 'b',
      ),
    ).toHaveLength(2);
  });
});
