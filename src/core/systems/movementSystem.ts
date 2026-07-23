import { distance, type Vec2 } from '@core/math/vec2';
import { effectiveSpeedKmh } from '@core/world/division';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { ticksForHours } from '@core/time/gameClock';
import type { System, TickContext } from './system';
import {
  buildFrontlineLinks,
  clipAgainstHostileControl,
} from './movementConstraints';

export {
  ENEMY_MIN_SEPARATION_KM,
  FORMED_ENEMY_MIN_SEPARATION_KM,
  FORMED_UNIT_ZOC_RADIUS_KM,
  FRONTLINE_LINK_MAX_DISTANCE_KM,
  UNIT_COLLISION_RADIUS_KM,
} from './movementConstraints';

/** How close a division must get to a waypoint to count as having reached it. */
const ARRIVAL_TOLERANCE_KM = 1.5;

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
    const frontlineLinks = buildFrontlineLinks(world);

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
          const completedState = d.state;
          order.cursor++;
          order.bestDistance = Infinity;
          order.stalledTicks = 0;
          if (order.cursor >= order.waypoints.length) {
            d.order = null;
            d.advance = null;
            d.stance = 'hold';
            d.state =
              completedState === 'FALLING_BACK'
                ? 'RECOVERING'
                : 'FRONTLINE';
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
          if (d.state !== 'FALLING_BACK') d.state = 'FRONTLINE';
          events.emit({ type: 'orderBlocked', division: d.id, reason: 'impassable' });
          break;
        }

        const collision = clipAgainstHostileControl(
          d,
          d.position,
          terrainSafe,
          world,
          frontlineLinks,
        );
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
          if (d.state !== 'FALLING_BACK') d.state = 'FRONTLINE';
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

}
