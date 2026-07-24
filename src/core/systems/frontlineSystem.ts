import { distance, distanceSq } from '@core/math/vec2';
import type { SupplyField } from '@core/supply/supplyField';
import { activeOffensive } from '@core/world/campaign';
import type { Division } from '@core/world/division';
import {
  type FrontlineSegment,
  type FrontlineSegmentId,
} from '@core/world/frontline';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { TICKS_PER_DAY, ticksForHours } from '@core/time/gameClock';
import type { System, TickContext } from './system';

/** Stable geographic bucket size for one operational frontage. */
export const FRONTLINE_SEGMENT_KM = 60;
/** Liquid control and segment geometry refresh every strategic tick. */
const FRONTLINE_UPDATE_TICKS = ticksForHours(1);
/** Operational HQ may rebalance sound assignments once per game-day. */
const REASSIGN_INTERVAL_TICKS = TICKS_PER_DAY;
/** Cost added per formation already assigned, preventing sector dogpiles. */
const LOAD_PENALTY_KM = 45;
/** Strategic intent influences nearby formations, never the whole theatre. */
const OBJECTIVE_INFLUENCE_KM = 900;
const ATTACK_OBJECTIVE_BIAS_KM = 280;
const DEFENSE_OBJECTIVE_BIAS_KM = 220;
/** Pocket contours are cleanup tasks, not sectors of the main operational line. */
const POCKET_CONTOUR_RADIUS_KM = FRONTLINE_SEGMENT_KM * 1.5;
/**
 * The political wash may contain a narrow neutral seam between two armies.
 * Operational frontage bridges at most this many 16 km cells from either
 * side; it does not invent a front across an empty theatre.
 */
const MAX_NEUTRAL_BRIDGE_CELLS = 8;

interface SegmentAggregate {
  id: FrontlineSegmentId;
  alliances: readonly [string, string];
  x: number;
  y: number;
  nx: number;
  ny: number;
  edges: number;
  edgeKm: number;
}

/**
 * Makes the liquid frontline a first-class operational object.
 *
 * Geometry is derived from the authoritative control field, while assignment
 * is persistent state. A formation keeps its segment as the line bends and is
 * reassigned only here: when its segment disappears or during the deliberate
 * daily balancing pass performed by operational HQ.
 */
export class FrontlineSystem implements System {
  readonly name = 'frontline';
  private operationalControl: Uint8Array | null = null;
  private fillDistance: Uint8Array | null = null;
  private fillQueue: Int32Array | null = null;
  private lastObjectiveRevision = -1;

  update(ctx: TickContext): void {
    const { world } = ctx;
    if (!world.supply) return;
    if (ctx.tick % FRONTLINE_UPDATE_TICKS !== 0) return;

    this.rebuildSegments(world, ctx.tick);
    const objectiveChanged = this.lastObjectiveRevision !== world.objectiveRevision;
    const rebalance = ctx.tick % REASSIGN_INTERVAL_TICKS === 0 || objectiveChanged;
    this.assignDivisions(world, rebalance);
    // Coverage is checked every update, not just on the daily pass: a front
    // that stretched or tore between rebalances left empty sectors open for
    // hours, and the attacker poured through the seam and pocketed the
    // defenders. Surplus formations slide into any gap continuously.
    this.balanceFrontline(world);
    this.lastObjectiveRevision = world.objectiveRevision;
  }

