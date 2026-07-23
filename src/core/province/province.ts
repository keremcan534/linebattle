import type { Terrain } from '@core/terrain/terrainTypes';

/**
 * A province: the atomic unit of territory.
 *
 * This is the backbone HOI4 gets its front-line behaviour from, but generated
 * to fit OUR theatres rather than imported. A province is a chunky patch of
 * ground (~45 km across) with a fixed shape and a mutable owner. Its geometry
 * never changes; only who holds it does.
 *
 * Deliberately NOT a graph node that units teleport between. Divisions still
 * live at continuous world positions and move smoothly — the province they are
 * standing in is looked up, not stored. Provinces exist to answer three
 * questions cheaply and unambiguously:
 *
 *   1. "Whose ground is this?"        — ownership, the political map.
 *   2. "Is that province next to me?" — adjacency, for the front line.
 *   3. "Can I be here uncontested?"   — occupancy, for pinning and blocking.
 *
 * They are the thing a fuzzy cell-by-cell control field could only
 * approximate: a border between two provinces is a hard line, so the front
 * reads crisply and can never smear.
 */
export interface Province {
  readonly id: number;
  /** Centroid in world km — where a label or a "move to province" order aims. */
  readonly cx: number;
  readonly cy: number;
  /** Dominant terrain across the province's cells. */
  readonly terrain: Terrain;
  /** Number of land cells, a proxy for area. */
  readonly cells: number;
  /** Ids of provinces sharing an edge. Symmetric, sorted, deduplicated. */
  readonly neighbours: number[];
  /** True for a coastal province — reserved for naval/supply-by-sea later. */
  readonly coastal: boolean;
}

/** Sentinel for "no province here" (open sea, off-map). */
export const NO_PROVINCE = -1;
/** Sentinel owner for a province nobody holds. */
export const NEUTRAL = -1;
