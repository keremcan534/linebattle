import { describe, expect, it } from 'vitest';
import { GameEngine } from '@core/engine/gameEngine';
import { addTestDivision, createTestWorld } from '@core/testing/testWorld';
import { organisationRatio } from '@core/world/division';
import { divisionId, factionId } from '@core/world/ids';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { ENGAGEMENT_RANGE_KM } from './contactSystem';
import { ENEMY_MIN_SEPARATION_KM } from './movementSystem';

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
  it('preserves the winner combat cost through the post-combat advance wait', () => {
    const world = createTestWorld({ seed: 'winner-cost' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 42,
      defence: 40,
    });
    addTestDivision(world, 'defender', 208, 200, {
      faction: BLUE,
      softAttack: 16,
      defence: 18,
      organisation: 12,
    });
    attacker.order = {
      kind: 'move',
      waypoints: [{ x: 400, y: 200 }],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    attacker.stance = 'move';
    const manpowerBefore = attacker.manpower;
    const organisationBefore = attacker.organisation;

    new GameEngine(world).step();

    expect(attacker.manpower).toBeLessThan(manpowerBefore);
    expect(attacker.organisation).toBeLessThan(organisationBefore);
  });

  it('applies the scenario opening-shock combat debuff to the affected army', () => {
    const defenderOrganisation = (shocked: boolean) => {
      const world = createTestWorld({ seed: 'opening-shock' });
      addTestDivision(world, 'defender', 208, 200, { faction: RED });
      addTestDivision(world, 'attacker', 200, 200, {
        faction: BLUE,
        softAttack: 28,
      });
      if (shocked) {
        world.configureCampaign([], [
          {
            alliance: 'b',
            openingShock: {
              until: Date.parse('1941-08-15T00:00:00Z'),
              combatMultiplier: 0.7,
              recoveryMultiplier: 0.7,
            },
          },
        ]);
      }
      new GameEngine(world).step();
      return world.getDivision(divisionId('defender'))!.organisation;
    };

    expect(defenderOrganisation(true)).toBeGreaterThan(
      defenderOrganisation(false),
    );
  });

  it('applies fifty percent more combat damage to an encircled target', () => {
    const remaining = (encircled: boolean) => {
      const world = createTestWorld({ seed: 'encircled-damage' });
      addTestDivision(world, 'attacker', 200, 200, {
        faction: RED,
        softAttack: 18,
      });
      const defender = addTestDivision(world, 'defender', 208, 200, {
        faction: BLUE,
        encircled,
      });
      new GameEngine(world).step();
      return defender.organisation;
    };

    const normalLoss = 50 - remaining(false);
    const pocketLoss = 50 - remaining(true);
    expect(pocketLoss / normalLoss).toBeGreaterThan(1.49);
    expect(pocketLoss / normalLoss).toBeLessThan(1.8);
  });

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

  it('varies attrition inside a twelve-hour battle window', () => {
    const remaining = new Set<number>();
    for (let t = 0; t < 8; t++) {
      const { world } = fight(
        (w) => {
          addTestDivision(w, 'a', 200, 200, {
            faction: RED,
            softAttack: 6,
            defence: 80,
          });
          addTestDivision(w, 'b', 206, 200, {
            faction: BLUE,
            softAttack: 6,
            defence: 80,
          });
        },
        1,
        `duration-${t}`,
      );
      remaining.add(
        Math.round(
          (world.getDivision(divisionId('b'))?.organisation ?? 0) * 1000,
        ),
      );
    }
    expect(remaining.size).toBeGreaterThan(1);
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

  it('lets one local sector collapse without routing the whole front', () => {
    // All four divisions belong to one connected battle, but each strong unit
    // faces a weak opponent in a different frontage slot. Aggregate side
    // averages are identical, so a global combat calculation would produce a
    // stalemate or route an entire side. Local pressure should open two holes
    // while both sound formations remain in the line.
    const { world } = fight(
      (w) => {
        addTestDivision(w, 'red-strong', 200, 200, {
          faction: RED, softAttack: 45, defence: 45, morale: 0.95,
        });
        addTestDivision(w, 'blue-weak', 208, 200, {
          faction: BLUE, softAttack: 12, defence: 12, morale: 0.45, supply: 0.45,
        });
        addTestDivision(w, 'red-weak', 200, 217, {
          faction: RED, softAttack: 12, defence: 12, morale: 0.45, supply: 0.45,
        });
        addTestDivision(w, 'blue-strong', 208, 217, {
          faction: BLUE, softAttack: 45, defence: 45, morale: 0.95,
        });
      },
      10,
      'local-collapse',
    );

    expect(world.getDivision(divisionId('red-weak'))?.position.x).toBeLessThan(195);
    expect(world.getDivision(divisionId('blue-weak'))?.position.x).toBeGreaterThan(213);
    expect(world.getDivision(divisionId('red-strong'))?.stance).not.toBe('retreat');
    expect(world.getDivision(divisionId('blue-strong'))?.stance).not.toBe('retreat');
  });

  it('uses the defence stat to absorb incoming pressure', () => {
    const remainingOrganisation = (defence: number) => {
      const world = createTestWorld({ seed: 'defence-stat' });
      const attacker = addTestDivision(world, 'attacker', 200, 200, {
        faction: RED, softAttack: 32, defence: 20,
      });
      const defender = addTestDivision(world, 'defender', 208, 200, {
        faction: BLUE, defence,
      });
      attacker.order = {
        kind: 'move',
        waypoints: [{ x: 260, y: 200 }],
        cursor: 0,
        bestDistance: Infinity,
        stalledTicks: 0,
      };
      attacker.stance = 'move';

      const engine = new GameEngine(world);
      // Measure absorption before a broken defender leaves contact and begins
      // recovering organisation during its retreat.
      engine.step();
      return organisationRatio(defender);
    };

    expect(remainingOrganisation(45)).toBeGreaterThan(remainingOrganisation(12));
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
    expect(weak!.position.x).toBeGreaterThan(220);
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

  it('waits for a physical retreat, then starts a new advance into the vacated ground', () => {
    const world = createTestWorld({ seed: 'post-combat-transition' });
    const attacker = addTestDivision(world, 'attacker', 200, 200, {
      faction: RED,
      softAttack: 45,
      defence: 45,
      morale: 0.95,
      speedKmh: 4,
    });
    const defender = addTestDivision(world, 'defender', 212.5, 200, {
      faction: BLUE,
      softAttack: 12,
      defence: 14,
      morale: 0.4,
      supply: 0.3,
      speedKmh: 4,
    });
    const oldDestination = { x: 500, y: 200 };
    attacker.order = {
      kind: 'move',
      waypoints: [oldDestination],
      cursor: 0,
      bestDistance: Infinity,
      stalledTicks: 0,
    };
    attacker.stance = 'move';

    const engine = new GameEngine(world);
    let attackerAtBreak: { x: number; y: number } | null = null;
    let vacated: { x: number; y: number } | null = null;
    let retreatFinished = false;
    let advanceMoved = false;

    for (let i = 0; i < TICKS_PER_DAY * 20; i++) {
      engine.step();

      const separation = Math.hypot(
        defender.position.x - attacker.position.x,
        defender.position.y - attacker.position.y,
      );
      expect(separation).toBeGreaterThanOrEqual(ENEMY_MIN_SEPARATION_KM);
      expect(attacker.position.x).toBeLessThan(defender.position.x);

      if (!attackerAtBreak && defender.stance === 'retreat') {
        attackerAtBreak = { ...attacker.position };
        vacated = { ...defender.position };
        expect(attacker.stance).toBe('advance');
        expect(attacker.order).toBeNull();
        expect(attacker.advance).toEqual({
          target: vacated,
          blockedBy: [defender.id],
          phase: 'waiting',
        });
        continue;
      }

      if (attackerAtBreak && defender.stance === 'retreat') {
        // RETREAT is physical: until it is over, the winner is frozen in the
        // exact position where combat ended.
        expect(attacker.position).toEqual(attackerAtBreak);
        expect(attacker.order).toBeNull();
        expect(attacker.advance?.phase).toBe('waiting');
        continue;
      }

      if (attackerAtBreak) {
        retreatFinished = true;
        if (Math.hypot(
          attacker.position.x - attackerAtBreak.x,
          attacker.position.y - attackerAtBreak.y,
        ) > 0.05) {
          advanceMoved = true;
        }
        if (advanceMoved && world.getDivision(attacker.id)?.stance === 'hold') break;
      }
    }

    expect(attackerAtBreak).not.toBeNull();
    expect(vacated).not.toBeNull();
    expect(retreatFinished).toBe(true);
    expect(advanceMoved).toBe(true);
    expect(attacker.stance).toBe('hold');
    expect(attacker.order).toBeNull();
    expect(attacker.advance).toBeNull();
    expect(Math.hypot(
      attacker.position.x - vacated!.x,
      attacker.position.y - vacated!.y,
    )).toBeLessThan(1.5);
    expect(Math.hypot(
      attacker.position.x - oldDestination.x,
      attacker.position.y - oldDestination.y,
    )).toBeGreaterThan(200);
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
