import type { SupplyField } from '@core/supply/supplyField';
import type { Division } from '@core/world/division';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Radius over which a formed division physically controls ground. */
const ZOC_RADIUS_KM = 22;
/** Clear local superiority required to change political control. */
const CONTROL_RATIO = 1.35;
/** A nearby enemy turns a disconnected formation into a sealed pocket. */
const ENCIRCLEMENT_CHECK_KM = ZOC_RADIUS_KM * 3;

/**
 * Binary capital connectivity and liquid political control.
 *
 * The former depot-range heat map has intentionally disappeared. A division
 * is fully supplied when its cell has a friendly-controlled land route to a
 * logistics root, and has zero supply when that route is cut. No distance,
 * terrain multiplier, captured depot or coloured supply gradient can create a
 * detached island behind the front.
 */
export class SupplySystem implements System {
  readonly name = 'supply';
  private enemyBuf: Float32Array | null = null;
  private networkQueue: Int32Array | null = null;

  update(ctx: TickContext): void {
    const { world } = ctx;
    if (!world.supply) return;

    this.computePresence(world, world.supply);
    this.updateControl(world.supply);
    this.computeNetworks(world, world.supply);
    this.applyToDivisions(ctx);
  }

  private computePresence(world: World, field: SupplyField): void {
    for (const alliance of world.alliances) {
      field.presenceFor(alliance).fill(0);
    }

    const span = Math.ceil(ZOC_RADIUS_KM / field.cellSize);
    for (const d of world.divisions.values()) {
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance || d.stance === 'retreat') continue;

      const presence = field.presenceFor(alliance);
      const centre = field.indexAt(d.position);
      if (centre < 0) continue;
      const cx = centre % field.width;
      const cy = (centre / field.width) | 0;
      const weight =
        (d.manpower / d.maxManpower) *
        (0.35 + 0.65 * (d.organisation / d.maxOrganisation));

      for (let y = cy - span; y <= cy + span; y++) {
        for (let x = cx - span; x <= cx + span; x++) {
          if (
            x < 0 ||
            y < 0 ||
            x >= field.width ||
            y >= field.height
          ) {
            continue;
          }
          const dx = (x - cx) * field.cellSize;
          const dy = (y - cy) * field.cellSize;
          const distance = Math.hypot(dx, dy);
          if (distance > ZOC_RADIUS_KM) continue;
          presence[y * field.width + x]! +=
            weight * (1 - distance / ZOC_RADIUS_KM);
        }
      }
    }
  }

  /**
   * Political ownership persists in empty rear areas. Only clear physical
   * presence changes a cell, so divisions cannot paint unsupported tendrils
   * through the enemy simply by receiving a distant order.
   */
  private updateControl(field: SupplyField): void {
    const alliances = field.controlAlliances;
    const presences = alliances.map((alliance) =>
      field.presenceFor(alliance),
    );

    for (let i = 0; i < field.control.length; i++) {
      if (field.throughput[i]! <= 0) continue;

      let strongest = -1;
      let strongestPresence = 0;
      let secondPresence = 0;
      for (let k = 0; k < presences.length; k++) {
        const presence = presences[k]![i]!;
        if (presence > strongestPresence) {
          secondPresence = strongestPresence;
          strongestPresence = presence;
          strongest = k;
        } else if (presence > secondPresence) {
          secondPresence = presence;
        }
      }

      if (
        strongest >= 0 &&
        strongestPresence > 0.15 &&
        strongestPresence > secondPresence * CONTROL_RATIO + 0.08
      ) {
        field.control[i] = strongest + 1;
      }
    }
  }

  /**
   * Floods only through land already held by the alliance. Cardinal links
   * close diagonal corner leaks, so a physically sealed ring is a real pocket.
   */
  private computeNetworks(world: World, field: SupplyField): void {
    const size = field.width * field.height;
    if (!this.networkQueue || this.networkQueue.length !== size) {
      this.networkQueue = new Int32Array(size);
    }
    const queue = this.networkQueue;

    for (const alliance of world.alliances) {
      const network = field.networkFor(alliance);
      network.fill(0);
      const owner = field.allianceIndex(alliance) + 1;
      const ownPresence = field.presenceFor(alliance);
      const enemyPresence = this.enemyPresence(world, field, alliance);
      let head = 0;
      let tail = 0;

      for (const source of world.supplySources) {
        if (
          source.alliance !== alliance ||
          !(source.networkRoot ?? !source.capturable)
        ) {
          continue;
        }
        const index = field.indexAt(source.position);
        if (
          index < 0 ||
          network[index] === 1 ||
          field.throughput[index]! <= 0
        ) {
          continue;
        }
        // A capital is the root even on the capture tick. Expansion beyond
        // that cell still obeys political ownership and enemy interdiction.
        network[index] = 1;
        queue[tail++] = index;
      }

      while (head < tail) {
        const current = queue[head++]!;
        const x = current % field.width;
        const y = (current / field.width) | 0;

        const visit = (next: number) => {
          if (
            network[next] === 1 ||
            field.throughput[next]! <= 0 ||
            field.control[next] !== owner ||
            enemyPresence[next]! >
              ownPresence[next]! * CONTROL_RATIO + 0.08
          ) {
            return;
          }
          network[next] = 1;
          queue[tail++] = next;
        };

        if (x > 0) visit(current - 1);
        if (x + 1 < field.width) visit(current + 1);
        if (y > 0) visit(current - field.width);
        if (y + 1 < field.height) visit(current + field.width);
      }
    }
  }

  private enemyPresence(
    world: World,
    field: SupplyField,
    alliance: string,
  ): Float32Array {
    const size = field.width * field.height;
    if (!this.enemyBuf || this.enemyBuf.length !== size) {
      this.enemyBuf = new Float32Array(size);
    }
    const combined = this.enemyBuf;
    combined.fill(0);
    for (const other of world.alliances) {
      if (other === alliance) continue;
      const presence = field.presenceFor(other);
      for (let i = 0; i < combined.length; i++) {
        combined[i]! += presence[i]!;
      }
    }
    return combined;
  }

  private applyToDivisions(ctx: TickContext): void {
    const { world, events } = ctx;
    const field = world.supply!;

    for (const d of world.divisions.values()) {
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;

      const connected = field.networkAt(alliance, d.position);
      d.supply = connected ? 1 : 0;

      const wasEncircled = d.encircled;
      d.encircled = !connected && this.enemyNearby(world, d);
      d.encircledTicks = d.encircled
        ? wasEncircled
          ? d.encircledTicks + 1
          : 1
        : 0;
      if (d.encircled && !wasEncircled) {
        events.emit({ type: 'divisionEncircled', division: d.id });
      }
      if (!d.encircled && wasEncircled) {
        events.emit({ type: 'divisionRelieved', division: d.id });
      }
    }
  }

  private enemyNearby(world: World, d: Division): boolean {
    return world
      .divisionsNear(
        d.position.x,
        d.position.y,
        ENCIRCLEMENT_CHECK_KM,
      )
      .some((other) => world.hostile(d.faction, other.faction));
  }
}
