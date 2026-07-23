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
 * Each layer is rasterised as its OWN white-on-black mask and thresholded at
 * 50% coverage. The obvious alternative — painting every class into one buffer
 * as a distinct grey and decoding by value — is broken by antialiasing: the
 * canvas blends along polygon edges, and a blend between two classes that are
 * far apart numerically lands on whatever class happens to sit between them.
 * With bocage (8) meeting sea (0) along the Normandy coast that produced a
 * fringe of hills and desert on the invasion beaches. Masks make every edge
 * pixel a clean choice between the two classes that actually meet there.
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

/** Coverage above which a cell is considered to belong to the layer. */
const COVERAGE_THRESHOLD = 128;

export function buildTerrainGrid(opts: BuildTerrainOptions): TerrainGrid {
  const width = Math.ceil(opts.worldWidth / opts.cellSize);
  const height = Math.ceil(opts.worldHeight / opts.cellSize);

  // Everything is sea until a layer claims it.
  const cells = new Uint8Array(width * height).fill(Terrain.Water);

  for (const layer of opts.layers) {
    const mask = rasterise(width, height, opts, (ctx, toPx) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      for (const f of layer.data.features) {
        // Filled per feature so even-odd winding resolves holes (a lake inside
        // a landmass) without separate features cancelling each other out.
        ctx.beginPath();
        fillGeometry(ctx, f.geometry, toPx);
        ctx.fill('evenodd');
      }
    });
    for (let i = 0; i < cells.length; i++) {
      if (mask[i]! >= COVERAGE_THRESHOLD) cells[i] = layer.terrain;
    }
  }

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

type ToPixel = (lon: number, lat: number) => [number, number];

// --------------------------------------------------------------- internals --

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
  if (!ctx) throw new Error('2D canvas unavailable; cannot rasterise');

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
