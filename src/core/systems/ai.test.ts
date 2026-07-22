import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { divisionId, factionId } from '@core/world/ids';
import { hashWorld } from '@core/world/worldHash';

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
    addTestDivision(world, 'red-1', 300, 300, { faction: RED });
    const blue = addTestDivision(world, 'blue-1', 308, 300, { faction: BLUE });

    const engine = aiEngine(world);
    engine.issue({ type: 'move', divisions: [blue.id], destination: { x: 900, y: 900 }, append: false });

    for (let i = 0; i < 26; i++) engine.step(); // past two AI reviews
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
    // Either it bled hard while escaping or it was destroyed outright —
    // what it can no longer do is stroll away untouched.
    expect(!after || after.manpower < before * 0.85).toBe(true);
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

describe('political control', () => {
  function controlledWorld() {
    const world = createTestWorld({ seed: 'control' });
    addTestDivision(world, 'red-1', 150, 500, { faction: RED });
    addTestDivision(world, 'blue-1', 850, 500, { faction: BLUE });
    world.enableSupply(
      [
        { name: 'red-depot', alliance: 'a', position: { x: 100, y: 500 }, rangeKm: 500, capturable: false },
        { name: 'blue-depot', alliance: 'b', position: { x: 900, y: 500 }, rangeKm: 500, capturable: false },
      ],
      'temperate',
    );
    return world;
  }

  it('seeds initial ownership by proximity', () => {
    const world = controlledWorld();
    const field = world.supply!;
    const at = (x: number, y: number) => field.control[field.indexAt({ x, y })];
    expect(at(180, 500)).toBe(field.allianceIndex('a') + 1);
    expect(at(820, 500)).toBe(field.allianceIndex('b') + 1);
  });

  it('keeps the sea neutral', () => {
    const world = controlledWorld();
    const field = world.supply!;
    expect(field.control[field.indexAt({ x: 500, y: 500 })]).toBe(0); // the lake
  });

  it('flips territory as an army advances through it', () => {
    const world = controlledWorld();
    const field = world.supply!;
    const red = world.getDivision(divisionId('red-1'))!;
    const probe = { x: 700, y: 300 }; // north of the lake, blue side at start

    const engine = new GameEngine(world);
    engine.step();
    expect(field.control[field.indexAt(probe)]).toBe(field.allianceIndex('b') + 1);

    // March red across the north and let presence + the logistics sweep work.
    engine.issue({ type: 'move', divisions: [red.id], destination: { x: 720, y: 300 }, append: false });
    red.speedKmh = 8; // brisk, to keep the test fast
    for (let i = 0; i < TICKS_PER_DAY * 8; i++) engine.step();

    expect(field.control[field.indexAt(probe)]).toBe(field.allianceIndex('a') + 1);
  });
});
