import type { CityProperties, FeatureCollection, RiverProperties } from '@core/geo/geojson';
import { createProjection, type Projection } from '@core/geo/projection';
import { buildTerrainGrid, type TerrainLayerSpec } from '@core/terrain/terrainBuilder';
import { Terrain } from '@core/terrain/terrainTypes';
import type { Division } from '@core/world/division';
import { divisionId, factionId } from '@core/world/ids';
import { World, type WorldBounds } from '@core/world/world';
import { SCENARIO_FORMAT_VERSION, type DivisionTemplate, type ScenarioFile } from './schema';

/** Everything the renderer needs that is not simulation state. */
export interface MapData {
  land: FeatureCollection;
  lakes: FeatureCollection | null;
  rivers: FeatureCollection<RiverProperties> | null;
  cities: FeatureCollection<CityProperties> | null;
}

export interface LoadedScenario {
  scenario: ScenarioFile;
  world: World;
  mapData: MapData;
}

export interface LoadProgress {
  (stage: string, fraction: number): void;
}

const TERRAIN_BY_NAME: Record<string, Terrain> = {
  forest: Terrain.Forest,
  marsh: Terrain.Marsh,
  hills: Terrain.Hills,
  mountains: Terrain.Mountains,
  urban: Terrain.Urban,
};

/**
 * Loads a scenario file and everything it references into a ready World.
 *
 * The whole pipeline lives in one function on purpose: it is the only place
 * that knows the order of operations (projection → bounds → terrain →
 * entities), and every step depends on the previous one. Splitting it would
 * scatter that dependency without buying anything.
 */
export async function loadScenario(url: string, onProgress?: LoadProgress): Promise<LoadedScenario> {
  const report = onProgress ?? (() => {});

  report('Reading scenario', 0);
  const scenario = await fetchJson<ScenarioFile>(url);
  validate(scenario);

  report('Loading map data', 0.1);
  const base = new URL(url, window.location.href);
  const [land, lakes, rivers, cities, overlays] = await Promise.all([
    fetchJson<FeatureCollection>(resolve(scenario.map.layers.land, base)),
    optionalJson<FeatureCollection>(scenario.map.layers.lakes, base),
    optionalJson<FeatureCollection<RiverProperties>>(scenario.map.layers.rivers, base),
    optionalJson<FeatureCollection<CityProperties>>(scenario.map.layers.cities, base),
    optionalJson<FeatureCollection<{ terrain?: string }>>(scenario.map.layers.overlays, base),
  ]);

  report('Projecting theatre', 0.35);
  const projection = createProjection(scenario.map.projection);
  const bounds = computeWorldBounds(projection, scenario.map.bounds);

  report('Rasterising terrain', 0.45);
  const layers: TerrainLayerSpec[] = [{ data: land, terrain: Terrain.Plains }];

  // Overlays are grouped by terrain class so each class is painted as one
  // layer, preserving a deterministic paint order regardless of file order.
  if (overlays) {
    for (const [name, terrain] of Object.entries(TERRAIN_BY_NAME)) {
      const features = overlays.features.filter((f) => f.properties.terrain === name);
      if (features.length) {
        layers.push({ data: { type: 'FeatureCollection', features }, terrain });
      }
    }
  }
  // Lakes last: an inland sea must win over any land layer painted above it.
  if (lakes) layers.push({ data: lakes, terrain: Terrain.Water });

  const terrain = buildTerrainGrid({
    projection,
    origin: { x: bounds.minX, y: bounds.minY },
    worldWidth: bounds.maxX - bounds.minX,
    worldHeight: bounds.maxY - bounds.minY,
    cellSize: scenario.map.terrainCellSizeKm,
    layers,
    ...(rivers ? { rivers } : {}),
  });

  report('Deploying forces', 0.8);
  // An explicit seed makes a scenario reproducible run to run; falling back to
  // the scenario id keeps it reproducible even when the author omits one.
  const world = new World(
    projection,
    terrain,
    bounds,
    new Date(scenario.startDate),
    scenario.seed ?? scenario.id,
  );

  for (const f of scenario.factions) {
    world.addFaction({
      id: factionId(f.id),
      name: f.name,
      alliance: f.alliance,
      color: parseHexColor(f.color),
      accentColor: parseHexColor(f.accentColor ?? '#ffffff'),
    });
  }

  for (const spec of scenario.divisions) {
    const template = scenario.templates[spec.template];
    if (!template) throw new Error(`Division "${spec.id}" references unknown template "${spec.template}"`);
    if (!world.getFaction(factionId(spec.faction))) {
      throw new Error(`Division "${spec.id}" references unknown faction "${spec.faction}"`);
    }
    world.addDivision(instantiate(spec, template, projection));
  }

  report('Ready', 1);
  return { scenario, world, mapData: { land, lakes, rivers, cities } };
}

