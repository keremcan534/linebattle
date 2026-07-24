import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import type { FrontlineSegmentId } from '@core/world/frontline';
import { factionId } from '@core/world/ids';

const RED = factionId('red');
const BLUE = factionId('blue');

describe('strategic objectives', () => {
  it('stores at most three objectives of each kind and clears them independently', () => {
    const world = createTestWorld({ seed: 'objective-limit' });
    const engine = new GameEngine(world);

    for (let i = 0; i < 4; i++) {
      engine.issue({
        type: 'setObjective',
        alliance: 'a',
        kind: 'attack',
        position: { x: 100 + i * 50, y: 100 },
      });
      engine.issue({
        type: 'setObjective',
        alliance: 'a',
        kind: 'defense',
        position: { x: 100 + i * 50, y: 200 },
      });
    }
    expect(engine.flushCommandsWhilePaused()).toBe(true);

    const mine = [...world.strategicObjectives.values()].filter((o) => o.alliance === 'a');
    expect(mine.filter((o) => o.kind === 'attack')).toHaveLength(3);
    expect(mine.filter((o) => o.kind === 'defense')).toHaveLength(3);

    engine.issue({ type: 'clearObjectives', alliance: 'a', kind: 'attack' });
    expect(engine.flushCommandsWhilePaused()).toBe(true);
    expect([...world.strategicObjectives.values()].filter((o) => o.kind === 'attack')).toHaveLength(0);
    expect([...world.strategicObjectives.values()].filter((o) => o.kind === 'defense')).toHaveLength(3);
  });

  it('concentrates nearby formations onto sectors closest to an attack objective', () => {
    const world = createTestWorld({ seed: 'objective-concentration' });
    for (let i = 0; i < 12; i++) {
      addTestDivision(world, `red-${i}`, 220, 80 + i * 70, { faction: RED });
      addTestDivision(world, `blue-${i}`, 780, 80 + i * 70, { faction: BLUE });
    }
    world.enableSupply(
      [
        {
          name: 'red-depot',
          alliance: 'a',
          position: { x: 100, y: 500 },
          rangeKm: 650,
          capturable: false,
        },
        {
          name: 'blue-depot',
          alliance: 'b',
          position: { x: 900, y: 500 },
          rangeKm: 650,
          capturable: false,
        },
      ],
      'temperate',
    );

    const engine = new GameEngine(world);
    const objective = { x: 500, y: 100 };
    const assignedNear = () =>
      [...world.divisions.values()].filter((d) => {
        if (d.faction !== RED || !d.frontlineSegment) return false;
        const segment = world.frontlineSegments.get(d.frontlineSegment);
        return !!segment && Math.hypot(
          segment.position.x - objective.x,
          segment.position.y - objective.y,
        ) < 260;
      }).length;
    const before = assignedNear();
    const totalAssignmentDistance = () =>
      [...world.divisions.values()]
        .filter((d) => d.faction === RED && d.frontlineSegment)
        .reduce((sum, d) => {
          const segment = world.frontlineSegments.get(d.frontlineSegment!);
          return sum + (segment
            ? Math.hypot(segment.position.x - objective.x, segment.position.y - objective.y)
            : 0);
        }, 0);
    const beforeDistance = totalAssignmentDistance();

    engine.issue({
      type: 'setObjective',
      alliance: 'a',
      kind: 'attack',
      position: objective,
    });
    for (let i = 0; i <= 4; i++) engine.step();

    expect(totalAssignmentDistance()).toBeLessThan(beforeDistance);
    expect(assignedNear()).toBeGreaterThanOrEqual(before);
  });

  it('advances an assigned sector toward an unopposed attack objective', () => {
    const world = createTestWorld({ seed: 'objective-advance' });
    const division = addTestDivision(world, 'line', 100, 100, { faction: RED });
    const segmentId = 'a:b:5:1' as FrontlineSegmentId;
    world.frontlineSegments.set(segmentId, {
      id: segmentId,
      alliances: ['a', 'b'],
      position: { x: 300, y: 100 },
      normal: { x: 1, y: 0 },
      lengthKm: 60,
      updatedTick: 0,
    });
    division.frontlineSegment = segmentId;

    const engine = new GameEngine(world, { aiAlliances: ['a'] });
    engine.issue({
      type: 'setObjective',
      alliance: 'a',
      kind: 'attack',
      position: { x: 500, y: 100 },
    });
    engine.step(); // objective enters world after this review
    // Same game-time as before regardless of tick size: run a full day-count
    // of six-hour ticks so the sector has time to push toward the objective.
    while (world.clock.tick <= 24) engine.step();

    expect(division.position.x).toBeGreaterThan(300);
  });
});
