import { distance } from '@core/math/vec2';
import { sectorPosition, type FrontState } from '@core/front/frontSector';
import { organisationRatio, strengthRatio, type Division } from '@core/world/division';
import { ticksForHours } from '@core/time/gameClock';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Operational HQ reviews the allocation once per game-day. */
const REVIEW_INTERVAL_TICKS = ticksForHours(24);
/** Every sector wants at least this many divisions in line. */
const MIN_DIVISIONS_PER_SECTOR = 1;
/** Transfer time per sector of lateral distance. */
const TRANSFER_TICKS_PER_SECTOR = ticksForHours(12);
/** Coming out of reserve into the line. */
const RESERVE_TRANSFER_TICKS = ticksForHours(24);
/** A formation may not be reassigned again for this long after arriving. */
const REASSIGN_COOLDOWN_TICKS = ticksForHours(72);
/**
 * A move must improve matters by this much to happen at all.
 *
 * Hysteresis is the whole defence against oscillation: without it two adjacent
 * sectors trade the same division back and forth forever, because moving it
 * always makes the sector it just left the neediest one.
 */
const NEED_HYSTERESIS = 0.35;
/** How close an objective must be to count as marking a sector. */
const OBJECTIVE_RANGE_KM = 260;

/**
 * Assigns divisions to sectors: the only place `sector` changes.
 *
 * Priority order, highest first:
 *   1. critically weak sectors (outgunned locally)
 *   2. offensive priority sectors (a player attack objective)
 *   3. defensive priority sectors (a player defence objective)
 *   4. sectors below minimum division density
 *
 * Reserves are committed first because they cost nothing to take; only then
 * will a surplus sector give a formation to an *adjacent* sector. There is no
 * pathfinding and no free movement: a reassignment is a fixed-duration transfer
 * whose length depends on how many sectors it crosses, during which the
 * formation fights at reduced power.
 */
export class FrontAllocatorSystem implements System {
  readonly name = 'frontAllocator';

  update(ctx: TickContext): void {
    const { world } = ctx;
    const front = world.front;
    if (!front) return;

    this.advanceTransfers(world);
    if (ctx.tick % REVIEW_INTERVAL_TICKS !== 0) return;

    for (const alliance of world.alliances) {
      if (alliance !== front.westAlliance && alliance !== front.eastAlliance) continue;
      this.allocate(world, front, alliance);
    }
  }

  /** Counts transfers down and lands arriving formations in their new sector. */
  private advanceTransfers(world: World): void {
    for (const d of world.divisions.values()) {
      if (d.reassignCooldown > 0) d.reassignCooldown--;
      const transfer = d.transfer;
      if (!transfer || d.deployment !== 'transferring') continue;

      transfer.ticksRemaining--;
      if (transfer.ticksRemaining > 0) continue;

      d.sector = transfer.to;
      d.deployment = 'frontline';
      d.transfer = null;
      d.reassignCooldown = REASSIGN_COOLDOWN_TICKS;
    }
  }

  private allocate(world: World, front: FrontState, alliance: string): void {
    const sectors = front.sectors;
    const held: Division[][] = sectors.map(() => []);
    const reserves: Division[] = [];

    const own = [...world.divisions.values()]
      .filter((d) => world.getFaction(d.faction)?.alliance === alliance)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const d of own) {
      if (d.deployment === 'transferring') continue;
      if (d.deployment === 'reserve' || d.sector === null) {
        reserves.push(d);
        continue;
      }
      held[d.sector]?.push(d);
    }

    const need = sectors.map((_, i) =>
      this.sectorNeed(world, front, alliance, i, held[i]!),
    );

    // 1) Commit the reserve to the neediest sectors first.
    for (const d of reserves) {
      let best = -1;
      let bestNeed = NEED_HYSTERESIS;
      for (let i = 0; i < sectors.length; i++) {
        if (need[i]! > bestNeed) {
          bestNeed = need[i]!;
          best = i;
        }
      }
      if (best < 0) break;

      this.beginTransfer(d, best, RESERVE_TRANSFER_TICKS);
      held[best]!.push(d);
      need[best] = this.sectorNeed(world, front, alliance, best, held[best]!);
    }

    // 2) Then let a sector with something to spare help a neighbour.
    for (let i = 0; i < sectors.length; i++) {
      for (const neighbour of [i - 1, i + 1]) {
        if (neighbour < 0 || neighbour >= sectors.length) continue;
        if (need[neighbour]! <= need[i]! + NEED_HYSTERESIS) continue;
        if (held[i]!.length <= MIN_DIVISIONS_PER_SECTOR) continue;

        const donor = held[i]!.find(
          (d) => d.reassignCooldown === 0 && d.deployment === 'frontline',
        );
        if (!donor) continue;

        held[i] = held[i]!.filter((d) => d.id !== donor.id);
        this.beginTransfer(donor, neighbour, TRANSFER_TICKS_PER_SECTOR);
        held[neighbour]!.push(donor);
        need[i] = this.sectorNeed(world, front, alliance, i, held[i]!);
        need[neighbour] = this.sectorNeed(
          world,
          front,
          alliance,
          neighbour,
          held[neighbour]!,
        );
      }
    }
  }

  private beginTransfer(d: Division, to: number, ticks: number): void {
    d.transfer = { from: d.sector, to, ticksRemaining: Math.max(1, ticks) };
    d.deployment = 'transferring';
    // Order/stance play no part in the sector model; clear any legacy state so
    // nothing else tries to march this formation across the map.
    d.order = null;
    d.stance = 'hold';
  }

  /**
   * How badly a sector wants another division. Larger is needier; values below
   * {@link NEED_HYSTERESIS} are treated as content.
   */
  private sectorNeed(
    world: World,
    front: FrontState,
    alliance: string,
    index: number,
    held: readonly Division[],
  ): number {
    const sector = front.sectors[index]!;
    let need = 0;

    // 4) Density: an empty stretch of front is always worth filling.
    if (held.length < MIN_DIVISIONS_PER_SECTOR) {
      need += 1.5 * (MIN_DIVISIONS_PER_SECTOR - held.length);
    }

    // 1) Weakness: compare the quality of what is holding this sector with what
    // faces it. Spent formations count for little, which is what pulls fresh
    // divisions toward a sector that is being ground down.
    const ownQuality = held.reduce(
      (sum, d) => sum + strengthRatio(d) * organisationRatio(d) * d.readiness,
      0,
    );
    const enemyAlliance =
      alliance === front.westAlliance ? front.eastAlliance : front.westAlliance;
    let enemyQuality = 0;
    for (const d of world.divisions.values()) {
      if (d.sector !== index) continue;
      if (world.getFaction(d.faction)?.alliance !== enemyAlliance) continue;
      enemyQuality += strengthRatio(d) * organisationRatio(d) * d.readiness;
    }
    if (enemyQuality > 0) {
      const deficit = (enemyQuality - ownQuality) / enemyQuality;
      if (deficit > 0) need += 2.5 * deficit;
    }

    // 2) and 3) Player intent marks sectors as offensive or defensive priorities.
    const position = sectorPosition(sector);
    for (const objective of world.strategicObjectives.values()) {
      if (objective.alliance !== alliance) continue;
      const range = distance(position, objective.position);
      if (range > OBJECTIVE_RANGE_KM) continue;
      const proximity = 1 - range / OBJECTIVE_RANGE_KM;
      need += (objective.kind === 'attack' ? 2 : 1.2) * proximity;
    }

    return need;
  }
}