// --------------------------------------------------------------- internals --

function instantiate(
  spec: ScenarioFile['divisions'][number],
  t: DivisionTemplate,
  projection: Projection,
): Division {
  const position = projection.project(spec.lon, spec.lat);
  const manpower = t.maxManpower * (spec.strength ?? 1);
  const organisation = t.maxOrganisation * (spec.organisation ?? 1);

  return {
    id: divisionId(spec.id),
    faction: factionId(spec.faction),
    name: spec.name,
    shortName: spec.shortName ?? spec.name,
    formation: spec.formation ?? '',
    branch: t.branch,
    position,
    prevPosition: { ...position },
    heading: 0,
    order: null,
    stance: 'hold',
    manpower,
    maxManpower: t.maxManpower,
    organisation,
    maxOrganisation: t.maxOrganisation,
    morale: spec.morale ?? t.morale ?? 0.8,
    supply: spec.supply ?? t.supply ?? 1,
    experience: spec.experience ?? t.experience ?? 0.3,
    speedKmh: t.speedKmh,
    softAttack: t.softAttack,
    hardAttack: t.hardAttack,
    defence: t.defence,
    hardness: t.hardness,
  };
}

/**
 * World-space extent of the geographic bounds.
 *
 * LCC maps the lon/lat rectangle to a curved trapezium, so projecting the four
 * corners is not enough — the northern edge bows. We sample along the boundary
 * and take the extremes, which is exact enough at 32 samples per edge.
 */
function computeWorldBounds(
  projection: Projection,
  b: { minLon: number; minLat: number; maxLon: number; maxLat: number },
): WorldBounds {
  const SAMPLES = 32;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const consider = (lon: number, lat: number) => {
    const p = projection.project(lon, lat);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  for (let i = 0; i <= SAMPLES; i++) {
    const tLon = b.minLon + ((b.maxLon - b.minLon) * i) / SAMPLES;
    const tLat = b.minLat + ((b.maxLat - b.minLat) * i) / SAMPLES;
    consider(tLon, b.minLat);
    consider(tLon, b.maxLat);
    consider(b.minLon, tLat);
    consider(b.maxLon, tLat);
  }

  return { minX, minY, maxX, maxY };
}

function validate(s: ScenarioFile): void {
  if (s.formatVersion !== SCENARIO_FORMAT_VERSION) {
    throw new Error(
      `Scenario "${s.id}" uses format version ${s.formatVersion}, this build expects ${SCENARIO_FORMAT_VERSION}`,
    );
  }
  if (Number.isNaN(Date.parse(s.startDate))) throw new Error(`Invalid startDate "${s.startDate}"`);
  if (!s.factions.length) throw new Error('Scenario declares no factions');
  if (!s.factions.some((f) => f.id === s.playerFaction)) {
    throw new Error(`playerFaction "${s.playerFaction}" is not among the declared factions`);
  }
}

const resolve = (path: string, base: URL): string => new URL(path, base).href;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function optionalJson<T>(path: string | undefined, base: URL): Promise<T | null> {
  return path ? fetchJson<T>(resolve(path, base)) : null;
}

export function parseHexColor(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) || 0xffffff;
}
