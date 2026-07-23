import { distance, normalize, type Vec2 } from '@core/math/vec2';
import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import type { Battle } from '@core/world/battle';
import { organisationRatio, strengthRatio, type Division } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { ENGAGEMENT_RANGE_KM } from './contactSystem';
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
const CASUALTIES_PER_ORG = 18;
/** Per-tick damage spread. Small on purpose — see the class comment. */
const VARIANCE = 0.12;
/**
 * Organisation ratio at which a locally pressured formation breaks.
 *
 * Raised from 0.16: a division should give ground and reform once its
 * cohesion is spent, not fight on to annihilation. Frontal combat is meant to
 * push the line back, not delete the formations holding it — that is what
 * encirclement is for.
 */
const BREAK_THRESHOLD = 0.26;
/** How far a broken formation falls back, in km. Far enough to shake pursuit. */
const RETREAT_DISTANCE_KM = 55;
/**
 * A division can commit its combat power to one neighbouring frontage slot.
 *
 * ContactSystem may group a long, connected front into one Battle for the UI,
 * but firepower must stay local. Without this constraint ten divisions at the
 * north end of a battle could erase one at the south end, and a weak sector
 * could never be penetrated by concentrating force.
 */
const FRONTAGE_RANGE_KM = ENGAGEMENT_RANGE_KM * 1.5;
const MAX_TARGETS_PER_DIVISION = 1;
/** Defence 20 is the neutral point used by the common test/template stats. */
const BASELINE_DEFENCE = 20;

/** A pursuer this close to a router is overrunning it. */
const OVERRUN_RANGE_KM = 10;
/**
 * Manpower a router loses per pursuer in range, per hour, as fraction of max.
 *
 * Lowered from 0.02: pursuit still hurts and still turns a sealed pocket into
 * a massacre (the encircled bleed on top of this in AttritionSystem), but a
 * formation making a fighting withdrawal on an open front now mostly escapes
 * to reform rather than being executed on the roads.
 */
const OVERRUN_MANPOWER_PER_HOUR = 0.008;
/** More than this many pursuers adds nothing — the roads are already cut. */
const OVERRUN_MAX_PURSUERS = 4;
/** Attacking across a major river is expensive. */
const RIVER_CROSSING_PENALTY = 0.65;
/** Preserve the proven 15-minute combat cadence inside a strategic tick. */
const COMBAT_SUBSTEP_HOURS = 0.25;

interface PressureAllocation {
  incoming: Map<DivisionId, number>;
  threats: Map<DivisionId, Division[]>;
}

interface BreakCandidate {
  division: Division;
  threats: Division[];
}

export class CombatSystem implements System {
  readonly name = 'combat';

  update(ctx: TickContext): void {
    const hours = ctx.dtSeconds / 3600;

    for (let elapsed = 0; elapsed < hours - 1e-9; elapsed += COMBAT_SUBSTEP_HOURS) {
      const slice = Math.min(COMBAT_SUBSTEP_HOURS, hours - elapsed);
      for (const battle of ctx.world.battles.values()) {
        this.resolve(battle, slice, ctx);
      }
      this.resolveOverruns(ctx, slice);
    }
  }

