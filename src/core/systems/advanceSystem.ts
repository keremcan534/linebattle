import { distance } from '@core/math/vec2';
import type { System, TickContext } from './system';
import { ENEMY_MIN_SEPARATION_KM } from './movementSystem';

/** Extra breathing room before a post-combat advance is released. */
const ADVANCE_CLEARANCE_KM = 0.5;

/**
 * Turns a won battle into a deliberate, physical advance.
 *
 * CombatSystem creates the transition and discards the attacker's old route.
 * This system waits until every defeated formation has completed RETREAT and
 * opened real space, then creates a fresh route only to the vacated position.
 */
export class AdvanceSystem implements System {
  readonly name = 'advance';

  update(ctx: TickContext): void {
    const { world, events } = ctx;

    for (const d of world.divisions.values()) {
      if (d.stance !== 'advance') continue;
      const advance = d.advance;
      if (!advance) {
        d.order = null;
        d.stance = 'hold';
        continue;
      }
      if (advance.phase === 'moving') continue;

      const blockers = advance.blockedBy.flatMap((id) => {
        const other = world.getDivision(id);
        return other && world.hostile(d.faction, other.faction) ? [other] : [];
      });
      const waiting = blockers.some(
        (other) =>
          other.stance === 'retreat' ||
          distance(d.position, other.position) <
            ENEMY_MIN_SEPARATION_KM + ADVANCE_CLEARANCE_KM,
      );
      if (waiting) continue;

      const target = world.terrain.nearestPassable(advance.target);
      const route = target ? world.pathfinder.findPath(d.position, target) : null;
      if (!route) {
        d.order = null;
        d.advance = null;
        d.stance = 'hold';
        events.emit({ type: 'orderBlocked', division: d.id, reason: 'unreachable' });
        continue;
      }

      d.order = {
        kind: 'move',
        waypoints: route,
        cursor: 0,
        bestDistance: Infinity,
        stalledTicks: 0,
      };
      advance.phase = 'moving';
    }
  }
}
