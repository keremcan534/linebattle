import { distance, type Vec2 } from '@core/math/vec2';
import {
  effectiveSpeedKmh,
  organisationRatio,
  strengthRatio,
  type Division,
} from '@core/world/division';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { ticksForHours } from '@core/time/gameClock';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** How close a division must get to a waypoint to count as having reached it. */
const ARRIVAL_TOLERANCE_KM = 1.5;

/** Every division occupies a solid operational circle. */
export const UNIT_COLLISION_RADIUS_KM = 6;
/** Hostile collision circles may touch, but may never overlap. */
export const ENEMY_MIN_SEPARATION_KM = UNIT_COLLISION_RADIUS_KM * 2;
/**
 * A formed division controls more than the footprint of its counter.
 *
 * Two 7 km operational zones make a coherent 14 km frontage while leaving
 * genuine gaps for mobile formations to exploit. A routed or shattered unit
 * falls back to the smaller solid collision circle: it can be pursued, but it
 * can still never be crossed.
 */
export const FORMED_UNIT_ZOC_RADIUS_KM = 7;
export const FORMED_ENEMY_MIN_SEPARATION_KM = FORMED_UNIT_ZOC_RADIUS_KM * 2;
const COLLISION_EPSILON_KM = 0.01;

/** Progress smaller than this does not count as progress. */
const PROGRESS_EPSILON_KM = 0.05;

/**
 * Ticks of zero progress before an order is judged impossible.
 * Two game-hours is long enough to survive squeezing along a
 * coastline, short enough that a division never bleeds a day of organisation
 * into a lake it cannot cross.
 */
const STALL_LIMIT_TICKS = ticksForHours(2);

/**
 * Continuous movement across the map.
 *
 * There are no provinces and no graph: a division holds a world position in
 * kilometres and integrates towards its next waypoint every tick, sampling the
 * terrain grid as it goes. That is the whole point of the project — the unit is
 * genuinely *somewhere*, not "in" anything.
 *
 * Milestone 1 follows waypoints in straight lines. Milestone 2 will insert a
 * pathfinder that produces those waypoints; this system will not need to
 * change, because it already only knows how to walk a list of points.
 */
export class MovementSystem implements System {
  readonly name = 'movement';

  update(ctx: TickContext): void {
    const { world, events, dtSeconds } = ctx;
    const hours = dtSeconds / 3600;

    for (const d of world.divisions.values()) {
      d.prevPosition = { ...d.position };

      const order = d.order;
      if (!order || order.cursor >= order.waypoints.length) continue;

      let budgetKm = effectiveSpeedKmh(d, world.weather.movement) * hours;
      if (budgetKm <= 0) continue;
      let enemyBlocked = false;

      while (budgetKm > 0 && order.cursor < order.waypoints.length) {
        const target = order.waypoints[order.cursor]!;
        const remaining = distance(d.position, target);

        if (remaining <= ARRIVAL_TOLERANCE_KM) {
          order.cursor++;
          order.bestDistance = Infinity;
          order.stalledTicks = 0;
          if (order.cursor >= order.waypoints.length) {
            d.order = null;
            d.advance = null;
            d.stance = 'hold';
            events.emit({ type: 'destinationReached', division: d.id });
          }
          continue;
        }

        const dirX = (target.x - d.position.x) / remaining;
        const dirY = (target.y - d.position.y) / remaining;
        d.heading = Math.atan2(dirY, dirX);

        // Terrain is sampled per sub-step rather than once per tick: a fast
        // division covers 10 km in a tick, which is more than two terrain
        // cells, and we must not let it teleport across a lake.
        const stepKm = Math.min(budgetKm, remaining, world.terrain.cellSize * 0.5);
        const multiplier = world.terrain.moveMultiplierAt(d.position);
        const advanceKm = stepKm * (multiplier > 0 ? multiplier : 0);
        if (advanceKm <= 1e-6) break;

        const next: Vec2 = {
          x: d.position.x + dirX * advanceKm,
          y: d.position.y + dirY * advanceKm,
        };

        const terrainSafe = world.terrain.isPassableAt(next)
          ? next
          : this.slidePoint(d.position, dirX, dirY, advanceKm, world.terrain);
        if (!terrainSafe) {
          // Boxed in by water on every axis — abandon the order rather than
          // vibrating against the coastline forever.
          d.order = null;
          d.advance = null;
          d.stance = 'hold';
          events.emit({ type: 'orderBlocked', division: d.id, reason: 'impassable' });
          break;
        }

        const collision = this.clipAgainstEnemies(d, terrainSafe, world);
        d.position = collision.position;
        if (collision.blocked) {
          enemyBlocked = true;
          break;
        }

        budgetKm -= stepKm;
      }

      // Progress check, once per tick rather than per sub-step: sliding along
      // a shore genuinely moves the division, so "did I move?" is the wrong
      // question. The right one is "am I any closer to where I was sent?".
      if (d.order && d.order.cursor < d.order.waypoints.length) {
        const target = d.order.waypoints[d.order.cursor]!;
        const remaining = distance(d.position, target);

        if (enemyBlocked) {
          // Enemy contact blocks geometry, not intent. Preserve the order for
          // combat resolution without letting the formation tunnel through.
          d.order.bestDistance = Math.min(d.order.bestDistance, remaining);
          d.order.stalledTicks = 0;
        } else if (remaining < d.order.bestDistance - PROGRESS_EPSILON_KM) {
          d.order.bestDistance = remaining;
          d.order.stalledTicks = 0;
        } else if (++d.order.stalledTicks >= STALL_LIMIT_TICKS) {
          d.order = null;
          d.advance = null;
          d.stance = 'hold';
          events.emit({ type: 'orderBlocked', division: d.id, reason: 'impassable' });
        }
      }
    }
  }

