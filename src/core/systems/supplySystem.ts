import type { SupplyField } from '@core/supply/supplyField';
import type { Division } from '@core/world/division';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Radius over which a division projects control, in km. */
const ZOC_RADIUS_KM = 22;

/**
 * How much enemy presence it takes to sever a supply route.
 *
 * Above 1 so that merely *touching* a road does not cut it — a front line has
 * troops on both sides, and if parity severed supply every attack would
 * instantly starve itself.
 */
const INTERDICTION_RATIO = 1.35;

/** Ticks between full recomputations. 4 = one game-hour. */
const RECOMPUTE_INTERVAL = 4;

/** Reach still in hand, in km, above which a formation is fully supplied. */
const FULL_SUPPLY_SLACK_KM = 150;

/**
 * How far the sealing ring of a pocket may sit and still count as encircling.
 *
 * Wider than a single zone of control: the divisions closing a Kessel stand
 * off at operational distance, they do not hold hands around it.
 */
const ENCIRCLEMENT_CHECK_KM = ZOC_RADIUS_KM * 3;

/**
 * Rate at which a division's supply moves towards what the field offers.
 *
 * Not instant, on purpose: a formation carries several days of stores, so
 * being cut off is a slow strangulation rather than a switch. It also means a
 * spearhead can outrun its supply for a while and get away with it, which is
 * exactly the decision Guderian kept making.
 */
const SUPPLY_ADJUST_PER_HOUR = 0.02;

/**
 * Supply propagation and encirclement.
 *
 * Runs BEFORE movement, so a division that was cut off last tick moves at
 * starved speed this tick rather than getting one free march on stores it no
 * longer has.
 *
 * The expensive part — flooding the whole theatre — happens once a game-hour
 * rather than every tick. Supply fronts move at the speed of armies, not of
 * fifteen-minute increments, and the per-division smoothing above hides the
 * granularity completely.
 */
export class SupplySystem implements System {
  readonly name = 'supply';

  /**
   * Scratch buffers, allocated once and reused.
   *
   * The flood ran fine correctness-wise while allocating these per alliance
   * per recompute, and cost 8.65 ms a pass for it — 2.2 ms amortised onto
   * every tick, against 0.10 ms for the entire rest of the simulation. Two
   * 206 KB arrays and a 412 KB heap handed to the collector every game-hour
   * is not free. Same technique as the pathfinder, for the same reason.
   */
  private best: Float32Array | null = null;
  private enemyBuf: Float32Array | null = null;
  private heap: MaxHeap | null = null;

  update(ctx: TickContext): void {
    const { world } = ctx;
    if (!world.supply) return;

    if (world.clock.tick % RECOMPUTE_INTERVAL === 0) {
      this.computePresence(world, world.supply);
      this.resolveCaptures(world, world.supply, ctx);
      this.floodSupply(world, world.supply);
      this.updateControl(world.supply);
    }

    this.applyToDivisions(ctx);
  }

  // -------------------------------------------------------------- presence --

  private computePresence(world: World, field: SupplyField): void {
    for (const alliance of world.alliances) field.presenceFor(alliance).fill(0);

    const span = Math.ceil(ZOC_RADIUS_KM / field.cellSize);

    for (const d of world.divisions.values()) {
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;
      // A broken formation streaming rearwards is not holding ground.
      if (d.stance === 'retreat') continue;

      const presence = field.presenceFor(alliance);
      const centre = field.indexAt(d.position);
      if (centre < 0) continue;

      const cx = centre % field.width;
      const cy = (centre / field.width) | 0;
      // Strength and cohesion both matter: a shattered division holds nothing.
      const weight = (d.manpower / d.maxManpower) * (0.35 + 0.65 * (d.organisation / d.maxOrganisation));

      for (let y = cy - span; y <= cy + span; y++) {
        for (let x = cx - span; x <= cx + span; x++) {
          if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
          const dx = (x - cx) * field.cellSize;
          const dy = (y - cy) * field.cellSize;
          const dist = Math.hypot(dx, dy);
          if (dist > ZOC_RADIUS_KM) continue;
          presence[y * field.width + x]! += weight * (1 - dist / ZOC_RADIUS_KM);
        }
      }
    }
  }

  // -------------------------------------------------------------- capture --

