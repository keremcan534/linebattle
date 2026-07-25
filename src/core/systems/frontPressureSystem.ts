import { sectorPosition } from '@core/front/frontSector';
import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import { activeHalt } from '@core/world/campaign';
import { organisationRatio, strengthRatio, type Division } from '@core/world/division';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Share of an adjacent sector's power that supports its neighbour. */
const NEIGHBOUR_SUPPORT = 0.3;
/** Local superiority required before the line starts to move at all. */
const ADVANCE_RATIO = 1.15;
/** Advance km per game-day per point of superiority beyond the threshold. */
const KM_PER_DAY_PER_RATIO = 26;
/** No sector may ever move faster than this, whatever the odds. */
const MAX_ADVANCE_KM_PER_DAY = 30;
/**
 * Elastic coupling between neighbours, per game-day.
 *
 * This is what makes an offensive a broad salient instead of a needle: a
 * sector that pushes ahead drags its neighbours forward, and one that lags is
 * pulled along by them.
 */
const NEIGHBOUR_COUPLING_PER_DAY = 0.55;
/**
 * Hard limit on the step between adjacent sectors.
 *
 * The frontline is continuous by construction: no amount of local superiority
 * can tear a hole in it or produce a zigzag, because the geometry is clamped
 * after every tick.
 */
const MAX_NEIGHBOUR_STEP_KM = 45;
/** A formation in transit fights at this fraction of its power. */
const TRANSFER_POWER = 0.3;
/** Organisation lost per game-day by an evenly matched, fully engaged sector. */
const ORG_LOSS_PER_DAY = 0.16;
/** Manpower lost per game-day, as a fraction of establishment, when engaged. */
const MANPOWER_LOSS_PER_DAY = 0.012;
/** Readiness spent per game-day in contact, and regained per day out of it. */
const READINESS_LOSS_PER_DAY = 0.1;
const READINESS_GAIN_PER_DAY = 0.07;
const MIN_READINESS = 0.15;

/**
 * Resolves the front as a line of ordered sectors.
 *
 * Divisions never manoeuvre here. Each sector totals the power of the
 * formations assigned to it, borrows a little from its neighbours, and the
 * resulting imbalance moves that stretch of the line. Coupling and a hard
 * gradient clamp keep the result a coherent, continuous front that bulges into
 * broad salients — the shape the historical maps show — rather than a scatter
 * of individual battles.
 */
export class FrontPressureSystem implements System {
  readonly name = 'frontPressure';

  update(ctx: TickContext): void {
    const { world } = ctx;
    const front = world.front;
    if (!front) return;
    const days = ctx.dtSeconds / 86_400;
    const sectors = front.sectors;

    // Divisions by sector and side. Deterministic: index order, then id order.
    const west: Division[][] = sectors.map(() => []);
    const east: Division[][] = sectors.map(() => []);
    for (const d of world.divisions.values()) {
      if (d.sector === null || d.deployment === 'reserve') continue;
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;
      const bucket =
        alliance === front.westAlliance
          ? west[d.sector]
          : alliance === front.eastAlliance
            ? east[d.sector]
            : undefined;
      bucket?.push(d);
    }

    const ownWest = sectors.map((_, i) => this.sectorPower(world, west[i]!));
    const ownEast = sectors.map((_, i) => this.sectorPower(world, east[i]!));
    const effWest = this.withNeighbourSupport(ownWest);
    const effEast = this.withNeighbourSupport(ownEast);

    const westHalted = !!activeHalt(
      world.campaignPlans.get(front.westAlliance),
      world.clock.date,
    );
    const eastHalted = !!activeHalt(
      world.campaignPlans.get(front.eastAlliance),
      world.clock.date,
    );

    for (let i = 0; i < sectors.length; i++) {
      const sector = sectors[i]!;
      const w = effWest[i]!;
      const e = effEast[i]!;

      if (w <= 0 && e <= 0) {
        sector.pressure = 0;
        continue;
      }

      const position = sectorPosition(sector);
      const terrain = TERRAIN_PROFILES[world.terrain.sample(position)];
      const westAttacks = w > e;
      const attacker = westAttacks ? w : e;
      const defender = westAttacks ? e : w;
      const halted = westAttacks ? westHalted : eastHalted;

      // An unopposed sector still only creeps forward: there is ground to
      // occupy, not an enemy to rout.
      const ratio =
        defender > 0
          ? attacker / (defender * terrain.defenceBonus)
          : ADVANCE_RATIO + 0.6;
      sector.pressure = westAttacks ? ratio : -ratio;

      if (!halted && ratio > ADVANCE_RATIO) {
        const rate = Math.min(
          MAX_ADVANCE_KM_PER_DAY,
          (ratio - ADVANCE_RATIO) * KM_PER_DAY_PER_RATIO,
        );
        const terrainRate = terrain.moveMultiplier > 0 ? terrain.moveMultiplier : 0;
        sector.advanceKm +=
          (westAttacks ? 1 : -1) *
          rate *
          terrainRate *
          world.weather.movement *
          days;
      }

      this.applyAttrition(west[i]!, w, e, days);
      this.applyAttrition(east[i]!, e, w, days);
    }

    this.relaxLine(sectors, days);
  }

