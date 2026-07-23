import { normalize, type Vec2 } from '@core/math/vec2';
import type { Division } from '@core/world/division';
import type { World } from '@core/world/world';
import {
  buildFrontlineLinks,
  routeClearsHostileControl,
} from './movementConstraints';

export const RETREAT_DISTANCE_KM = 55;
const RETREAT_SEARCH_RADIUS_KM = 70;
const ANGLE_OFFSETS = [
  0,
  Math.PI / 6,
  -Math.PI / 6,
  Math.PI / 3,
  -Math.PI / 3,
  Math.PI / 2,
  -Math.PI / 2,
] as const;

/**
 * Finds a physical, passable route away from local pressure. Enemy collision
 * circles and linked frontage are treated as hard geometry.
 */
export function findRetreatRoute(
  d: Division,
  threats: readonly Division[],
  world: World,
): Vec2[] | null {
  const preferred = pressureAwayVector(d, threats);
  const links = buildFrontlineLinks(world);

  for (const offset of ANGLE_OFFSETS) {
    const direction = rotate(preferred, offset);
    const intended = {
      x: d.position.x + direction.x * RETREAT_DISTANCE_KM,
      y: d.position.y + direction.y * RETREAT_DISTANCE_KM,
    };
    const target = world.terrain.nearestPassable(
      intended,
      RETREAT_SEARCH_RADIUS_KM,
    );
    if (!target) continue;
    const route = world.pathfinder.findPath(d.position, target);
    if (
      route?.length &&
      routeClearsHostileControl(d, route, world, links)
    ) {
      return route;
    }
  }

  return null;
}

/** Used by surrender resolution when the original pressure set is gone. */
export function hasValidRetreatRoute(d: Division, world: World): boolean {
  const enemies = [...world.divisions.values()]
    .filter((other) => world.hostile(d.faction, other.faction))
    .sort((a, b) => {
      const da = Math.hypot(
        a.position.x - d.position.x,
        a.position.y - d.position.y,
      );
      const db = Math.hypot(
        b.position.x - d.position.x,
        b.position.y - d.position.y,
      );
      return da - db || (a.id < b.id ? -1 : 1);
    })
    .slice(0, 8);

  if (enemies.length && findRetreatRoute(d, enemies, world)) return true;

  // In a sealed ring "away from pressure" can cancel to an arbitrary vector.
  // Probe every compass direction before declaring that no exit exists.
  const links = buildFrontlineLinks(world);
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const target = world.terrain.nearestPassable(
      {
        x: d.position.x + Math.cos(angle) * RETREAT_DISTANCE_KM,
        y: d.position.y + Math.sin(angle) * RETREAT_DISTANCE_KM,
      },
      RETREAT_SEARCH_RADIUS_KM,
    );
    if (!target) continue;
    const route = world.pathfinder.findPath(d.position, target);
    if (
      route?.length &&
      routeClearsHostileControl(d, route, world, links)
    ) {
      return true;
    }
  }
  return false;
}

function pressureAwayVector(
  d: Division,
  threats: readonly Division[],
): Vec2 {
  if (!threats.length) return { x: -1, y: 0 };
  const centre = threats.reduce(
    (sum, threat) => ({
      x: sum.x + threat.position.x,
      y: sum.y + threat.position.y,
    }),
    { x: 0, y: 0 },
  );
  centre.x /= threats.length;
  centre.y /= threats.length;
  const away = normalize({
    x: d.position.x - centre.x,
    y: d.position.y - centre.y,
  });
  if (away.x !== 0 || away.y !== 0) return away;
  const heading = threats[0]?.heading ?? 0;
  return { x: Math.cos(heading), y: Math.sin(heading) };
}

function rotate(v: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: v.x * cos - v.y * sin,
    y: v.x * sin + v.y * cos,
  };
}