  /**
   * Hands a capturable hub to whoever dominates the ground it stands on.
   *
   * Without this, supply cannot follow an advance and every offensive
   * strangles itself the moment it passes its start-line depots. Measured
   * before this existed: a general German advance on Barbarossa starved 56 of
   * 57 divisions to death inside two months without the Red Army doing much
   * of anything. Rail heads moved forward in 1941, and they have to here.
   */
  private resolveCaptures(world: World, field: SupplyField, ctx: TickContext): void {
    for (const source of world.supplySources) {
      if (!source.capturable) continue;

      let best = '';
      let bestPresence = 0;
      for (const alliance of world.alliances) {
        const presence = field.presenceAt(alliance, source.position);
        if (presence > bestPresence) {
          bestPresence = presence;
          best = alliance;
        }
      }
      if (!best || best === source.alliance) continue;

      // Must clearly dominate, not merely be present: a raid should not flip
      // a rail junction that the defender is still contesting.
      const held = field.presenceAt(source.alliance, source.position);
      if (bestPresence < held * INTERDICTION_RATIO + 0.08) continue;

      source.alliance = best;
      ctx.events.emit({ type: 'supplyHubCaptured', name: source.name, alliance: best });
    }
  }

  // ---------------------------------------------------------------- supply --

  /**
   * Multi-source Dijkstra outward from every depot, in "range remaining".
   *
   * Each source starts with a budget in kilometres and spends it crossing
   * cells, more slowly through bad ground. Cells the enemy dominates are not
   * traversable at all, which is what turns a closed ring of enemy divisions
   * into a pocket without any explicit encirclement test.
   */
  private floodSupply(world: World, field: SupplyField): void {
    const size = field.width * field.height;

    for (const alliance of world.alliances) {
      const supply = field.fieldFor(alliance);
      supply.fill(0);

      const own = field.presenceFor(alliance);
      const enemy = this.enemyPresence(world, field, alliance);

      // `best` holds the highest remaining range seen at each cell.
      const best = this.scratch(size);
      best.fill(0);
      const heap = this.scratchHeap(size);
      heap.clear();

      for (const source of world.supplySources) {
        if (source.alliance !== alliance) continue;
        const index = field.indexAt(source.position);
        if (index < 0) continue;
        if (source.rangeKm > best[index]!) {
          best[index] = source.rangeKm;
          heap.push(index, source.rangeKm);
        }
      }

      while (heap.size > 0) {
        const { node, value } = heap.pop();
        if (value < best[node]! - 1e-6) continue;

        const cx = node % field.width;
        const cy = (node / field.width) | 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= field.width || ny >= field.height) continue;

            const next = ny * field.width + nx;
            const throughput = field.throughput[next]!;
            if (throughput <= 0) continue;
            if (enemy[next]! > own[next]! * INTERDICTION_RATIO + 0.08) continue;

            const step = (dx !== 0 && dy !== 0 ? field.cellSize * Math.SQRT2 : field.cellSize) / throughput;
            const remaining = value - step;
            if (remaining <= 0 || remaining <= best[next]!) continue;

            best[next] = remaining;
            heap.push(next, remaining);
          }
        }
      }

      for (let i = 0; i < size; i++) {
        // Supply is read from the SLACK left in the pipe, not from distance
        // travelled. While a route still has 150 km of reach in hand the
        // formation at the end of it wants for nothing; below that it starts
        // going short, and it hits zero at the limit.
        //
        // The obvious alternative — supply proportional to remaining range —
        // taxes a division 70 km behind its own railhead at 18%, which is
        // nonsense. It also has to be normalised against some nominal range,
        // so a scenario declaring shorter depots could never reach full
        // supply anywhere. Slack has neither problem and reads physically:
        // "how much room is left before this line breaks".
        supply[i] = Math.min(1, best[i]! / FULL_SUPPLY_SLACK_KM);
      }
    }
  }

  private enemyPresence(world: World, field: SupplyField, alliance: string): Float32Array {
    const size = field.width * field.height;
    if (!this.enemyBuf || this.enemyBuf.length !== size) this.enemyBuf = new Float32Array(size);
    const combined = this.enemyBuf;
    combined.fill(0);
    for (const other of world.alliances) {
      if (other === alliance) continue;
      const presence = field.presenceFor(other);
      for (let i = 0; i < combined.length; i++) combined[i]! += presence[i]!;
    }
    return combined;
  }

  private scratch(size: number): Float32Array {
    if (!this.best || this.best.length !== size) this.best = new Float32Array(size);
    return this.best;
  }

  private scratchHeap(size: number): MaxHeap {
    if (!this.heap || this.heap.capacity < size) this.heap = new MaxHeap(size);
    return this.heap;
  }

  // -------------------------------------------------------------- control --

  /**
   * Advances the political map.
   *
   * Two ways to take a cell, both deliberate:
   *  - **Domination**: your troops clearly outweigh everyone else's there.
   *    This is the front itself changing hands.
   *  - **Logistics sweep**: nobody stands there, but exactly one side's supply
   *    reaches it. This is what paints the ground *behind* an advance, so the
   *    map fills in like the historical animations instead of leaving 44 km
   *    ribbons where columns happened to drive. It also gets pockets right
   *    for free: supply cannot enter a pocket, so a Kessel keeps its
   *    defender's colour until it actually dies.
   *
   * Anything else keeps its owner — territory does not flip because a patrol
   * drove past.
   */
  private updateControl(field: SupplyField): void {
    const alliances = field.controlAlliances;
    const presences = alliances.map((a) => field.presenceFor(a));
    const supplies = alliances.map((a) => field.fieldFor(a));
    const size = field.width * field.height;

    for (let i = 0; i < size; i++) {
      if (field.throughput[i]! <= 0) continue;

      let best = -1;
      let bestP = 0;
      let second = 0;
      for (let k = 0; k < alliances.length; k++) {
        const p = presences[k]![i]!;
        if (p > bestP) {
          second = bestP;
          bestP = p;
          best = k;
        } else if (p > second) {
          second = p;
        }
      }

      if (bestP > 0.15 && bestP > second * INTERDICTION_RATIO + 0.08) {
        field.control[i] = best + 1;
      } else if (bestP < 0.02) {
        let owner = -1;
        let reached = 0;
        for (let k = 0; k < alliances.length; k++) {
          if (supplies[k]![i]! > 0.05) {
            owner = k;
            reached++;
          }
        }
        if (reached === 1) field.control[i] = owner + 1;
      }
    }
  }

  // ------------------------------------------------------------ divisions --

  private applyToDivisions(ctx: TickContext): void {
    const { world, events } = ctx;
    const field = world.supply!;
    const hours = ctx.dtSeconds / 3600;
    const rate = Math.min(1, SUPPLY_ADJUST_PER_HOUR * hours);

    for (const d of world.divisions.values()) {
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;

      const available = field.supplyAt(alliance, d.position);
      d.supply += (available - d.supply) * rate;
      d.supply = Math.max(0, Math.min(1, d.supply));

      const wasEncircled = d.encircled;
      d.encircled = this.isEncircled(world, field, alliance, d);
      if (d.encircled && !wasEncircled) events.emit({ type: 'divisionEncircled', division: d.id });
      if (!d.encircled && wasEncircled) events.emit({ type: 'divisionRelieved', division: d.id });
    }
  }

  /**
   * Cut off, as opposed to merely badly supplied.
   *
   * The distinction matters for the player: "your spearhead has outrun its
   * trucks" and "your spearhead is in a pocket" demand different decisions,
   * and only the second one is an emergency.
   */
  private isEncircled(world: World, field: SupplyField, alliance: string, d: Division): boolean {
    if (field.supplyAt(alliance, d.position) > 0.02) return false;
    return field.presenceAt(alliance, d.position) > 0 && this.enemyNearby(world, d);
  }

  private enemyNearby(world: World, d: Division): boolean {
    return world
      .divisionsNear(d.position.x, d.position.y, ENCIRCLEMENT_CHECK_KM)
      .some((o) => world.hostile(d.faction, o.faction));
  }
}

