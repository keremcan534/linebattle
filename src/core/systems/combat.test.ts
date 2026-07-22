import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { organisationRatio } from '@core/world/division';
import { divisionId, factionId } from '@core/world/ids';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { ENGAGEMENT_RANGE_KM } from './contactSystem';

const RED = factionId('red');
const BLUE = factionId('blue');

/** Runs a fight to a conclusion and reports who was left standing. */
function fight(
  setup: (world: ReturnType<typeof createTestWorld>) => void,
  maxDays = 10,
  seed = 'combat',
  /** Keep stepping after the battle ends, to observe the aftermath. */
  settle = false,
) {
  const world = createTestWorld({ seed });
  setup(world);
  const engine = new GameEngine(world);

  const events: string[] = [];
  engine.events.onAny((e) => {
    if (e.type !== 'tick') events.push(e.type);
  });

  let ticks = 0;
  for (; ticks < TICKS_PER_DAY * maxDays; ticks++) {
    engine.step();
    if (!settle && ticks > 4 && world.battles.size === 0) break;
  }

  const survivors = [...world.divisions.values()];
  return { world, engine, events, ticks, survivors };
}

describe('ContactSystem', () => {
  it('starts a battle when hostile divisions come into range', () => {
    const { world, events } = fight((w) => {
      addTestDivision(w, 'red-1', 200, 200, { faction: RED });
      addTestDivision(w, 'blue-1', 205, 200, { faction: BLUE });
    }, 1);

    expect(events).toContain('battleStarted');
    expect(world.battles.size + 1).toBeGreaterThan(0);
  });

  it('leaves distant divisions alone', () => {
    const world = createTestWorld();
    addTestDivision(world, 'red-1', 100, 100, { faction: RED });
    addTestDivision(world, 'blue-1', 100 + ENGAGEMENT_RANGE_KM * 3, 100, { faction: BLUE });
    const engine = new GameEngine(world);
    for (let i = 0; i < 20; i++) engine.step();
    expect(world.battles.size).toBe(0);
  });

  it('never puts allies on opposing sides', () => {
    const world = createTestWorld();
    addTestDivision(world, 'red-1', 200, 200, { faction: RED });
    addTestDivision(world, 'red-2', 206, 200, { faction: RED });
    addTestDivision(world, 'blue-1', 210, 200, { faction: BLUE });
    const engine = new GameEngine(world);
    engine.step();

    for (const battle of world.battles.values()) {
      const [a, b] = battle.sides;
      expect(a.alliance).not.toBe(b.alliance);
      for (const id of a.divisions) expect(b.divisions).not.toContain(id);
    }
  });

  it('merges a whole sector into one engagement rather than many duels', () => {
    // Transitive clustering: a continuous front should read as one battle.
    const world = createTestWorld();
    for (let i = 0; i < 4; i++) {
      addTestDivision(world, `red-${i}`, 200, 200 + i * 10, { faction: RED });
      addTestDivision(world, `blue-${i}`, 208, 200 + i * 10, { faction: BLUE });
    }
    const engine = new GameEngine(world);
    engine.step();
    expect(world.battles.size).toBe(1);
  });
});

