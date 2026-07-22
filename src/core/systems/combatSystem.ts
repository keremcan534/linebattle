import { distance, normalize, type Vec2 } from '@core/math/vec2';
import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import type { Battle, BattleSide } from '@core/world/battle';
import { organisationRatio, strengthRatio, type Division } from '@core/world/division';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/**
 * Combat resolution.
 *
 * The brief was explicit: results should follow from unit statistics, terrain,
 * supply, organisation, morale and experience, with a small random factor that
 * never makes combat feel unfair. That last clause drove the whole design.
 *
 * **Randomness modulates rate, not outcome.** Each tick applies a triangular
 * multiplier of ±12% to damage. A battle lasts dozens of ticks, so those rolls
 * average out and the stronger force wins reliably — variance decides whether
 * it takes eighteen hours or thirty, and what it costs. There is no single
 * die roll that can lose a battle a well-supplied veteran division should win.
 *
 * **Organisation is the currency, not manpower.** Divisions break long before
 * they are destroyed: a formation that has lost its cohesion stops being able
 * to fight and falls back, having lost perhaps a tenth of its men. Manpower
 * losses follow organisation losses at a fraction of the rate. This is why a
 * broken army can be reconstituted, and why encirclement — Milestone 3 — is
 * so much deadlier than frontal battle.
 */

/** Organisation points removed per unit of enemy power, per hour. */
const ORG_DAMAGE_RATE = 0.0075;
/** Men lost per point of organisation lost. */
const CASUALTIES_PER_ORG = 26;
/** Per-tick damage spread. Small on purpose — see the class comment. */
const VARIANCE = 0.12;
/** Below this average organisation, a side breaks off. */
const BREAK_THRESHOLD = 0.16;
/** How far a broken formation falls back, in km. */
const RETREAT_DISTANCE_KM = 30;
/** Attacking across a major river is expensive. */
const RIVER_CROSSING_PENALTY = 0.65;

export class CombatSystem implements System {
  readonly name = 'combat';

  update(ctx: TickContext): void {
    const hours = ctx.dtSeconds / 3600;

    for (const battle of ctx.world.battles.values()) {
      this.resolve(battle, hours, ctx);
    }
  }

  private resolve(battle: Battle, hours: number, ctx: TickContext): void {
    const { world } = ctx;

    const [sideA, sideB] = battle.sides;
    const unitsA = this.divisionsOf(world, sideA);
    const unitsB = this.divisionsOf(world, sideB);
    if (!unitsA.length || !unitsB.length) return;

    // Weather scales both sides equally: mud and frost do not take a side,
    // they just make everything cost more and take longer.
    const weather = world.weather.combat;
    const powerA = this.sidePower(world, unitsA, unitsB, sideA) * weather;
    const powerB = this.sidePower(world, unitsB, unitsA, sideB) * weather;
    sideA.power = powerA;
    sideB.power = powerB;

    // Each side's damage is rolled independently: a good hour for one is not
    // automatically a bad hour for the other.
    this.applyDamage(unitsB, powerA * world.rng.variance(VARIANCE) * hours, ctx);
    this.applyDamage(unitsA, powerB * world.rng.variance(VARIANCE) * hours, ctx);

    // Progress is the balance of remaining cohesion, smoothed so the bubble
    // does not jitter. 1 means side A is winning outright.
    const orgA = this.averageOrganisation(unitsA);
    const orgB = this.averageOrganisation(unitsB);
    const target = orgA + orgB > 0 ? orgA / (orgA + orgB) : 0.5;
    battle.progress += (target - battle.progress) * 0.15;

    if (orgA < BREAK_THRESHOLD && orgA < orgB) this.breakOff(unitsA, unitsB, ctx, battle);
    else if (orgB < BREAK_THRESHOLD && orgB < orgA) this.breakOff(unitsB, unitsA, ctx, battle);
  }

  // ---------------------------------------------------------------- power --

  /**
   * A side's combat power against a specific enemy.
   *
   * Every term is something the player can see in the unit panel, which is a
   * deliberate constraint: a player who loses a battle should be able to point
   * at the number that lost it.
   */
  private sidePower(world: World, own: Division[], enemy: Division[], side: BattleSide): number {
    const enemyHardness = enemy.reduce((sum, d) => sum + d.hardness, 0) / enemy.length;

    let total = 0;
    for (const d of own) {
      // Soft and hard attack blend by how armoured the enemy actually is.
      const raw = d.softAttack * (1 - enemyHardness) + d.hardAttack * enemyHardness;

      const cohesion = organisationRatio(d);
      const committed = strengthRatio(d);
      const willing = 0.4 + 0.6 * d.morale;
      // Supply is the harshest multiplier in the model. Barbarossa was lost to
      // logistics, and a game where that is a rounding error is telling a lie.
      const supplied = 0.25 + 0.75 * d.supply;
      const veterancy = 1 + 0.5 * d.experience;

      let power = raw * cohesion * committed * willing * supplied * veterancy;

      if (!side.attacking) {
        power *= TERRAIN_PROFILES[world.terrain.sample(d.position)].defenceBonus;
      } else if (this.crossesRiver(world, d, enemy)) {
        power *= RIVER_CROSSING_PENALTY;
      }

      total += power;
    }
    return total;
  }

