import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { factionId } from '@core/world/ids';
import { campaignModifiers } from '@core/world/campaign';

describe('national resolve', () => {
  it('scales combat recovery and mobilization with occupied opening territory', () => {
    const plan = {
      alliance: 'b',
      nationalResolve: {
        maximumAtTerritoryLoss: 0.5,
        combatMultiplier: 1.4,
        recoveryMultiplier: 1.6,
        mobilizationMultiplier: 5,
      },
    };

    expect(
      campaignModifiers(plan, new Date('1941-10-01T00:00:00Z'), 0.25),
    ).toEqual({
      combat: 1.2,
      recovery: 1.3,
      mobilization: 3,
    });
  });
});

describe('long campaign operations', () => {
  it('keeps the opening-shock army sector-bound while faster recruitment fills the line', () => {
    const world = createTestWorld({ seed: 'eastern-campaign-45d' });
    for (let i = 0; i < 10; i++) {
      const y = 80 + i * 85;
      addTestDivision(world, `axis-${i}`, 330, y, {
        faction: factionId('red'),
        speedKmh: 2.4,
      });
      addTestDivision(world, `soviet-${i}`, 520, y, {
        faction: factionId('blue'),
        organisation: 32,
        morale: 0.62,
        speedKmh: 2,
      });
    }
    world.configureCampaign(
      [
        {
          alliance: 'a',
          daysPerDivision: 7,
          maxForceMultiplier: 1.5,
          divisionsPerFrontlineSegment: 0.8,
        },
        {
          alliance: 'b',
          daysPerDivision: 2.5,
          maxForceMultiplier: 2.5,
          divisionsPerFrontlineSegment: 1.1,
        },
      ],
      [
        {
          alliance: 'b',
          openingShock: {
            until: Date.parse('1941-08-15T00:00:00Z'),
            combatMultiplier: 0.72,
            recoveryMultiplier: 0.7,
          },
          fallback: {
            until: Date.parse('1941-12-01T00:00:00Z'),
            line: [{ x: 650, y: 40 }, { x: 650, y: 960 }],
            rearOffsetKm: 20,
            rearward: { x: 1, y: 0 },
            influenceKm: 800,
          },
        },
      ],
    );
    world.enableSupply(
      [
        {
          name: 'axis rail entry',
          alliance: 'a',
          position: { x: 100, y: 500 },
          rangeKm: 750,
          capturable: false,
        },
        {
          name: 'soviet capital',
          alliance: 'b',
          position: { x: 900, y: 500 },
          rangeKm: 750,
          capturable: false,
        },
      ],
      'continental',
    );

    const engine = new GameEngine(world, { aiAlliances: ['a', 'b'] });
    const raised = new Map<string, number>();
    const sovietDeployments: { x: number; y: number }[] = [];
    engine.events.on('divisionRaised', (event) => {
      const division = world.getDivision(event.division);
      const alliance = division
        ? world.getFaction(division.faction)?.alliance
        : undefined;
      if (alliance) {
        raised.set(alliance, (raised.get(alliance) ?? 0) + 1);
        if (alliance === 'b') sovietDeployments.push(event.position);
      }
    });

    for (let i = 0; i < TICKS_PER_DAY * 45; i++) engine.step();

    const soviets = [...world.divisions.values()].filter(
      (division) => world.getFaction(division.faction)?.alliance === 'b',
    );
    const xs = soviets.map((division) => division.position.x).sort((a, b) => a - b);
    const medianX = xs[Math.floor(xs.length / 2)] ?? 0;

    expect(raised.get('b') ?? 0).toBeGreaterThan(raised.get('a') ?? 0);
    expect(soviets.length).toBeGreaterThanOrEqual(10);
    expect(medianX).toBeGreaterThan(350);
    expect(sovietDeployments.length).toBeGreaterThan(2);
    const deploymentYs = sovietDeployments.map((position) => position.y);
    expect(Math.max(...deploymentYs) - Math.min(...deploymentYs)).toBeGreaterThan(250);
  });
});
