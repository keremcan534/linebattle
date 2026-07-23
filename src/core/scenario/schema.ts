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
  /**
   * Seed for the simulation's RNG. Omit and the scenario id is used, so a
   * scenario is reproducible either way; set it explicitly to replay a
   * specific run or to offer the player "reroll".
   */
  seed?: number | string;
  map: MapSpec;
  /**
   * Depots, railheads and ports. Omit and supply is disabled entirely, which
   * is a legitimate choice for a short tactical scenario.
   */
  supply?: SupplySpec;
  /** Optional long-campaign production and operational phases. */
  campaign?: CampaignSpec;
  playerFaction: string;
  factions: FactionSpec[];
  /** Reusable stat blocks, referenced by `DivisionSpec.template`. */
  templates: Record<string, DivisionTemplate>;
  divisions: DivisionSpec[];
}

export interface CampaignSpec {
  mobilization?: MobilizationPolicySpec[];
  plans?: AllianceCampaignPlanSpec[];
}

export interface MobilizationPolicySpec {
  faction: string;
  daysPerDivision: number;
  maxForceMultiplier: number;
  divisionsPerFrontlineSegment?: number;
}

export interface AllianceCampaignPlanSpec {
  faction: string;
  openingShock?: {
    from?: string;
    until: string;
    combatMultiplier: number;
    recoveryMultiplier: number;
  };
  fallback?: {
    until: string;
    line: { lon: number; lat: number }[];
    rearOffsetKm?: number;
    influenceKm?: number;
    rearward?: 'east' | 'west' | 'north' | 'south';
  };
  halt?: {
    from: string;
    until: string;
    combatMultiplier: number;
    recoveryMultiplier: number;
  };
  offensive?: {
    from: string;
    target: { lon: number; lat: number };
    influenceKm: number;
  };
  nationalResolve?: {
    maximumAtTerritoryLoss: number;
    combatMultiplier: number;
    recoveryMultiplier: number;
    mobilizationMultiplier: number;
  };
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
    /** Modern country polygons used only to seed dated political control. */
    nations?: string;
    /** Features carrying a `terrain` property: forest, marsh, hills, mountains. */
    overlays?: string;
    /**
     * Political boundaries and country labels for the scenario's date.
     * Purely cartographic — see BorderLayer. Borders never constrain movement.
     */
    borders?: string;
  };
}

export interface SupplySpec {
  /** Drives the seasonal model. Defaults to 'temperate'. */
  climate?: 'continental' | 'temperate' | 'desert';
  sources: SupplySourceSpec[];
  /**
   * Dated opening ownership. Country groups provide the broad rear areas;
   * ordered polygon overrides correct historical frontiers that do not match
   * modern borders.
   */
  initialControl?: InitialControlSpec;
}

export interface InitialControlSpec {
  countries: {
    faction: string;
    names: string[];
  }[];
  overrides?: {
    faction: string;
    polygon: { lon: number; lat: number }[];
  }[];
}

export interface SupplySourceSpec {
  name: string;
  faction: string;
  lon: number;
  lat: number;
  /**
   * Reach across good ground, in km. Roughly the distance a depot can push
   * tonnage before the trucks are eating what they carry: 350-500 for a rail
   * head, less for a forward dump.
   */
  rangeKm: number;
  /**
   * Whether an enemy that overruns it may use it. Rail junctions and supply
   * dumps inside the theatre should be capturable; a home port should not.
   */
  capturable?: boolean;
  /** Capital, home port or off-map rail entry anchoring the logistics network. */
  networkRoot?: boolean;
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
  /** Serviceable weapons and vehicles versus establishment; defaults to 1. */
  equipmentRatio?: number;
  /** Relative tactical proficiency; defaults to 1. */
  doctrine?: number;
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
  equipmentRatio?: number;
  doctrine?: number;
}
