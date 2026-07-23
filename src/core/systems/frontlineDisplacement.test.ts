import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import {
  addTestDivision,
  createTestWorld,
} from '@core/testing/testWorld';
import { divisionId, factionId } from '@core/world/ids';
import { AttritionSystem } from './attritionSystem';
import {
  ENEMY_MIN_SEPARATION_KM,
  FRONTLINE_LINK_MAX_DISTANCE_KM,
  MovementSystem,
} from './movementSystem';

const RED = factionId('red');
const BLUE = factionId('blue');

function orderEast(
  division: ReturnType<typeof addTestDivision>,
  x = 400,
): void {
  division.order = {
    kind: 'move',
    waypoints: [{ x, y: division.position.y }],
    cursor: 0,
    bestDistance: Infinity,
    stalledTicks: 0,
  };
  division.stance = 'move';
  division.state = 'MOVING';
}

function runUntil(
  engine: GameEngine,
  predicate: () => boolean,
  maxTicks = TICKS_PER_DAY * 12,
): number {
  for (let tick = 1; tick <= maxTicks; tick++) {
    engine.step();
    if (predicate()) return tick;
  }
  return maxTicks;
}

describe('frontline displacement rules', () => {
  it('1. Equal forces create a stable frontline', () => {
    const world = createTestWorld({ seed: 'equal-stalemate' });
    const red = addTestDivision(world, 'red', 200, 200, {
      faction: RED,
    });
    const blue = addTestDivision(world, 'blue', 214, 200, {
      faction: BLUE,
    });
    const engine = new GameEngine(world);
    const destroyed: string[] = [];
    engine.events.on('divisionDestroyed', (event) =>
      destroyed.push(event.division),
    );

    for (let i = 0; i < TICKS_PER_DAY * 2; i++) engine.step();

    expect(red.position).toEqual({ x: 200, y: 200 });
    expect(blue.position).toEqual({ x: 214, y: 200 });
    expect(red.state).toBe('FIGHTING');
    expect(blue.state).toBe('FIGHTING');
    expect(destroyed).toEqual([]);
  });

  it('2. A stronger force slowly pushes a weaker force', () => {
    const world = createTestWorld({ seed: 'moderate-push' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 22,
      defence: 26,
    });
    const defender = addTestDivision(world, 'defender', 214, 200, {
      faction: BLUE,
      softAttack: 18,
      defence: 20,
    });
    orderEast(attacker);
    const engine = new GameEngine(world);

    const breakTick = runUntil(
      engine,
      () => defender.state === 'FALLING_BACK',
    );

    expect(breakTick).toBeGreaterThan(1);
    expect(breakTick).toBeLessThan(TICKS_PER_DAY * 12);
    expect(attacker.position.x).toBeLessThan(defender.position.x);
    expect(world.getDivision(defender.id)).toBeDefined();
  });

  it('3. The weaker force retreats without being destroyed', () => {
    const world = createTestWorld({ seed: 'surviving-retreat' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 38,
      defence: 36,
    });
    const defender = addTestDivision(world, 'defender', 214, 200, {
      faction: BLUE,
      softAttack: 13,
      defence: 15,
      organisation: 30,
    });
    orderEast(attacker);
    const engine = new GameEngine(world);
    let destroyed = false;
    engine.events.on('divisionDestroyed', () => {
      destroyed = true;
    });

    runUntil(
      engine,
      () =>
        defender.state === 'RECOVERING' ||
        defender.state === 'FRONTLINE',
      TICKS_PER_DAY * 20,
    );

    expect(destroyed).toBe(false);
    expect(world.getDivision(defender.id)).toBe(defender);
    expect(defender.position.x).toBeGreaterThan(240);
    expect(['RECOVERING', 'FRONTLINE']).toContain(defender.state);
  });

  it('4. The attacker cannot pass through the retreating defender', () => {
    const world = createTestWorld({ seed: 'no-passing-retreat' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 40,
      defence: 38,
      speedKmh: 5,
    });
    const defender = addTestDivision(world, 'defender', 214, 200, {
      faction: BLUE,
      softAttack: 12,
      defence: 14,
      organisation: 28,
      speedKmh: 2,
    });
    orderEast(attacker);
    const engine = new GameEngine(world);
    let observedFallback = false;

    for (let i = 0; i < TICKS_PER_DAY * 15; i++) {
      engine.step();
      if (defender.state !== 'FALLING_BACK') continue;
      observedFallback = true;
      expect(attacker.position.x).toBeLessThan(defender.position.x);
      expect(
        Math.hypot(
          defender.position.x - attacker.position.x,
          defender.position.y - attacker.position.y,
        ),
      ).toBeGreaterThanOrEqual(ENEMY_MIN_SEPARATION_KM);
    }

    expect(observedFallback).toBe(true);
  });

  it('5. A second-line friendly division blocks further penetration', () => {
    const world = createTestWorld({ seed: 'second-line', cellSize: 100 });
    const attacker = addTestDivision(world, 'attacker', 100, 100, {
      faction: RED,
      speedKmh: 20,
    });
    const fallingBack = addTestDivision(world, 'falling-back', 130, 100, {
      faction: BLUE,
      state: 'FALLING_BACK',
      stance: 'retreat',
      organisation: 8,
      speedKmh: 5,
    });
    const reserve = addTestDivision(world, 'reserve', 180, 100, {
      faction: BLUE,
    });
    fallingBack.order = {
      kind: 'move',
      waypoints: [{ x: 165, y: 100 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    orderEast(attacker, 260);
    const engine = new GameEngine(world, {
      systems: [new MovementSystem()],
    });

    for (let i = 0; i < 40; i++) engine.step();

    expect(attacker.position.x).toBeLessThan(reserve.position.x);
    expect(
      Math.hypot(
        reserve.position.x - attacker.position.x,
        reserve.position.y - attacker.position.y,
      ),
    ).toBeGreaterThanOrEqual(ENEMY_MIN_SEPARATION_KM);
  });

  it('6. A real gap between units remains passable', () => {
    const world = createTestWorld({ seed: 'real-gap', cellSize: 100 });
    const attacker = addTestDivision(world, 'attacker', 100, 100, {
      faction: RED,
      speedKmh: 200,
    });
    addTestDivision(world, 'north', 150, 65, { faction: BLUE });
    addTestDivision(world, 'south', 150, 135, { faction: BLUE });
    expect(70).toBeGreaterThan(FRONTLINE_LINK_MAX_DISTANCE_KM);
    orderEast(attacker, 200);

    new GameEngine(world, {
      systems: [new MovementSystem()],
    }).step();

    expect(attacker.position.x).toBeGreaterThan(150);
  });

  it('7. Linked frontline units block movement between them', () => {
    const world = createTestWorld({ seed: 'linked-front', cellSize: 100 });
    const attacker = addTestDivision(world, 'attacker', 100, 100, {
      faction: RED,
      speedKmh: 200,
    });
    addTestDivision(world, 'north', 150, 80, { faction: BLUE });
    addTestDivision(world, 'south', 150, 120, { faction: BLUE });
    expect(40).toBeLessThanOrEqual(FRONTLINE_LINK_MAX_DISTANCE_KM);
    orderEast(attacker, 200);

    new GameEngine(world, {
      systems: [new MovementSystem()],
    }).step();

    expect(attacker.position.x).toBeLessThan(150);
  });

  it('8. Losing one combat does not cause an immediate chain collapse', () => {
    const world = createTestWorld({ seed: 'no-chain-collapse' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 42,
      defence: 38,
    });
    const weak = addTestDivision(world, 'weak', 214, 200, {
      faction: BLUE,
      softAttack: 11,
      defence: 13,
      organisation: 26,
    });
    const neighbour = addTestDivision(world, 'neighbour', 214, 235, {
      faction: BLUE,
      softAttack: 24,
      defence: 30,
    });
    const secondLine = addTestDivision(world, 'second-line', 255, 218, {
      faction: BLUE,
      defence: 32,
    });
    orderEast(attacker);
    const engine = new GameEngine(world);

    runUntil(
      engine,
      () => weak.state === 'FALLING_BACK',
      TICKS_PER_DAY * 12,
    );
    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();

    expect(world.getDivision(weak.id)).toBeDefined();
    expect(neighbour.state).not.toBe('FALLING_BACK');
    expect(secondLine.state).not.toBe('FALLING_BACK');
    expect(world.divisions.size).toBe(4);
  });

  it('9. A supplied unit with a retreat route survives', () => {
    const world = createTestWorld({ seed: 'supplied-survivor' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 48,
      defence: 42,
    });
    const defender = addTestDivision(world, 'supplied', 214, 200, {
      faction: BLUE,
      softAttack: 10,
      defence: 12,
      organisation: 20,
      manpower: 900,
      supply: 1,
      encircled: false,
    });
    orderEast(attacker);
    const engine = new GameEngine(world);
    let destroyed = false;
    engine.events.on('divisionDestroyed', () => {
      destroyed = true;
    });

    for (let i = 0; i < TICKS_PER_DAY * 12; i++) engine.step();

    expect(destroyed).toBe(false);
    expect(world.getDivision(divisionId('supplied'))).toBe(defender);
    expect(defender.position.x).toBeGreaterThan(214);
  });

  it('10. An isolated unit with no retreat route can eventually surrender', () => {
    const world = createTestWorld({ seed: 'sealed-surrender' });
    const trapped = addTestDivision(world, 'trapped', 700, 700, {
      faction: RED,
      organisation: 0,
      supply: 0,
      encircled: true,
      encircledTicks: TICKS_PER_DAY * 7,
      state: 'FIGHTING',
    });
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      addTestDivision(
        world,
        `ring-${i}`,
        700 + Math.cos(angle) * 30,
        700 + Math.sin(angle) * 30,
        { faction: BLUE },
      );
    }
    const engine = new GameEngine(world, {
      systems: [new AttritionSystem()],
    });
    let surrendered = false;
    engine.events.on('divisionDestroyed', (event) => {
      if (event.division === trapped.id) surrendered = true;
    });

    engine.step();

    expect(surrendered).toBe(true);
    expect(world.getDivision(trapped.id)).toBeUndefined();
  });
});
