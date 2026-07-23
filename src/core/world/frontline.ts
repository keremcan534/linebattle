import type { Vec2 } from '@core/math/vec2';

export type FrontlineSegmentId = string & { readonly __frontlineSegment: unique symbol };

/**
 * A stable operational slice of the liquid control boundary.
 *
 * The geometry moves as territory changes, but the bucket-derived id remains
 * stable while the front stays in the same operational area. Divisions belong
 * to this object; enemy counters are contacts inside it, not destinations.
 */
export interface FrontlineSegment {
  id: FrontlineSegmentId;
  /** Sorted alliance pair, matching the direction of {@link normal}. */
  alliances: readonly [string, string];
  /** Current centre of this part of the liquid boundary. */
  position: Vec2;
  /** Unit vector from alliances[0] territory toward alliances[1] territory. */
  normal: Vec2;
  /** Approximate boundary length represented by this segment. */
  lengthKm: number;
  updatedTick: number;
}

/** +1 means toward alliances[1], -1 means toward alliances[0]. */
export function directionForAlliance(
  segment: FrontlineSegment,
  alliance: string,
): number | null {
  if (alliance === segment.alliances[0]) return 1;
  if (alliance === segment.alliances[1]) return -1;
  return null;
}