  private rebuildSegments(world: World, tick: number): void {
    const field = world.supply!;
    const aggregates = new Map<FrontlineSegmentId, SegmentAggregate>();
    const control = this.bridgeNeutralSeams(field);

    const addEdge = (
      owner: number,
      otherOwner: number,
      x: number,
      y: number,
      ownerToOtherX: number,
      ownerToOtherY: number,
    ) => {
      if (owner === 0 || otherOwner === 0 || owner === otherOwner) return;

      const ownerAlliance = field.controlAlliances[owner - 1];
      const otherAlliance = field.controlAlliances[otherOwner - 1];
      if (!ownerAlliance || !otherAlliance) return;

      const alliances = (
        ownerAlliance < otherAlliance
          ? [ownerAlliance, otherAlliance]
          : [otherAlliance, ownerAlliance]
      ) as readonly [string, string];
      const direction = ownerAlliance === alliances[0] ? 1 : -1;
      const nx = ownerToOtherX * direction;
      const ny = ownerToOtherY * direction;
      const bucketX = Math.floor((x - field.origin.x) / FRONTLINE_SEGMENT_KM);
      const bucketY = Math.floor((y - field.origin.y) / FRONTLINE_SEGMENT_KM);
      const id = `${alliances[0]}:${alliances[1]}:${bucketX}:${bucketY}` as FrontlineSegmentId;

      let aggregate = aggregates.get(id);
      if (!aggregate) {
        aggregate = {
          id,
          alliances,
          x: 0,
          y: 0,
          nx: 0,
          ny: 0,
          edges: 0,
          edgeKm: 0,
        };
        aggregates.set(id, aggregate);
      }
      aggregate.x += x;
      aggregate.y += y;
      aggregate.nx += nx;
      aggregate.ny += ny;
      aggregate.edges++;
      aggregate.edgeKm += field.cellSize;
    };

    for (let y = 0; y < field.height; y++) {
      for (let x = 0; x < field.width; x++) {
        const i = y * field.width + x;
        const owner = control[i]!;
        if (x + 1 < field.width) {
          addEdge(
            owner,
            control[i + 1]!,
            field.origin.x + (x + 1) * field.cellSize,
            field.origin.y + (y + 0.5) * field.cellSize,
            1,
            0,
          );
        }
        if (y + 1 < field.height) {
          addEdge(
            owner,
            control[i + field.width]!,
            field.origin.x + (x + 0.5) * field.cellSize,
            field.origin.y + (y + 1) * field.cellSize,
            0,
            1,
          );
        }
      }
    }

    world.frontlineSegments.clear();
    for (const aggregate of [...aggregates.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    )) {
      const normalLength = Math.hypot(aggregate.nx, aggregate.ny);
      const segment: FrontlineSegment = {
        id: aggregate.id,
        alliances: aggregate.alliances,
        position: {
          x: aggregate.x / aggregate.edges,
          y: aggregate.y / aggregate.edges,
        },
        normal:
          normalLength > 1e-6
            ? { x: aggregate.nx / normalLength, y: aggregate.ny / normalLength }
            : { x: 1, y: 0 },
        lengthKm: aggregate.edgeKm,
        updatedTick: tick,
      };
      if (this.isPocketContour(world, segment)) continue;
      world.frontlineSegments.set(segment.id, segment);
    }
  }

  private isPocketContour(world: World, segment: FrontlineSegment): boolean {
    for (const d of world.divisions.values()) {
      if (!d.encircled) continue;
      if (distance(d.position, segment.position) > POCKET_CONTOUR_RADIUS_KM) continue;

      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;
      const hasMainlineSupport = [...world.divisions.values()].some(
        (other) =>
          other.id !== d.id &&
          !other.encircled &&
          other.stance !== 'retreat' &&
          world.getFaction(other.faction)?.alliance === alliance &&
          distance(other.position, segment.position) <=
            POCKET_CONTOUR_RADIUS_KM * 1.5,
      );
      // A router close to the living main line is not a pocket contour. The
      // old radius-only test deleted whole stretches of the main front around
      // every temporary encirclement and made all recruits dogpile elsewhere.
      if (!hasMainlineSupport) return true;
    }
    return false;
  }