  /**
   * Pursuit. A retreating division is excluded from battles by design — but
   * the first version made that an *immunity*: you could drive a panzer
   * division clean through a routing enemy and neither side noticed, which
   * read on screen as "we pass over them". Exclusion from battle must not
   * mean exclusion from harm.
   *
   * So a router caught within {@link OVERRUN_RANGE_KM} of a formed enemy
   * takes one-sided losses, scaling with how many pursuers are on top of it.
   * This is where pockets become massacres and why pursuit is worth doing:
   * catching a broken enemy destroys it far faster than fighting it ever did.
   * Historically most of a beaten army's losses happened exactly here.
   */
  private resolveOverruns(ctx: TickContext, hours: number): void {
    const { world, events } = ctx;

    for (const d of [...world.divisions.values()]) {
      if (d.stance !== 'retreat') continue;

      const pursuers = world
        .divisionsNear(d.position.x, d.position.y, OVERRUN_RANGE_KM)
        .filter((o) => o.stance !== 'retreat' && world.hostile(d.faction, o.faction));
      if (!pursuers.length) continue;

      const pressure = Math.min(OVERRUN_MAX_PURSUERS, pursuers.length);
      const roll = world.rng.variance(VARIANCE);

      d.manpower = Math.max(
        0,
        d.manpower - d.maxManpower * OVERRUN_MANPOWER_PER_HOUR * pressure * roll * hours,
      );
      d.organisation = Math.max(0, d.organisation - d.maxOrganisation * 0.04 * pressure * hours);
      d.morale = Math.max(0, d.morale - 0.03 * pressure * hours);

      if (d.manpower <= d.maxManpower * 0.08) {
        world.divisions.delete(d.id);
        events.emit({ type: 'divisionDestroyed', division: d.id, position: { ...d.position } });
      }
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
    const powersA = this.unitPowers(world, unitsA, unitsB, weather);
    const powersB = this.unitPowers(world, unitsB, unitsA, weather);
    const powerA = sum(powersA.values());
    const powerB = sum(powersB.values());
    sideA.power = powerA;
    sideB.power = powerB;

    // A battle is an umbrella for the UI; damage is exchanged locally. Each
    // formation commits to its nearest enemy frontage slot, so concentration
    // creates a real breakthrough instead of merely nudging a global average.
    const ontoB = this.allocatePressure(unitsA, unitsB, powersA);
    const ontoA = this.allocatePressure(unitsB, unitsA, powersB);
    this.applyDamage(unitsB, ontoB.incoming, hours, ctx);
    this.applyDamage(unitsA, ontoA.incoming, hours, ctx);

    // Progress is the balance of remaining cohesion, smoothed so the bubble
    // does not jitter. 1 means side A is winning outright.
    const orgA = this.averageOrganisation(unitsA);
    const orgB = this.averageOrganisation(unitsB);
    const target = orgA + orgB > 0 ? orgA / (orgA + orgB) : 0.5;
    battle.progress += (target - battle.progress) * 0.15;

    // Collapse is local as well. The weakest formation breaks first; if two
    // exhausted opponents face one another, the first retreat removes the
    // pressure that would have made the other retreat in the same tick.
    const candidates = [
      ...this.breakCandidates(unitsA, powersA, ontoA),
      ...this.breakCandidates(unitsB, powersB, ontoB),
    ].sort(
      (a, b) =>
        organisationRatio(a.division) - organisationRatio(b.division) ||
        (a.division.id < b.division.id ? -1 : 1),
    );

    for (const candidate of candidates) {
      if (!world.getDivision(candidate.division.id) || candidate.division.stance === 'retreat') continue;
      const threats = candidate.threats.filter(
        (d) => world.getDivision(d.id) && d.stance !== 'retreat',
      );
      if (!threats.length) continue;
      this.breakOff(candidate.division, threats, ctx);
    }

    const activeA = unitsA.filter((d) => world.getDivision(d.id) && d.stance !== 'retreat');
    const activeB = unitsB.filter((d) => world.getDivision(d.id) && d.stance !== 'retreat');
    if (!activeA.length && activeB.length) this.emitDecision(battle, activeB, ctx);
    else if (!activeB.length && activeA.length) this.emitDecision(battle, activeA, ctx);
  }

  // ---------------------------------------------------------------- power --

  /** Combat power per formation, before it is assigned to a frontage slot. */
  private unitPowers(
    world: World,
    own: Division[],
    enemy: Division[],
    weather: number,
  ): Map<DivisionId, number> {
    const enemyHardness = enemy.reduce((sum, d) => sum + d.hardness, 0) / enemy.length;
    const powers = new Map<DivisionId, number>();

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

      const alliance = world.getFaction(d.faction)?.alliance;
      const campaign = alliance
        ? world.campaignModifiers(alliance).combat
        : 1;
      let power =
        raw *
        cohesion *
        committed *
        willing *
        supplied *
        veterancy *
        weather *
        campaign;

      // Posture is per formation, not per battle side. A reserve that is
      // holding its ground does not lose cover because a neighbour is moving.
      if (d.order === null) {
        power *= TERRAIN_PROFILES[world.terrain.sample(d.position)].defenceBonus;
      } else if (this.crossesRiver(world, d, enemy)) {
        power *= RIVER_CROSSING_PENALTY;
      }

      powers.set(d.id, power);
    }
    return powers;
  }

