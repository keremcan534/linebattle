import { distance, type Vec2 } from '@core/math/vec2';
import {
  organisationRatio,
  strengthRatio,
  type Division,
} from '@core/world/division';
import type { World } from '@core/world/world';

/** Every division occupies a solid operational circle. */
export const UNIT_COLLISION_RADIUS_KM = 6;
/** Hostile collision circles may touch, but may never overlap. */
export const ENEMY_MIN_SEPARATION_KM = UNIT_COLLISION_RADIUS_KM * 2;
/** Wider control radius exerted by a formed division. */
export const FORMED_UNIT_ZOC_RADIUS_KM = 7;
export const FORMED_ENEMY_MIN_SEPARATION_KM =
  FORMED_UNIT_ZOC_RADIUS_KM * 2;
/**
 * Maximum centre-to-centre distance at which friendly formations form a
 * temporary blocking frontage. Anything wider is a real operational gap.
 */
export const FRONTLINE_LINK_MAX_DISTANCE_KM = 44;

const COLLISION_EPSILON_KM = 0.01;

export interface FrontlineLink {
  alliance: string;
  a: Vec2;
  b: Vec2;
}

export function exertsZoneOfControl(d: Division): boolean {
  return (
    d.stance !== 'retreat' &&
    d.state !== 'FALLING_BACK' &&
    strengthRatio(d) >= 0.2 &&
    organisationRatio(d) >= 0.2
  );
}

/** Snapshot all currently coherent friendly frontage links once per tick. */
export function buildFrontlineLinks(world: World): FrontlineLink[] {
  const formed = [...world.divisions.values()]
    .filter(exertsZoneOfControl)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const links: FrontlineLink[] = [];

  for (let i = 0; i < formed.length; i++) {
    const a = formed[i]!;
    const alliance = world.getFaction(a.faction)?.alliance;
    if (!alliance) continue;
    for (let j = i + 1; j < formed.length; j++) {
      const b = formed[j]!;
      if (world.getFaction(b.faction)?.alliance !== alliance) continue;
      const span = distance(a.position, b.position);
      if (span <= COLLISION_EPSILON_KM || span > FRONTLINE_LINK_MAX_DISTANCE_KM) {
        continue;
      }
      links.push({
        alliance,
        a: { ...a.position },
        b: { ...b.position },
      });
    }
  }

  return links;
}

/**
 * Clips one movement segment against hostile collision circles and linked
 * frontage. Segment tests prevent tunnelling even at high speed or large dt.
 */
export function clipAgainstHostileControl(
  mover: Division,
  start: Vec2,
  proposed: Vec2,
  world: World,
  links: readonly FrontlineLink[] = buildFrontlineLinks(world),
): { position: Vec2; blocked: boolean } {
  const dx = proposed.x - start.x;
  const dy = proposed.y - start.y;
  const segmentLength = Math.hypot(dx, dy);
  if (segmentLength <= 1e-9) {
    return { position: { ...start }, blocked: false };
  }

  let maxT = 1;
  for (const enemy of world.divisions.values()) {
    if (enemy.id === mover.id || !world.hostile(mover.faction, enemy.faction)) {
      continue;
    }
    const minimumSeparation = exertsZoneOfControl(enemy)
      ? FORMED_ENEMY_MIN_SEPARATION_KM
      : ENEMY_MIN_SEPARATION_KM;

    const sx = start.x - enemy.position.x;
    const sy = start.y - enemy.position.y;
    const startDistance = Math.hypot(sx, sy);
    const endDistance = distance(proposed, enemy.position);

    // A hand-authored overlap may only be escaped, never deepened or crossed.
    if (startDistance < minimumSeparation - COLLISION_EPSILON_KM) {
      const outward =
        startDistance <= COLLISION_EPSILON_KM || sx * dx + sy * dy > 0;
      if (outward && endDistance > startDistance) continue;
      maxT = 0;
      break;
    }

    const a = dx * dx + dy * dy;
    const b = 2 * (sx * dx + sy * dy);
    const c =
      sx * sx + sy * sy - minimumSeparation * minimumSeparation;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) continue;

    const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (entry < 0 || entry > maxT) continue;
    maxT = Math.max(
      0,
      entry - COLLISION_EPSILON_KM / segmentLength,
    );
  }

  const moverAlliance = world.getFaction(mover.faction)?.alliance;
  for (const link of links) {
    if (!moverAlliance || link.alliance === moverAlliance) continue;
    const entry = crossingParameter(start, proposed, link.a, link.b);
    if (entry === null || entry > maxT) continue;
    maxT = Math.max(
      0,
      entry - COLLISION_EPSILON_KM / segmentLength,
    );
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

/** True when every leg of a prospective route respects hostile control. */
export function routeClearsHostileControl(
  mover: Division,
  route: readonly Vec2[],
  world: World,
  links: readonly FrontlineLink[] = buildFrontlineLinks(world),
): boolean {
  let start = mover.position;
  for (const target of route) {
    const clipped = clipAgainstHostileControl(
      mover,
      start,
      target,
      world,
      links,
    );
    if (clipped.blocked && distance(clipped.position, target) > 0.05) {
      return false;
    }
    start = target;
  }
  return true;
}

/**
 * Parameter t on mover segment where it crosses the frontage segment.
 * Endpoint contacts are already protected by unit collision circles.
 */
function crossingParameter(
  start: Vec2,
  end: Vec2,
  a: Vec2,
  b: Vec2,
): number | null {
  const rx = end.x - start.x;
  const ry = end.y - start.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) <= 1e-9) return null;

  const qx = a.x - start.x;
  const qy = a.y - start.y;
  const t = cross(qx, qy, sx, sy) / denominator;
  const u = cross(qx, qy, rx, ry) / denominator;
  // A formation already touching a line may disengage from it, but it cannot
  // travel from one side to the other.
  if (t <= 1e-8 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

const cross = (ax: number, ay: number, bx: number, by: number): number =>
  ax * by - ay * bx;