  /**
   * Frontage is allowed to cross a narrow neutral no-man's-land.
   *
   * `SupplyField.control` remains authoritative and is never changed here.
   * For segment extraction only, a bounded multi-source flood extends each
   * owned area into nearby neutral land. Opposing waves meet at the operational
   * line. Without this, a one-cell neutral seam makes the two coloured regions
   * look adjacent while producing zero assignable sectors.
   */
  private bridgeNeutralSeams(field: SupplyField): Uint8Array {
    const size = field.width * field.height;
    if (!this.operationalControl || this.operationalControl.length !== size) {
      this.operationalControl = new Uint8Array(size);
      this.fillDistance = new Uint8Array(size);
      this.fillQueue = new Int32Array(size);
    }

    const control = this.operationalControl;
    const distance = this.fillDistance!;
    const queue = this.fillQueue!;
    control.set(field.control);
    distance.fill(255);

    let head = 0;
    let tail = 0;
    for (let i = 0; i < size; i++) {
      if (control[i] === 0 || field.throughput[i]! <= 0) continue;
      distance[i] = 0;
      queue[tail++] = i;
    }

    while (head < tail) {
      const current = queue[head++]!;
      const nextDistance = distance[current]! + 1;
      if (nextDistance > MAX_NEUTRAL_BRIDGE_CELLS) continue;

      const x = current % field.width;
      const y = (current / field.width) | 0;
      const visit = (next: number) => {
        if (field.throughput[next]! <= 0 || field.control[next] !== 0) return;
        if (distance[next]! <= nextDistance) return;
        distance[next] = nextDistance;
        control[next] = control[current]!;
        queue[tail++] = next;
      };

      if (x > 0) visit(current - 1);
      if (x + 1 < field.width) visit(current + 1);
      if (y > 0) visit(current - field.width);
      if (y + 1 < field.height) visit(current + field.width);
    }

    return control;
  }

  private assignDivisions(world: World, rebalance: boolean): void {
    const loads = new Map<string, number>();
    const loadKey = (alliance: string, segment: FrontlineSegmentId) =>
      `${alliance}|${segment}`;
    const divisions = [...world.divisions.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );

    for (const d of divisions) {
      const alliance = world.getFaction(d.faction)?.alliance;
      const current = d.frontlineSegment
        ? world.frontlineSegments.get(d.frontlineSegment)
        : undefined;
      const valid = !!current && !!alliance && current.alliances.includes(alliance);

      if (!valid || rebalance) d.frontlineSegment = null;
      else {
        const key = loadKey(alliance, current.id);
        loads.set(key, (loads.get(key) ?? 0) + 1);
      }
    }

    for (const d of divisions) {
      if (d.frontlineSegment) continue;
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;

      const candidates = [...world.frontlineSegments.values()]
        .filter((segment) => segment.alliances.includes(alliance))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (!candidates.length) continue;
      const hasStrategicIntent = [...world.strategicObjectives.values()].some(
        (objective) => objective.alliance === alliance,
      ) || !!activeOffensive(world.campaignPlans.get(alliance), world.clock.date);

      let best: FrontlineSegment | null = null;
      let bestScore = Infinity;
      let bestLoad = Infinity;
      for (const segment of candidates) {
        const load = loads.get(loadKey(alliance, segment.id)) ?? 0;
        // With no strategic objective, frontage integrity outranks marching
        // distance absolutely: HQ fills every empty sector before stacking a
        // second division anywhere. Objectives deliberately relax this rule
        // so a local Schwerpunkt can still form.
        if (!hasStrategicIntent) {
          const score = distance(d.position, segment.position);
          if (load < bestLoad || (load === bestLoad && score < bestScore)) {
            bestLoad = load;
            bestScore = score;
            best = segment;
          }
          continue;
        }

        const priority = this.objectivePriority(world, alliance, d.position, segment);
        const loadPenalty = LOAD_PENALTY_KM * (1 - priority * 0.62);
        const score =
          distance(d.position, segment.position) +
          load * loadPenalty -
          priority * (priority > 0 ? ATTACK_OBJECTIVE_BIAS_KM : 0);
        if (score < bestScore) {
          bestScore = score;
          best = segment;
        }
      }

      d.frontlineSegment = best!.id;
      const key = loadKey(alliance, best!.id);
      loads.set(key, (loads.get(key) ?? 0) + 1);
    }
  }

