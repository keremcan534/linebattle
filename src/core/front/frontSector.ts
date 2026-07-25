import type { Vec2 } from '@core/math/vec2';

/**
 * One ordered slice of the authoritative frontline.
 *
 * The sector — not the division — is the simulation object. Divisions are
 * assigned to a sector and contribute combat power to it; the resulting
 * pressure moves `advanceKm` along the sector's normal, and division counters
 * are then *derived* from where the line ended up. Nothing here moves in
 * world space of its own accord, so there is no pathfinding, no collision
 * resolution and no way for a formation to wander through the enemy.
 */
export interface FrontSector {
  readonly index: number;
  /** Centre of this slice of the line at scenario start. */
  readonly origin: Vec2;
  /** Unit vector along the line, pointing toward the next sector. */
  readonly tangent: Vec2;
  /** Unit vector from the western army's side toward the eastern army's side. */
  readonly normal: Vec2;
  /** Frontage this slice represents, in km. */
  readonly widthKm: number;
  /** Signed displacement along {@link normal}: positive means the east gave ground. */
  advanceKm: number;
  /**
   * Last resolved power ratio, signed: positive when the west is pressing,
   * negative when the east is. Zero in a quiet sector. Display and debugging
   * only — never an input to the next tick.
   */
  pressure: number;
}

export interface FrontState {
  /** Alliance on the low-`normal` side of the line. */
  readonly westAlliance: string;
  /** Alliance on the high-`normal` side of the line. */
  readonly eastAlliance: string;
  readonly sectors: FrontSector[];
}

/** Current world position of a sector's stretch of the line. */
export function sectorPosition(sector: FrontSector): Vec2 {
  return {
    x: sector.origin.x + sector.normal.x * sector.advanceKm,
    y: sector.origin.y + sector.normal.y * sector.advanceKm,
  };
}

/**
 * Which side of the line an alliance stands on: -1 west, +1 east, 0 unknown.
 * Counters are placed with this sign, which is what keeps every German counter
 * west of its sector and every Soviet counter east of it, by construction.
 */
export function sideOf(front: FrontState, alliance: string): -1 | 0 | 1 {
  if (alliance === front.westAlliance) return -1;
  if (alliance === front.eastAlliance) return 1;
  return 0;
}

/**
 * Index of the sector whose stretch of line lies closest to a world position.
 *
 * Used to seat a scenario's historical deployment: a division listed near
 * Leningrad joins a northern sector, one near Odessa a southern sector.
 */
export function nearestSectorIndex(front: FrontState, position: Vec2): number {
  let best = 0;
  let bestDistance = Infinity;
  for (const sector of front.sectors) {
    const at = sectorPosition(sector);
    const d = (at.x - position.x) ** 2 + (at.y - position.y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = sector.index;
    }
  }
  return best;
}

/**
 * Cuts an ordered polyline into `count` equal-length sectors.
 *
 * `eastward` is the projected direction of increasing longitude, used to orient
 * every sector normal consistently even where the line bends back on itself —
 * so "east side" means the same thing in the Baltic as in Bessarabia.
 */
export function buildFrontSectors(
  line: readonly Vec2[],
  count: number,
  eastward: Vec2,
  westAlliance: string,
  eastAlliance: string,
): FrontState {
  if (line.length < 2) throw new Error('A front line needs at least two points');
  if (count < 1) throw new Error('A front needs at least one sector');

  const spans = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-9) continue;
    spans.push({ a, b, length, start: total });
    total += length;
  }
  if (!spans.length || total <= 0) throw new Error('A front line needs a positive length');

  const step = total / count;
  const sectors: FrontSector[] = [];
  for (let i = 0; i < count; i++) {
    const at = (i + 0.5) * step;
    let span = spans[spans.length - 1]!;
    for (const candidate of spans) {
      if (at <= candidate.start + candidate.length) {
        span = candidate;
        break;
      }
    }

    const f = Math.max(0, Math.min(1, (at - span.start) / span.length));
    const origin = {
      x: span.a.x + (span.b.x - span.a.x) * f,
      y: span.a.y + (span.b.y - span.a.y) * f,
    };
    const tangent = {
      x: (span.b.x - span.a.x) / span.length,
      y: (span.b.y - span.a.y) / span.length,
    };
    // Perpendicular, flipped so it always points toward the eastern army.
    let normal = { x: -tangent.y, y: tangent.x };
    if (normal.x * eastward.x + normal.y * eastward.y < 0) {
      normal = { x: -normal.x, y: -normal.y };
    }

    sectors.push({
      index: i,
      origin,
      tangent,
      normal,
      widthKm: step,
      advanceKm: 0,
      pressure: 0,
    });
  }

  return { westAlliance, eastAlliance, sectors };
}
