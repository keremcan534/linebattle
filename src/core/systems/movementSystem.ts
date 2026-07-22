import { distance, type Vec2 } from '@core/math/vec2';
import { effectiveSpeedKmh, type Division } from '@core/world/division';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import type { System, TickContext } from './system';

/** How close a division must get to a waypoint to count as having reached it. */
const ARRIVAL_TOLERANCE_KM = 1.5;

/** Progress smaller than this does not count as progress. */
const PROGRESS_EPSILON_KM = 0.05;

/**
 * Ticks of zero progress before an order is judged impossible.
 * Eight ticks is two game-hours — long enough to survive squeezing along a
 * coastline, short enough that a division never bleeds a day of organisation
 * into a lake it cannot cross.
 */
const STALL_LIMIT_TICKS = 8;

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

      while (budgetKm > 0 && order.cursor < order.waypoints.length) {
        const target = order.waypoints[order.cursor]!;
        const remaining = distance(d.position, target);

        if (remaining <= ARRIVAL_TOLERANCE_KM) {
          order.cursor++;
          order.bestDistance = Infinity;
          order.stalledTicks = 0;
          if (order.cursor >= order.waypoints.length) {
            d.order = null;
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

        if (world.terrain.isPassableAt(next)) {
          d.position = next;
        } else if (!this.slide(d, next, dirX, dirY, advanceKm, world.terrain)) {
          // Boxed in by water on every axis — abandon the order rather than
          // vibrating against the coastline forever.
          d.order = null;
          d.stance = 'hold';
          events.emit({ type: 'orderBlocked', division: d.id, reason: 'impassable' });
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

        if (remaining < d.order.bestDistance - PROGRESS_EPSILON_KM) {
          d.order.bestDistance = remaining;
          d.order.stalledTicks = 0;
        } else if (++d.order.stalledTicks >= STALL_LIMIT_TICKS) {
          d.order = null;
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
  private slide(
    d: Division,
    _blocked: Vec2,
    dirX: number,
    dirY: number,
    advanceKm: number,
    terrain: TerrainGrid,
  ): boolean {
    const alongX = { x: d.position.x + dirX * advanceKm, y: d.position.y };
    if (terrain.isPassableAt(alongX)) {
      d.position = alongX;
      return true;
    }
    const alongY = { x: d.position.x, y: d.position.y + dirY * advanceKm };
    if (terrain.isPassableAt(alongY)) {
      d.position = alongY;
      return true;
    }
    return false;
  }
}
