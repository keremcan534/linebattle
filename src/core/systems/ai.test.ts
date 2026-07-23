import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { battleId, divisionId, factionId } from '@core/world/ids';
import { hashWorld } from '@core/world/worldHash';
import type { FrontlineSegmentId } from '@core/world/frontline';

const RED = factionId('red'); // alliance 'a' — the "player"
const BLUE = factionId('blue'); // alliance 'b' — the AI

const aiEngine = (world: ReturnType<typeof createTestWorld>) =>
  new GameEngine(world, { aiAlliances: ['b'] });

describe('AiSystem', () => {
  it('holds a quiet sector instead of wandering', () => {
    const world = createTestWorld({ seed: 'ai-hold' });
    addTestDivision(world, 'red-1', 100, 100, { faction: RED });
    const blue = addTestDivision(world, 'blue-1', 900, 900, { faction: BLUE });

    const engine = aiEngine(world);
    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();

    expect(blue.order).toBeNull();
    expect(blue.position).toEqual({ x: 900, y: 900 });
  });

  it('moves to block an approaching enemy', () => {
    const world = createTestWorld({ seed: 'ai-block' });
    const red = addTestDivision(world, 'red-1', 200, 500, { faction: RED, speedKmh: 3 });
    const blue = addTestDivision(world, 'blue-1', 330, 500, { faction: BLUE, speedKmh: 2 });

    const engine = aiEngine(world);
    engine.issue({ type: 'move', divisions: [red.id], destination: { x: 900, y: 500 }, append: false });

    let blueOrdered = false;
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) {
      engine.step();
      if (blue.order) blueOrdered = true;
    }
    expect(blueOrdered).toBe(true);
  });

  it('brings the sides to battle without any player input to the AI', () => {
    const world = createTestWorld({ seed: 'ai-battle' });
    // y=250 is a clear lane; at y=500 the pathfinder routes around the lake
    // and legitimately bypasses the defender, which is not what this tests.
    const red = addTestDivision(world, 'red-1', 200, 250, { faction: RED, speedKmh: 3 });
    addTestDivision(world, 'blue-1', 320, 250, { faction: BLUE });

    const engine = aiEngine(world);
    engine.issue({ type: 'move', divisions: [red.id], destination: { x: 900, y: 250 }, append: false });

    let battles = 0;
    engine.events.on('battleStarted', () => battles++);
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.step();
    expect(battles).toBeGreaterThan(0);
  });

  it('drops its move order once engaged, so it defends instead of "attacking in place"', () => {
    // A side with a live order counts as attacking and forfeits the terrain
    // bonus — an AI that kept stale orders would fight every battle at a
    // handicap without a single line of combat code being wrong.
    const world = createTestWorld({ seed: 'ai-stand' });
    addTestDivision(world, 'red-1', 300, 300, {
      faction: RED,
      softAttack: 1,
      defence: 1_000,
    });
    const blue = addTestDivision(world, 'blue-1', 308, 300, {
      faction: BLUE,
      softAttack: 1,
      defence: 1_000,
    });

    blue.order = {
      kind: 'move',
      waypoints: [{ x: 900, y: 900 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    world.battles.set(battleId('battle-test'), {
      id: battleId('battle-test'),
      sides: [
        {
          alliance: 'a',
          divisions: [divisionId('red-1')],
          attacking: false,
          power: 0,
        },
        {
          alliance: 'b',
          divisions: [blue.id],
          attacking: true,
          power: 0,
        },
      ],
      position: { x: 304, y: 300 },
      startedTick: 0,
      terrain: 'Plains',
      progress: 0.5,
    });
    const engine = aiEngine(world);
    engine.step();
    expect(blue.order).toBeNull();
    expect(world.battles.size).toBe(1);
    for (const battle of world.battles.values()) {
      const blueSide = battle.sides.find((s) => s.alliance === 'b')!;
      expect(blueSide.attacking).toBe(false);
    }
  });

  it('spreads defenders across threats instead of dogpiling one spearhead', () => {
    const world = createTestWorld({ seed: 'ai-spread' });
    // Two red spearheads inside the AI's 80 km reaction range, four blue
    // defenders between them. The claim limit must send blues to BOTH.
    //
    // Placed on the western plains: the first version put everyone at
    // x=420..470, y=420..585 — squarely inside the central LAKE (km 400–600
    // on both axes). The AI dutifully issued orders every review and the
    // pathfinder rightly refused all of them, which the debug log showed as a
    // steady drumbeat of orderBlocked. The AI was never the bug.
    addTestDivision(world, 'red-n', 180, 300, { faction: RED });
    addTestDivision(world, 'red-s', 180, 460, { faction: RED });
    for (let i = 0; i < 4; i++) {
      addTestDivision(world, `blue-${i}`, 230, 320 + i * 40, { faction: BLUE, speedKmh: 2.5 });
    }

    const engine = aiEngine(world);
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) engine.step();

    // Both spearheads must end up with someone on them.
    const near = (x: number, y: number) =>
      world.divisionsNear(x, y, 30).filter((d) => d.faction === BLUE).length;
    expect(near(180, 300)).toBeGreaterThan(0);
    expect(near(180, 460)).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const world = createTestWorld({ seed: 'ai-det' });
      const red = addTestDivision(world, 'red-1', 200, 480, { faction: RED, speedKmh: 3 });
      addTestDivision(world, 'red-2', 200, 540, { faction: RED, speedKmh: 2.5 });
      addTestDivision(world, 'blue-1', 350, 500, { faction: BLUE, speedKmh: 2 });
      addTestDivision(world, 'blue-2', 380, 560, { faction: BLUE, speedKmh: 2 });
      const engine = aiEngine(world);
      engine.issue({ type: 'move', divisions: [red.id], destination: { x: 900, y: 500 }, append: false });
      for (let i = 0; i < TICKS_PER_DAY * 4; i++) engine.step();
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });

  it('uses at most two nearby foot divisions to clear a pocket and keeps armour on the front', () => {
    const world = createTestWorld({ seed: 'pocket-cleanup' });
    const pocket = addTestDivision(world, 'pocket', 220, 300, {
      faction: BLUE,
      encircled: true,
    });
    const infantry = Array.from({ length: 4 }, (_, i) =>
      addTestDivision(world, `inf-${i}`, 100, 260 + i * 20, {
        faction: RED,
        branch: 'infantry',
      }),
    );
    const tank = addTestDivision(world, 'tank', 150, 300, {
      faction: RED,
      branch: 'armoured',
    });
    const engine = new GameEngine(world, { aiAlliances: ['a'] });

    engine.step();

    const cleaners = infantry.filter(
      (d) => d.order?.waypoints.at(-1)?.x === pocket.position.x,
    );
    expect(cleaners).toHaveLength(2);
    expect(tank.order).toBeNull();
  });

  it('does not issue an impossible move through a sealed encirclement', () => {
    const world = createTestWorld({ seed: 'pocket-breakout' });
    const trapped = addTestDivision(world, 'trapped', 700, 700, {
      faction: RED,
      supply: 0.2,
    });
    let n = 0;
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 10) {
      addTestDivision(
        world,
        `ring-${n++}`,
        700 + Math.cos(angle) * 55,
        700 + Math.sin(angle) * 55,
        { faction: BLUE },
      );
    }
    const root = { x: 100, y: 100 };
    world.enableSupply(
      [
        {
          name: 'capital',
          alliance: 'a',
          position: root,
          rangeKm: 700,
          capturable: false,
        },
      ],
      'temperate',
    );
    const engine = new GameEngine(world, { aiAlliances: ['a'] });

    // The liquid control layer is established on the first logistics pass;
    // the next hourly pass can then recognise the closed ring, and HQ reacts
    // on its regular three-hour order cycle.
    for (let tick = 0; tick <= 3 * 4; tick++) engine.step();

    expect(trapped.encircled).toBe(true);
    expect(trapped.order).toBeNull();
  });

  it('keeps an opening-shock army in separate assigned sectors', () => {
    const world = createTestWorld({ seed: 'campaign-fallback' });
    const retreating = addTestDivision(world, 'retreating', 300, 300, {
      faction: RED,
    });
    const holding = addTestDivision(world, 'holding', 520, 600, {
      faction: RED,
    });
    holding.order = {
      kind: 'move',
      waypoints: [{ x: 100, y: 600 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    const north = 'a:b:north' as FrontlineSegmentId;
    const south = 'a:b:south' as FrontlineSegmentId;
    world.frontlineSegments.set(north, {
      id: north,
      alliances: ['a', 'b'],
      position: { x: 330, y: 300 },
      normal: { x: 1, y: 0 },
      lengthKm: 60,
      updatedTick: 0,
    });
    world.frontlineSegments.set(south, {
      id: south,
      alliances: ['a', 'b'],
      position: { x: 540, y: 600 },
      normal: { x: 1, y: 0 },
      lengthKm: 60,
      updatedTick: 0,
    });
    retreating.frontlineSegment = north;
    holding.frontlineSegment = south;
    world.configureCampaign([], [
      {
        alliance: 'a',
        fallback: {
          until: Date.parse('1941-12-01T00:00:00Z'),
          line: [{ x: 500, y: 100 }, { x: 500, y: 900 }],
          rearOffsetKm: 20,
          rearward: { x: 1, y: 0 },
          influenceKm: 400,
        },
      },
    ]);
    const engine = new GameEngine(world, { aiAlliances: ['a'] });

    engine.step();

    expect(retreating.position.x).toBeLessThan(350);
    expect(holding.position.x).toBeGreaterThan(480);
    expect(Math.abs(retreating.position.y - holding.position.y)).toBeGreaterThan(250);
  });

  it('halts in winter, then attacks only sectors near the grand offensive', () => {
    const world = createTestWorld({ seed: 'campaign-offensive' });
    const near = addTestDivision(world, 'near', 680, 200, { faction: RED });
    const far = addTestDivision(world, 'far', 80, 800, { faction: RED });
    const nearId = 'a:b:near' as FrontlineSegmentId;
    const farId = 'a:b:far' as FrontlineSegmentId;
    world.frontlineSegments.set(nearId, {
      id: nearId,
      alliances: ['a', 'b'],
      position: { x: 700, y: 200 },
      normal: { x: 1, y: 0 },
      lengthKm: 60,
      updatedTick: 0,
    });
    world.frontlineSegments.set(farId, {
      id: farId,
      alliances: ['a', 'b'],
      position: { x: 100, y: 800 },
      normal: { x: 1, y: 0 },
      lengthKm: 60,
      updatedTick: 0,
    });
    near.frontlineSegment = nearId;
    far.frontlineSegment = farId;
    world.configureCampaign([], [
      {
        alliance: 'a',
        halt: {
          from: Date.parse('1941-06-01T00:00:00Z'),
          until: Date.parse('1941-07-01T00:00:00Z'),
          combatMultiplier: 0.8,
          recoveryMultiplier: 0.7,
        },
        offensive: {
          from: Date.parse('1941-07-01T00:00:00Z'),
          target: { x: 760, y: 200 },
          influenceKm: 300,
        },
      },
    ]);
    const engine = new GameEngine(world, { aiAlliances: ['a'] });

    engine.step();
    expect(near.position.x).toBeLessThan(700);

    world.clock.tick = TICKS_PER_DAY * 10;
    engine.step();
    expect(near.position.x).toBeGreaterThan(700);
    expect(far.position.x).toBeLessThan(100);
  });
});

describe('overrun', () => {
  it('punishes a router caught by a formed enemy', () => {
    const world = createTestWorld({ seed: 'overrun' });
    const router = addTestDivision(world, 'router', 300, 300, {
      faction: BLUE,
      stance: 'retreat',
      speedKmh: 1,
      organisation: 4,
    });
    router.order = {
      kind: 'move',
      waypoints: [{ x: 340, y: 300 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    addTestDivision(world, 'pursuer', 305, 300, { faction: RED });

    const engine = new GameEngine(world); // no AI needed
    const before = router.manpower;
    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();

    const after = world.getDivision(divisionId('router'));
    // It may bleed while escaping, but ordinary pursuit cannot delete it.
    expect(after).toBeDefined();
    expect(after!.manpower).toBeLessThan(before * 0.85);
    // And crucially, it never fought a battle to suffer this.
    expect(world.battles.size).toBe(0);
  });

  it('leaves an uncaught router alone', () => {
    const world = createTestWorld({ seed: 'overrun-free' });
    const router = addTestDivision(world, 'router', 300, 300, { faction: BLUE, stance: 'retreat' });
    addTestDivision(world, 'far', 380, 300, { faction: RED }); // 80 km away

    const engine = new GameEngine(world);
    const before = router.manpower;
    for (let i = 0; i < TICKS_PER_DAY; i++) engine.step();
    expect(router.manpower).toBe(before);
  });
});

describe('liquid frontline control', () => {
  function controlledWorld() {
    const world = createTestWorld({ seed: 'control' });
    addTestDivision(world, 'red-1', 150, 500, { faction: RED });
    addTestDivision(world, 'blue-1', 850, 500, { faction: BLUE });
    world.enableSupply(
      [
        {
          name: 'red-depot',
          alliance: 'a',
          position: { x: 100, y: 500 },
          rangeKm: 500,
          capturable: false,
        },
        {
          name: 'blue-depot',
          alliance: 'b',
          position: { x: 900, y: 500 },
          rangeKm: 500,
          capturable: false,
        },
      ],
      'temperate',
    );
    return world;
  }

  it('seeds initial ownership by physical proximity', () => {
    const world = controlledWorld();
    const field = world.supply!;
    const at = (x: number, y: number) => field.control[field.indexAt({ x, y })];

    expect(at(180, 500)).toBe(field.allianceIndex('a') + 1);
    expect(at(820, 500)).toBe(field.allianceIndex('b') + 1);
  });

  it('keeps water neutral', () => {
    const world = controlledWorld();
    const field = world.supply!;
    expect(field.control[field.indexAt({ x: 500, y: 500 })]).toBe(0);
  });

  it('flows ownership behind a physical advance', () => {
    const world = controlledWorld();
    const field = world.supply!;
    const red = world.getDivision(divisionId('red-1'))!;
    const probe = { x: 710, y: 300 };

    const engine = new GameEngine(world);
    engine.step();
    expect(field.control[field.indexAt(probe)]).toBe(field.allianceIndex('b') + 1);

    engine.issue({
      type: 'move',
      divisions: [red.id],
      destination: { x: 720, y: 300 },
      append: false,
    });
    red.speedKmh = 8;
    for (let i = 0; i < TICKS_PER_DAY * 8; i++) engine.step();

    expect(field.control[field.indexAt(probe)]).toBe(field.allianceIndex('a') + 1);
  });
});
