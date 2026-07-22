import type { FeatureCollection, Geometry, Position, RiverProperties } from '@core/geo/geojson';
import type { Projection } from '@core/geo/projection';
import type { Vec2 } from '@core/math/vec2';
import { Terrain } from './terrainTypes';
import { TerrainGrid } from './terrainGrid';

/**
 * Builds a {@link TerrainGrid} by rasterising GeoJSON layers.
 *
 * This is a LOAD-TIME asset step, not simulation code. It is the only part of
 * `core/` that touches a browser API, and it does so because the 2D canvas is
 * already a heavily optimised polygon rasteriser — hand-rolling scanline fill
 * would be several hundred lines of code that the platform gives us for free.
 *
 * Encoding trick: each terrain class is painted as the solid colour
 * `rgb(id*20, id*20, id*20)`. Reading back, `round(red / 20)` recovers the
 * class and antialiased edge pixels round to one of the two neighbouring
 * classes rather than to garbage.
 */

export interface TerrainLayerSpec {
  data: FeatureCollection;
  terrain: Terrain;
}

export interface BuildTerrainOptions {
  projection: Projection;
  /** Theatre bounds in world km. */
  origin: Vec2;
  worldWidth: number;
  worldHeight: number;
  /** Cell edge in km. 4 km balances fidelity against a ~750 KB buffer. */
  cellSize: number;
  /** Painted in order; later layers overwrite earlier ones. */
  layers: TerrainLayerSpec[];
  rivers?: FeatureCollection<RiverProperties>;
}

const CLASS_STEP = 20;

export function buildTerrainGrid(opts: BuildTerrainOptions): TerrainGrid {
  const width = Math.ceil(opts.worldWidth / opts.cellSize);
  const height = Math.ceil(opts.worldHeight / opts.cellSize);

  const cells = decodeTerrainRaster(
    rasterise(width, height, opts, (ctx, toPx) => {
      // Everything is sea until proven otherwise.
      ctx.fillStyle = classColor(Terrain.Water);
      ctx.fillRect(0, 0, width, height);
      for (const layer of opts.layers) {
        ctx.fillStyle = classColor(layer.terrain);
        for (const f of layer.data.features) {
          // Filled per feature so that even-odd winding resolves holes
          // (lakes inside a landmass) without features cancelling each other.
          ctx.beginPath();
          fillGeometry(ctx, f.geometry, toPx);
          ctx.fill('evenodd');
        }
      }
    }),
  );

  const rivers = opts.rivers
    ? rasterise(width, height, opts, (ctx, toPx) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const f of opts.rivers!.features) {
          // scalerank 1 = Volga/Danube class, 9 = a creek.
          const rank = f.properties.scalerank ?? 6;
          const magnitude = Math.round(255 * Math.max(0.25, 1 - (rank - 1) / 9));
          ctx.strokeStyle = `rgb(${magnitude},${magnitude},${magnitude})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          strokeGeometry(ctx, f.geometry, toPx);
          ctx.stroke();
        }
      })
    : new Uint8Array(width * height);

  return new TerrainGrid(opts.origin, opts.cellSize, width, height, cells, rivers);
}

// --------------------------------------------------------------- internals --

type ToPixel = (lon: number, lat: number) => [number, number];

function rasterise(
  width: number,
  height: number,
  opts: BuildTerrainOptions,
  paint: (ctx: CanvasRenderingContext2D, toPx: ToPixel) => void,
): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable; cannot build terrain grid');

  const toPx: ToPixel = (lon, lat) => {
    const w = opts.projection.project(lon, lat);
    return [(w.x - opts.origin.x) / opts.cellSize, (w.y - opts.origin.y) / opts.cellSize];
  };

  paint(ctx, toPx);

  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4]!;
  return out;
}

const classColor = (t: Terrain): string => {
  const v = t * CLASS_STEP;
  return `rgb(${v},${v},${v})`;
};

/** Decodes a raw raster of `id*20` greys into terrain classes, in place. */
export function decodeTerrainRaster(raw: Uint8Array): Uint8Array {
  for (let i = 0; i < raw.length; i++) raw[i] = Math.round(raw[i]! / CLASS_STEP);
  return raw;
}

function tracePolygon(ctx: CanvasRenderingContext2D, rings: Position[][], toPx: ToPixel): void {
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const [sx, sy] = toPx(ring[0]![0], ring[0]![1]);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = toPx(ring[i]![0], ring[i]![1]);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

function fillGeometry(ctx: CanvasRenderingContext2D, g: Geometry, toPx: ToPixel): void {
  if (g.type === 'Polygon') tracePolygon(ctx, g.coordinates, toPx);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) tracePolygon(ctx, poly, toPx);
}

function traceLine(ctx: CanvasRenderingContext2D, line: Position[], toPx: ToPixel): void {
  if (line.length < 2) return;
  const [sx, sy] = toPx(line[0]![0], line[0]![1]);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < line.length; i++) {
    const [x, y] = toPx(line[i]![0], line[i]![1]);
    ctx.lineTo(x, y);
  }
}

function strokeGeometry(ctx: CanvasRenderingContext2D, g: Geometry, toPx: ToPixel): void {
  if (g.type === 'LineString') traceLine(ctx, g.coordinates, toPx);
  else if (g.type === 'MultiLineString') for (const line of g.coordinates) traceLine(ctx, line, toPx);
}