  /**
   * Evens formations across the whole friendly frontage every update.
   *
   * assignDivisions stacks surplus onto the nearest sector, so reinforcements
   * piled up wherever they were drafted — a huge cluster on one flank while the
   * other thinned to a thread. This pass moves the excess from over-manned
   * sectors down to the emptiest ones (rail redeployment carries them there),
   * keeping the line evenly held from end to end instead of lumped in a corner.
   */
  private balanceFrontline(world: World): void {
    for (const alliance of world.alliances) {
      const segments = [...world.frontlineSegments.values()].filter((segment) =>
        segment.alliances.includes(alliance),
      );
      if (!segments.length) continue;

      const occupants = new Map<FrontlineSegmentId, Division[]>();
      for (const segment of segments) occupants.set(segment.id, []);
      let total = 0;
      for (const d of world.divisions.values()) {
        if (world.getFaction(d.faction)?.alliance !== alliance) continue;
        if (!d.frontlineSegment || d.encircled) continue;
        if (d.stance === 'retreat' || d.stance === 'advance') continue;
        const list = occupants.get(d.frontlineSegment);
        if (!list) continue;
        list.push(d);
        total++;
      }
      if (total === 0) continue;

      // The even-coverage target, rounded to whole divisions per sector.
      const balancePoint = Math.max(1, Math.round(total / segments.length));

      // Anything beyond the balance point on an over-manned sector is surplus.
      const donors: Division[] = [];
      for (const list of occupants.values()) {
        if (list.length <= balancePoint) continue;
        list.sort((a, b) => (a.id < b.id ? -1 : 1));
        donors.push(...list.slice(balancePoint));
      }
      if (!donors.length) continue;

      // Fill the thinnest sectors first; ties resolved by id for determinism.
      const needy = segments
        .filter((segment) => occupants.get(segment.id)!.length < balancePoint)
        .sort(
          (a, b) =>
            occupants.get(a.id)!.length - occupants.get(b.id)!.length ||
            (a.id < b.id ? -1 : 1),
        );

      const moved = new Set<DivisionId>();
      for (const segment of needy) {
        let best: Division | null = null;
        let bestDistance = Infinity;
        for (const donor of donors) {
          if (moved.has(donor.id)) continue;
          const dd = distanceSq(donor.position, segment.position);
          if (dd < bestDistance) {
            bestDistance = dd;
            best = donor;
          }
        }
        if (!best) break;
        best.frontlineSegment = segment.id;
        moved.add(best.id);
        occupants.get(segment.id)!.push(best);
      }
    }
  }

  /**
   * Returns 0..1 sector priority while keeping the effect local to formations
   * that can plausibly participate. Objectives bias frontage; they are never
   * direct movement destinations.
   */
  private objectivePriority(
    world: World,
    alliance: string,
    divisionPosition: { x: number; y: number },
    segment: FrontlineSegment,
  ): number {
    let best = 0;
    for (const objective of world.strategicObjectives.values()) {
      if (objective.alliance !== alliance) continue;
      const sectorDistance = distance(segment.position, objective.position);
      const divisionDistance = distance(divisionPosition, objective.position);
      if (
        sectorDistance >= OBJECTIVE_INFLUENCE_KM ||
        divisionDistance >= OBJECTIVE_INFLUENCE_KM * 1.35
      ) {
        continue;
      }

      const sectorProximity = 1 - sectorDistance / OBJECTIVE_INFLUENCE_KM;
      const formationProximity = 1 - divisionDistance / (OBJECTIVE_INFLUENCE_KM * 1.35);
      const kindWeight =
        objective.kind === 'attack'
          ? ATTACK_OBJECTIVE_BIAS_KM
          : DEFENSE_OBJECTIVE_BIAS_KM;
      const normalizedKindWeight = kindWeight / ATTACK_OBJECTIVE_BIAS_KM;
      best = Math.max(
        best,
        sectorProximity * (0.45 + formationProximity * 0.55) * normalizedKindWeight,
      );
    }

    const offensive = activeOffensive(
      world.campaignPlans.get(alliance),
      world.clock.date,
    );
    if (offensive) {
      const sectorDistance = distance(segment.position, offensive.target);
      const divisionDistance = distance(divisionPosition, offensive.target);
      if (
        sectorDistance < offensive.influenceKm &&
        divisionDistance < offensive.influenceKm * 1.35
      ) {
        const sectorProximity = 1 - sectorDistance / offensive.influenceKm;
        const formationProximity =
          1 - divisionDistance / (offensive.influenceKm * 1.35);
        best = Math.max(
          best,
          sectorProximity * (0.35 + formationProximity * 0.65),
        );
      }
    }
    return Math.min(1, best);
  }
}
