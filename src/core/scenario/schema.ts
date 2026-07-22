import type { ProjectionSpec } from '@core/geo/projection';
import type { Branch } from '@core/world/division';

/**
 * The on-disk scenario format.
 *
 * A scenario is DATA, never code. Adding "Case Blue" or "Fall Gelb" must mean
 * writing one JSON file and zero TypeScript — that requirement is what drove
 * the projection, the map bounds and the terrain resolution all to be
 * scenario-declared rather than global constants.
 *
 * `SCENARIO_FORMAT_VERSION` is checked at load so that an old file fails with
 * a clear message instead of subtly misbehaving.
 */
export const SCENARIO_FORMAT_VERSION = 1;

export interface ScenarioFile {
  formatVersion: number;
  id: string;
  name: string;
  description?: string;
  /** ISO 8601, treated as UTC. */
  startDate: string;
  map: MapSpec;
  playerFaction: string;
  factions: FactionSpec[];
  /** Reusable stat blocks, referenced by `DivisionSpec.template`. */
  templates: Record<string, DivisionTemplate>;
  divisions: DivisionSpec[];
}

export interface MapSpec {
  projection: ProjectionSpec;
  /** Geographic extent of the playable theatre. */
  bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  /** Terrain raster resolution in km. Smaller = sharper coastlines, more memory. */
  terrainCellSizeKm: number;
  layers: {
    land: string;
    lakes?: string;
    rivers?: string;
    cities?: string;
    /** Features carrying a `terrain` property: forest, marsh, hills, mountains. */
    overlays?: string;
  };
}

export interface FactionSpec {
  id: string;
  name: string;
  alliance: string;
  /** "#rrggbb" */
  color: string;
  accentColor?: string;
}

export interface DivisionTemplate {
  branch: Branch;
  maxManpower: number;
  maxOrganisation: number;
  speedKmh: number;
  softAttack: number;
  hardAttack: number;
  defence: number;
  hardness: number;
  /** Defaults applied when a division does not override them. */
  experience?: number;
  morale?: number;
  supply?: number;
}

export interface DivisionSpec {
  id: string;
  template: string;
  faction: string;
  name: string;
  shortName?: string;
  formation?: string;
  /** Starting position, geographic. Authors think in lon/lat, never in km. */
  lon: number;
  lat: number;
  /** Optional per-division overrides of template values. */
  strength?: number; // 0..1 of maxManpower
  organisation?: number; // 0..1 of maxOrganisation
  experience?: number;
  morale?: number;
  supply?: number;
}
