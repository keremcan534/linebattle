import { LambertConformalConic } from '@core/geo/projection';
import { TerrainGrid } from '@core/terrain/terrainGrid';
import { Terrain } from '@core/terrain/terrainTypes';
import type { Branch, Division } from '@core/world/division';
import { divisionId, factionId } from '@core/world/ids';
import { World } from '@core/world/world';

/**
 * Builds a small world entirely in memory — no fetch, no canvas, no DOM.
 *
 * This helper is itself evidence that the layering holds: a simulation you can
 * only construct by loading GeoJSON over HTTP and rasterising it in a browser
 * is a simulation you cannot test. `TerrainGrid` takes raw arrays for exactly
 * this reason.
 *
 * Layout: a 100x100 cell grid (10 km cells = 1000 x 1000 km) of plains, with a
 * lake and a mountain block so terrain effects are exercised.
 */
export interface TestWorldOptions {
  seed?: number | string;
  /** Cell edge in km. */
  cellSize?: number;
  width?: number;
  height?: number;
}

export function createTestWorld(opts: TestWorldOptions = {}): World {
  const cellSize = opts.cellSize ?? 10;
  const width = opts.width ?? 100;
  const height = opts.height ?? 100;

  const cells = new Uint8Array(width * height).fill(Terrain.Plains);
  const rivers = new Uint8Array(width * height);

  const paint = (x0: number, y0: number, x1: number, y1: number, t: Terrain) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) cells[y * width + x] = t;
    }
  };

  paint(40, 40, 60, 60, Terrain.Water); // a lake dead centre
  paint(70, 10, 90, 30, Terrain.Mountains);
  paint(10, 60, 30, 80, Terrain.Forest);

  // A north-south river at x = 65.
  for (let y = 0; y < height; y++) rivers[y * width + 65] = 200;

  const projection = new LambertConformalConic({ lon0: 20, lat0: 50, lat1: 45, lat2: 55 });
  const origin = { x: 0, y: 0 };
  const terrain = new TerrainGrid(origin, cellSize, width, height, cells, rivers);

  const world = new World(
    projection,
    terrain,
    { minX: 0, minY: 0, maxX: width * cellSize, maxY: height * cellSize },
    new Date('1941-06-22T03:15:00Z'),
    opts.seed ?? 'test',
  );

  world.addFaction({ id: factionId('red'), name: 'Red', alliance: 'a', color: 0xff0000, accentColor: 0xffffff });
  world.addFaction({ id: factionId('blue'), name: 'Blue', alliance: 'b', color: 0x0000ff, accentColor: 0xffffff });

  return world;
}

export function addTestDivision(
  world: World,
  id: string,
  x: number,
  y: number,
  overrides: Partial<Division> = {},
): Division {
  const d: Division = {
    id: divisionId(id),
    faction: factionId('red'),
    name: id,
    shortName: id,
    formation: 'Test Corps',
    branch: 'infantry' as Branch,
    position: { x, y },
    prevPosition: { x, y },
    heading: 0,
    order: null,
    stance: 'hold',
    manpower: 10000,
    maxManpower: 10000,
    organisation: 50,
    maxOrganisation: 50,
    morale: 0.8,
    supply: 1,
    experience: 0.3,
    speedKmh: 2,
    softAttack: 20,
    hardAttack: 10,
    defence: 20,
    hardness: 0.1,
    ...overrides,
  };
  world.addDivision(d);
  return d;
}