  /**
   * Is this attacker pushing across a river?
   *
   * Sampled along the line to the nearest enemy rather than under the unit,
   * because a river only matters if it is *between* you and them — which is
   * exactly why rivers live in their own mask rather than as a terrain class.
   */
  private crossesRiver(world: World, attacker: Division, enemy: Division[]): boolean {
    let nearest: Division | undefined;
    let best = Infinity;
    for (const e of enemy) {
      const d = distance(attacker.position, e.position);
      if (d < best) {
        best = d;
        nearest = e;
      }
    }
    if (!nearest) return false;

    const steps = 6;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const point: Vec2 = {
        x: attacker.position.x + (nearest.position.x - attacker.position.x) * t,
        y: attacker.position.y + (nearest.position.y - attacker.position.y) * t,
      };
      if (world.terrain.riverAt(point) > 140) return true;
    }
    return false;
  }

  // --------------------------------------------------------------- damage --

  /** Spreads incoming damage across a side, weighted towards fresher units. */
  private applyDamage(units: Division[], damage: number, ctx: TickContext): void {
    if (damage <= 0) return;

    const weights = units.map((d) => 0.2 + organisationRatio(d));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) return;

    for (let i = 0; i < units.length; i++) {
      const d = units[i]!;
      const share = (weights[i]! / totalWeight) * damage * ORG_DAMAGE_RATE * d.maxOrganisation;
      const orgLost = Math.min(d.organisation, share);
      d.organisation -= orgLost;

      const casualties = Math.min(d.manpower, orgLost * CASUALTIES_PER_ORG);
      d.manpower -= casualties;

      // Bleeding men costs the will to keep going, slowly.
      d.morale = Math.max(0, d.morale - (casualties / d.maxManpower) * 0.5);

      if (d.manpower <= d.maxManpower * 0.08) {
        ctx.world.divisions.delete(d.id);
        ctx.events.emit({ type: 'divisionDestroyed', division: d.id, position: { ...d.position } });
      }
    }
  }

  // -------------------------------------------------------------- retreat --

  /**
   * A broken side disengages.
   *
   * Retreat is a stance, not a deletion: the formation keeps its identity,
   * falls back along the vector away from the enemy centre, and ContactSystem
   * refuses to enrol it in a new battle while it withdraws. Without that flag
   * a retreating division walks 500 metres, comes back into range and is
   * immediately re-engaged, which reads as a unit being ground to nothing for
   * no reason the player can see.
   */
  private breakOff(losers: Division[], winners: Division[], ctx: TickContext, battle: Battle): void {
    const centre = { x: 0, y: 0 };
    for (const w of winners) {
      centre.x += w.position.x;
      centre.y += w.position.y;
    }
    centre.x /= winners.length;
    centre.y /= winners.length;

    for (const d of losers) {
      const away = normalize({ x: d.position.x - centre.x, y: d.position.y - centre.y });
      const target: Vec2 = {
        x: d.position.x + away.x * RETREAT_DISTANCE_KM,
        y: d.position.y + away.y * RETREAT_DISTANCE_KM,
      };
      const safe = ctx.world.terrain.nearestPassable(target, 60) ?? d.position;

      d.order = { kind: 'move', waypoints: [safe], cursor: 0, bestDistance: Infinity, stalledTicks: 0 };
      d.stance = 'retreat';
      ctx.events.emit({ type: 'divisionRetreating', division: d.id });
    }

    // The winner keeps whatever orders it had; ground is taken by advancing
    // into it, not by the battle resolving.
    ctx.events.emit({
      type: 'battleDecided',
      battle: battle.id,
      position: { ...battle.position },
      winner: winners[0]?.faction ?? null,
    });
  }

  // ---------------------------------------------------------------- utils --

  private divisionsOf(world: World, side: BattleSide): Division[] {
    const out: Division[] = [];
    for (const id of side.divisions) {
      const d = world.getDivision(id);
      if (d) out.push(d);
    }
    return out;
  }

  private averageOrganisation(units: Division[]): number {
    if (!units.length) return 0;
    return units.reduce((sum, d) => sum + organisationRatio(d), 0) / units.length;
  }
}