  /**
   * Wall-sliding: when the direct step hits water, try the two axis-aligned
   * components separately so units follow a coastline instead of stalling.
   */
  private slidePoint(
    current: Vec2,
    dirX: number,
    dirY: number,
    advanceKm: number,
    terrain: TerrainGrid,
  ): Vec2 | null {
    const alongX = { x: current.x + dirX * advanceKm, y: current.y };
    if (terrain.isPassableAt(alongX)) return alongX;
    const alongY = { x: current.x, y: current.y + dirY * advanceKm };
    return terrain.isPassableAt(alongY) ? alongY : null;
  }

  /**
   * Clips a movement segment against every hostile collision circle.
   *
   * Segment intersection, rather than checking only the endpoint, is what
   * makes crossing impossible even for a fast unit or a large simulation tick.
   */
  private clipAgainstEnemies(
    d: Division,
    proposed: Vec2,
    world: World,
  ): { position: Vec2; blocked: boolean } {
    const start = d.position;
    const dx = proposed.x - start.x;
    const dy = proposed.y - start.y;
    const segmentLength = Math.hypot(dx, dy);
    if (segmentLength <= 1e-9) return { position: { ...start }, blocked: false };

    let maxT = 1;
    for (const enemy of world.divisions.values()) {
      if (enemy.id === d.id || !world.hostile(d.faction, enemy.faction)) continue;
      const minimumSeparation = this.exertsZoneOfControl(enemy)
        ? FORMED_ENEMY_MIN_SEPARATION_KM
        : ENEMY_MIN_SEPARATION_KM;

      const sx = start.x - enemy.position.x;
      const sy = start.y - enemy.position.y;
      const startDistance = Math.hypot(sx, sy);
      const endDistance = distance(proposed, enemy.position);

      // Rescue legacy/hand-authored overlaps by allowing only motion that
      // increases separation. No movement may deepen or cross an overlap.
      if (startDistance < minimumSeparation - COLLISION_EPSILON_KM) {
        const outward = startDistance <= COLLISION_EPSILON_KM || sx * dx + sy * dy > 0;
        if (outward && endDistance > startDistance) continue;
        maxT = 0;
        break;
      }

      const a = dx * dx + dy * dy;
      const b = 2 * (sx * dx + sy * dy);
      const c = sx * sx + sy * sy - minimumSeparation * minimumSeparation;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) continue;

      const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (entry < 0 || entry > maxT) continue;
      maxT = Math.max(0, entry - COLLISION_EPSILON_KM / segmentLength);
    }

    if (maxT >= 1) return { position: proposed, blocked: false };
    return {
      position: {
        x: start.x + dx * maxT,
        y: start.y + dy * maxT,
      },
      blocked: true,
    };
  }

  private exertsZoneOfControl(d: Division): boolean {
    return (
      d.stance !== 'retreat' &&
      strengthRatio(d) >= 0.2 &&
      organisationRatio(d) >= 0.2
    );
  }
}