describe('CombatSystem', () => {
  it('is decided by strength, not by luck', () => {
    // The headline fairness claim. A strong, supplied, veteran division must
    // beat a weak one every time, across many seeds — not most of the time.
    let strongWon = 0;
    const trials = 25;

    for (let t = 0; t < trials; t++) {
      const { world } = fight(
        (w) => {
          addTestDivision(w, 'strong', 200, 200, {
            faction: RED, softAttack: 40, defence: 40, experience: 0.8, morale: 0.95, supply: 1,
          });
          addTestDivision(w, 'weak', 206, 200, {
            faction: BLUE, softAttack: 16, defence: 18, experience: 0.1, morale: 0.5, supply: 0.4,
          });
        },
        14,
        `trial-${t}`,
      );

      const strong = world.getDivision(divisionId('strong'));
      const weak = world.getDivision(divisionId('weak'));
      const strongHealthier =
        !!strong && (!weak || organisationRatio(strong) > organisationRatio(weak));
      if (strongHealthier) strongWon++;
    }

    expect(strongWon).toBe(trials);
  });

  it('varies how long a battle takes, not who wins it', () => {
    // The other half of the claim: randomness must actually do something.
    const durations = new Set<number>();
    for (let t = 0; t < 8; t++) {
      const { ticks } = fight(
        (w) => {
          addTestDivision(w, 'a', 200, 200, { faction: RED, softAttack: 30, defence: 30 });
          addTestDivision(w, 'b', 206, 200, { faction: BLUE, softAttack: 26, defence: 26 });
        },
        20,
        `duration-${t}`,
      );
      durations.add(ticks);
    }
    expect(durations.size).toBeGreaterThan(1);
  });

  it('spends organisation far faster than manpower', () => {
    // Divisions break before they are destroyed. If a battle routinely wiped
    // out men, the operational layer would collapse into attrition.
    const { world } = fight((w) => {
      addTestDivision(w, 'a', 200, 200, { faction: RED });
      addTestDivision(w, 'b', 206, 200, { faction: BLUE });
    }, 6);

    for (const d of world.divisions.values()) {
      const orgLost = 1 - organisationRatio(d);
      const menLost = 1 - d.manpower / d.maxManpower;
      if (orgLost > 0.2) expect(menLost).toBeLessThan(orgLost);
      expect(menLost).toBeLessThan(0.6);
    }
  });

  it('rewards defending in good terrain', () => {
    // Same units, same seed; only the defender's ground differs. The forest
    // block in the test world is at cells 10..30 x 60..80 => km 100..300 x 600..800.
    const outcome = (x: number, y: number) => {
      const { world } = fight(
        (w) => {
          const atk = addTestDivision(w, 'atk', x - 6, y, { faction: RED, softAttack: 34, defence: 30 });
          addTestDivision(w, 'def', x, y, { faction: BLUE, softAttack: 30, defence: 30 });
          // Only the attacker has orders, so only the defender gets terrain.
          atk.order = { kind: 'move', waypoints: [{ x: x + 40, y }], cursor: 0, bestDistance: Infinity, stalledTicks: 0 };
          atk.stance = 'move';
        },
        8,
        'terrain',
      );
      const def = world.getDivision(divisionId('def'));
      return def ? organisationRatio(def) : 0;
    };

    const inForest = outcome(200, 700);
    const inOpen = outcome(500, 200);
    expect(inForest).toBeGreaterThan(inOpen);
  });

  it('breaks the loser off instead of grinding it to nothing', () => {
    const { world, events } = fight((w) => {
      addTestDivision(w, 'strong', 200, 200, { faction: RED, softAttack: 45, defence: 45, morale: 0.95 });
      addTestDivision(w, 'weak', 206, 200, { faction: BLUE, softAttack: 12, defence: 14, morale: 0.4, supply: 0.3 });
    }, 12);

    expect(events).toContain('divisionRetreating');
    const weak = world.getDivision(divisionId('weak'));
    // It survived, broken but reconstitutable — that is the point.
    expect(weak).toBeDefined();
    expect(weak!.stance).toBe('retreat');
  });

  it('lets a retreating division actually escape', () => {
    // Regression guard: without the retreat stance the loser walks a few
    // hundred metres, re-enters contact and is destroyed for no visible reason.
    const { world } = fight(
      (w) => {
        addTestDivision(w, 'strong', 200, 200, { faction: RED, softAttack: 45, defence: 45 });
        addTestDivision(w, 'weak', 206, 200, { faction: BLUE, softAttack: 12, defence: 14, supply: 0.3 });
      },
      20,
      'combat',
      true, // keep running past the break-off, which is the whole point
    );

    const weak = world.getDivision(divisionId('weak'));
    expect(weak).toBeDefined();
    const strong = world.getDivision(divisionId('strong'))!;
    const gap = Math.hypot(weak!.position.x - strong.position.x, weak!.position.y - strong.position.y);
    expect(gap).toBeGreaterThan(ENGAGEMENT_RANGE_KM);
    // And it must not be dragged straight back into a new battle.
    expect(world.battles.size).toBe(0);
  });

  it('ends the battle once the sides separate', () => {
    const { world, events } = fight((w) => {
      addTestDivision(w, 'strong', 200, 200, { faction: RED, softAttack: 45, defence: 45 });
      addTestDivision(w, 'weak', 206, 200, { faction: BLUE, softAttack: 12, defence: 14, supply: 0.3 });
    }, 20);

    expect(events).toContain('battleEnded');
    expect(world.battles.size).toBe(0);
  });

  it('removes a division whose manpower finally runs out', () => {
    // A single battle CANNOT annihilate a division, by design: organisation
    // breaks at 16% and a full bar of organisation is worth only ~13% of a
    // division's men, so the loser always retreats first. Destruction is the
    // end of a long campaign of maulings — or, from Milestone 3, of
    // encirclement. So this tests the floor directly rather than pretending
    // one engagement can reach it.
    const { world, events } = fight((w) => {
      for (let i = 0; i < 4; i++) {
        addTestDivision(w, `red-${i}`, 200, 196 + i * 3, { faction: RED, softAttack: 60, defence: 50 });
      }
      addTestDivision(w, 'remnant', 206, 200, {
        faction: BLUE, softAttack: 4, defence: 4, morale: 0.2, supply: 0.1,
        manpower: 900, // 9% of maxManpower — one bad hour from gone
      });
    }, 20);

    expect(events).toContain('divisionDestroyed');
    expect(world.getDivision(divisionId('remnant'))).toBeUndefined();
  });
});