  /**
   * Assign each formation to its nearest hostile frontage slot.
   *
   * Power is conserved: a division cannot apply its full attack to several
   * enemies at once. Several divisions may choose the same target, which is
   * exactly how local superiority opens a hole in a continuous front.
   */
  private allocatePressure(
    sources: Division[],
    targets: Division[],
    powers: ReadonlyMap<DivisionId, number>,
  ): PressureAllocation {
    const incoming = new Map<DivisionId, number>();
    const threats = new Map<DivisionId, Division[]>();

    for (const source of sources) {
      const local = targets
        .filter((target) => distance(source.position, target.position) <= FRONTAGE_RANGE_KM)
        .sort(
          (a, b) =>
            distance(source.position, a.position) - distance(source.position, b.position) ||
            (a.id < b.id ? -1 : 1),
        )
        .slice(0, MAX_TARGETS_PER_DIVISION);
      if (!local.length) continue;

      const share = (powers.get(source.id) ?? 0) / local.length;
      for (const target of local) {
        incoming.set(target.id, (incoming.get(target.id) ?? 0) + share);
        const targetThreats = threats.get(target.id) ?? [];
        targetThreats.push(source);
        threats.set(target.id, targetThreats);
      }
    }

    return { incoming, threats };
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

  /** Applies the pressure assigned to each local frontage slot. */
  private applyDamage(
    units: Division[],
    incoming: ReadonlyMap<DivisionId, number>,
    hours: number,
    ctx: TickContext,
  ): void {
    for (const d of units) {
      const pressure = incoming.get(d.id) ?? 0;
      if (pressure <= 0) continue;

      const resilience = this.resilience(d, ctx.world);
      const damage =
        (pressure / resilience) *
        ctx.world.rng.variance(VARIANCE) *
        hours *
        ORG_DAMAGE_RATE *
        d.maxOrganisation *
        (d.encircled ? 1.5 : 1);
      const orgLost = Math.min(d.organisation, damage);
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

  /**
   * Defence absorbs pressure; holding good ground improves it further.
   *
   * `defence` used to be dead data. Anchoring the neutral point at 20 keeps
   * existing templates calibrated while making a high-defence formation and
   * prepared terrain visibly harder to dislodge.
   */
  private resilience(d: Division, world: World): number {
    const stat = 0.7 + 0.3 * clamp(d.defence / BASELINE_DEFENCE, 0.25, 2.5);
    const terrain =
      d.order === null
        ? Math.sqrt(TERRAIN_PROFILES[world.terrain.sample(d.position)].defenceBonus)
        : 1;
    return clamp(stat * terrain, 0.55, 2);
  }

  private breakCandidates(
    units: Division[],
    powers: ReadonlyMap<DivisionId, number>,
    pressure: PressureAllocation,
  ): BreakCandidate[] {
    const out: BreakCandidate[] = [];

    for (const d of units) {
      const incoming = pressure.incoming.get(d.id) ?? 0;
      const threats = pressure.threats.get(d.id) ?? [];
      if (incoming <= 0 || !threats.length) continue;

      // Numerical concentration causes an earlier loss of cohesion; a unit
      // with local support can hold below the nominal threshold for longer.
      const localOdds = incoming / Math.max(1e-6, powers.get(d.id) ?? 0);
      const threshold = BREAK_THRESHOLD * clamp(Math.sqrt(localOdds), 0.75, 1.5);
      if (organisationRatio(d) < threshold) out.push({ division: d, threats });
    }

    return out;
  }

  // -------------------------------------------------------------- retreat --

  /**
   * A broken formation disengages from the enemies pressuring its frontage.
   *
   * Retreat is a stance, not a deletion: the formation keeps its identity,
   * falls back along the vector away from the enemy centre, and ContactSystem
   * refuses to enrol it in a new battle while it withdraws. Without that flag
   * a retreating division walks 500 metres, comes back into range and is
   * immediately re-engaged, which reads as a unit being ground to nothing for
   * no reason the player can see.
   */
  private breakOff(d: Division, winners: Division[], ctx: TickContext): void {
    const vacated = { ...d.position };
    const centre = { x: 0, y: 0 };
    for (const w of winners) {
      centre.x += w.position.x;
      centre.y += w.position.y;
    }
    centre.x /= winners.length;
    centre.y /= winners.length;

    let away = normalize({ x: d.position.x - centre.x, y: d.position.y - centre.y });
    if (away.x === 0 && away.y === 0) {
      const attackHeading = winners[0]?.heading ?? 0;
      away = { x: Math.cos(attackHeading), y: Math.sin(attackHeading) };
    }
    const target: Vec2 = {
      x: d.position.x + away.x * RETREAT_DISTANCE_KM,
      y: d.position.y + away.y * RETREAT_DISTANCE_KM,
    };
    const safe = ctx.world.terrain.nearestPassable(target, 60) ?? d.position;

    d.order = { kind: 'move', waypoints: [safe], cursor: 0, bestDistance: Infinity, stalledTicks: 0 };
    d.advance = null;
    d.stance = 'retreat';
    ctx.events.emit({ type: 'divisionRetreating', division: d.id });

    // Winning attackers do not resume the strategic order that brought them
    // here. They enter a fresh ADVANCE transition, wait for this defender to
    // complete its physical retreat, then fill only the ground it vacated.
    for (const winner of winners) {
      const wasAttacking =
        winner.order !== null || winner.stance === 'move' || winner.stance === 'advance';
      if (!wasAttacking || winner.stance === 'retreat') continue;

      const blockedBy = winner.advance?.blockedBy ?? [];
      if (!blockedBy.includes(d.id)) blockedBy.push(d.id);
      winner.order = null;
      winner.advance = {
        target: vacated,
        blockedBy,
        phase: 'waiting',
      };
      winner.stance = 'advance';
    }
  }

  private emitDecision(battle: Battle, winners: Division[], ctx: TickContext): void {
    // The winner's old route has already been discarded by breakOff. Ground is
    // taken later by the explicit ADVANCE transition, never by teleporting or
    // silently resuming the pre-combat order.
    ctx.events.emit({
      type: 'battleDecided',
      battle: battle.id,
      position: { ...battle.position },
      winner: winners[0]?.faction ?? null,
    });
  }

  // ---------------------------------------------------------------- utils --

  private divisionsOf(world: World, side: Battle['sides'][number]): Division[] {
    const out: Division[] = [];
    for (const id of side.divisions) {
      const d = world.getDivision(id);
      if (d && d.stance !== 'retreat') out.push(d);
    }
    return out;
  }

  private averageOrganisation(units: Division[]): number {
    if (!units.length) return 0;
    return units.reduce((sum, d) => sum + organisationRatio(d), 0) / units.length;
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};