  /** Combat power a division contributes to its sector. */
  private divisionPower(world: World, d: Division): number {
    const attack = d.softAttack * (1 - d.hardness) + d.hardAttack * d.hardness;
    const alliance = world.getFaction(d.faction)?.alliance;
    const campaign = alliance ? world.campaignModifiers(alliance).combat : 1;
    const power =
      attack *
      strengthRatio(d) *
      organisationRatio(d) *
      (0.4 + 0.6 * d.morale) *
      (0.35 + 0.65 * d.supply) *
      d.equipmentRatio *
      (0.5 + 0.5 * d.readiness) *
      (1 + 0.4 * d.experience) *
      campaign *
      world.weather.combat;
    return d.deployment === 'transferring' ? power * TRANSFER_POWER : power;
  }

  private sectorPower(world: World, divisions: readonly Division[]): number {
    let total = 0;
    for (const d of divisions) total += this.divisionPower(world, d);
    return total;
  }

  /** Adds bounded support from each immediate neighbour. */
  private withNeighbourSupport(own: readonly number[]): number[] {
    return own.map((value, i) => {
      const left = i > 0 ? own[i - 1]! : 0;
      const right = i + 1 < own.length ? own[i + 1]! : 0;
      return value + NEIGHBOUR_SUPPORT * (left + right);
    });
  }

  /**
   * Bleeds the formations holding a contested sector.
   *
   * Loss scales with the share of local power the enemy holds, so the weaker
   * side always suffers more without any side ever being wiped out in a tick.
   */
  private applyAttrition(
    divisions: readonly Division[],
    own: number,
    enemy: number,
    days: number,
  ): void {
    if (!divisions.length) return;

    if (enemy <= 0 || own <= 0) {
      for (const d of divisions) {
        d.readiness = Math.min(1, d.readiness + READINESS_GAIN_PER_DAY * days);
      }
      return;
    }

    // 0.5 when evenly matched, →1 when badly outgunned, →0 when dominant.
    const share = enemy / (own + enemy);
    for (const d of divisions) {
      d.organisation = Math.max(
        0,
        d.organisation - d.maxOrganisation * ORG_LOSS_PER_DAY * 2 * share * days,
      );
      d.manpower = Math.max(
        0,
        d.manpower - d.maxManpower * MANPOWER_LOSS_PER_DAY * 2 * share * days,
      );
      d.readiness = Math.max(
        MIN_READINESS,
        d.readiness - READINESS_LOSS_PER_DAY * 2 * share * days,
      );
      d.morale = Math.max(0, d.morale - 0.02 * share * days);
    }
  }

  /**
   * Keeps the line coherent: neighbours pull on each other, then the step
   * between any two adjacent sectors is clamped. Runs after all sectors have
   * moved so the result cannot depend on iteration order.
   */
  private relaxLine(sectors: { advanceKm: number }[], days: number): void {
    const coupling = Math.min(0.5, NEIGHBOUR_COUPLING_PER_DAY * days);
    const before = sectors.map((s) => s.advanceKm);
    for (let i = 0; i < sectors.length; i++) {
      const left = i > 0 ? before[i - 1]! : before[i]!;
      const right = i + 1 < sectors.length ? before[i + 1]! : before[i]!;
      const pull = (left + right) / 2 - before[i]!;
      sectors[i]!.advanceKm = before[i]! + pull * coupling;
    }

    // Two sweeps so a clamp applied on the way up cannot leave a violation
    // behind it on the way down.
    for (let i = 1; i < sectors.length; i++) {
      const previous = sectors[i - 1]!.advanceKm;
      const current = sectors[i]!;
      current.advanceKm = Math.max(
        previous - MAX_NEIGHBOUR_STEP_KM,
        Math.min(previous + MAX_NEIGHBOUR_STEP_KM, current.advanceKm),
      );
    }
    for (let i = sectors.length - 2; i >= 0; i--) {
      const next = sectors[i + 1]!.advanceKm;
      const current = sectors[i]!;
      current.advanceKm = Math.max(
        next - MAX_NEIGHBOUR_STEP_KM,
        Math.min(next + MAX_NEIGHBOUR_STEP_KM, current.advanceKm),
      );
    }
  }
}
