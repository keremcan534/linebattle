/**
 * Minimal structural GeoJSON types.
 *
 * We deliberately do not depend on @types/geojson: we only consume four
 * geometry kinds and a narrow type keeps the renderer's switch statements
 * exhaustive under `strict`.
 */

export type Position = [number, number];

export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}
export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}
export interface MultiLineStringGeometry {
  type: 'MultiLineString';
  coordinates: Position[][];
}
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

export type Geometry =
  | PointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry;

export interface Feature<P = Record<string, unknown>> {
  type: 'Feature';
  properties: P;
  geometry: Geometry;
}

export interface FeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  bbox?: [number, number, number, number];
  features: Feature<P>[];
}

export interface CityProperties {
  name?: string;
  adm0name?: string;
  pop_max?: number;
  scalerank?: number;
}

export interface RiverProperties {
  name?: string;
  scalerank?: number;
}

/**
 * Political boundary lines and country labels.
 *
 * Lives here rather than next to the renderer so that `core/` can type the
 * loaded data without depending on `render/` — the dependency graph only ever
 * points inwards.
 */
export interface BorderProperties {
  kind?: 'border' | 'label';
  name?: string;
  /** Countries either side of the line, for future political logic. */
  left?: string;
  right?: string;
  /** 1 = front-defining, 3 = background context. Drives level of detail. */
  rank?: number;
}