/**
 * Binary max-heap over (cell, remaining range).
 *
 * Dijkstra normally wants a min-heap; here the quantity being propagated is
 * range *remaining*, which decreases as it spreads, so the frontier to expand
 * first is the largest. Ties break on cell index to keep the flood
 * deterministic.
 */
class MaxHeap {
  private readonly nodes: Int32Array;
  private readonly values: Float32Array;
  size = 0;

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.nodes = new Int32Array(capacity + 1);
    this.values = new Float32Array(capacity + 1);
  }

  clear(): void {
    this.size = 0;
  }

  push(node: number, value: number): void {
    if (this.size + 1 >= this.nodes.length) return; // saturated; flood is done
    let i = this.size++;
    this.nodes[i] = node;
    this.values[i] = value;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.greater(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  pop(): { node: number; value: number } {
    const node = this.nodes[0]!;
    const value = this.values[0]!;
    this.size--;
    this.nodes[0] = this.nodes[this.size]!;
    this.values[0] = this.values[this.size]!;

    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.size && this.greater(left, best)) best = left;
      if (right < this.size && this.greater(right, best)) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return { node, value };
  }

  private greater(a: number, b: number): boolean {
    const va = this.values[a]!;
    const vb = this.values[b]!;
    return va === vb ? this.nodes[a]! < this.nodes[b]! : va > vb;
  }

  private swap(a: number, b: number): void {
    const n = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = n;
    const v = this.values[a]!;
    this.values[a] = this.values[b]!;
    this.values[b] = v;
  }
}
