import type {
  BorderProperties,
  CityProperties,
  FeatureCollection,
  RiverProperties,
} from '@core/geo/geojson';
import { createProjection, type Projection } from '@core/geo/projection';
import {
  CONTROL_CELL_SIZE_KM,
  type InitialControlGrid,
} from '@core/supply/supplyField';
import { buildTerrainGrid, type TerrainLayerSpec } from '@core/terrain/terrainBuilder';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
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
  borders: FeatureCollection<BorderProperties> | null;
}

export interface LoadedScenario {
  scenario: ScenarioFile;
  world: World;
  mapData: MapData;
}

export interface LoadProgress {
  (stage: string, fraction: number): void;
}

/**
 * Overlay classes in PAINT ORDER — later entries win where polygons overlap.
 *
 * The order encodes real decisions, so it is an explicit list rather than an
 * object whose iteration order is incidental:
 *  - `desert` is a continental base coat; `plains` is painted over it for the
 *    Via Balbia coastal strip, which is the only ground an army can be
 *    supplied along in the Western Desert.
 *  - `marsh` beats `bocage` and the uplands, because flooded ground is flooded
 *    whatever the hedgerows are doing — the Marais du Cotentin over the
 *    Norman bocage.
 *  - `urban` is last: a city sits on top of whatever it was built on.
 */
const OVERLAY_PAINT_ORDER: readonly (readonly [string, Terrain])[] = [
  ['desert', Terrain.Desert],
  ['plains', Terrain.Plains],
  ['forest', Terrain.Forest],
  ['bocage', Terrain.Bocage],
  ['hills', Terrain.Hills],
  ['mountains', Terrain.Mountains],
  ['marsh', Terrain.Marsh],
  ['urban', Terrain.Urban],
];

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
  const [land, lakes, rivers, cities, overlays, borders, nations] = await Promise.all([
    fetchJson<FeatureCollection>(resolve(scenario.map.layers.land, base)),
    optionalJson<FeatureCollection>(scenario.map.layers.lakes, base),
    optionalJson<FeatureCollection<RiverProperties>>(scenario.map.layers.rivers, base),
    optionalJson<FeatureCollection<CityProperties>>(scenario.map.layers.cities, base),
    optionalJson<FeatureCollection<{ terrain?: string }>>(scenario.map.layers.overlays, base),
    optionalJson<FeatureCollection<BorderProperties>>(scenario.map.layers.borders, base),
    optionalJson<FeatureCollection<{ name?: string }>>(scenario.map.layers.nations, base),
  ]);

  report('Projecting theatre', 0.35);
  const projection = createProjection(scenario.map.projection);
  const bounds = computeWorldBounds(projection, scenario.map.bounds);

  report('Rasterising terrain', 0.45);
  const layers: TerrainLayerSpec[] = [{ data: land, terrain: Terrain.Plains }];

  // Overlays are grouped by terrain class so each class is painted as one
  // layer, preserving a deterministic paint order regardless of file order.
  if (overlays) {
    for (const [name, terrain] of OVERLAY_PAINT_ORDER) {
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

  if (scenario.campaign) {
    const allianceOf = (faction: string): string => {
      const alliance = scenario.factions.find((f) => f.id === faction)?.alliance;
      if (!alliance) throw new Error(`Campaign policy references unknown faction "${faction}"`);
      return alliance;
    };
    world.configureCampaign(
      (scenario.campaign.mobilization ?? []).map((policy) => ({
        alliance: allianceOf(policy.faction),
        daysPerDivision: policy.daysPerDivision,
        maxForceMultiplier: policy.maxForceMultiplier,
        divisionsPerFrontlineSegment: policy.divisionsPerFrontlineSegment ?? 0.75,
      })),
      (scenario.campaign.plans ?? []).map((plan) => ({
        alliance: allianceOf(plan.faction),
        ...(plan.openingShock
          ? {
              openingShock: {
                ...(plan.openingShock.from
                  ? { from: Date.parse(plan.openingShock.from) }
                  : {}),
                until: Date.parse(plan.openingShock.until),
                combatMultiplier: plan.openingShock.combatMultiplier,
                recoveryMultiplier: plan.openingShock.recoveryMultiplier,
              },
            }
          : {}),
        ...(plan.fallback
          ? {
              fallback: {
                until: Date.parse(plan.fallback.until),
                line: plan.fallback.line.map((point) =>
                  projection.project(point.lon, point.lat),
                ),
                rearOffsetKm: plan.fallback.rearOffsetKm ?? 18,
                influenceKm: plan.fallback.influenceKm ?? 320,
                rearward:
                  plan.fallback.rearward === 'west'
                    ? { x: -1, y: 0 }
                    : plan.fallback.rearward === 'north'
                      ? { x: 0, y: -1 }
                      : plan.fallback.rearward === 'south'
                        ? { x: 0, y: 1 }
                        : { x: 1, y: 0 },
              },
            }
          : {}),
        ...(plan.halt
          ? {
              halt: {
                from: Date.parse(plan.halt.from),
                until: Date.parse(plan.halt.until),
                combatMultiplier: plan.halt.combatMultiplier,
                recoveryMultiplier: plan.halt.recoveryMultiplier,
              },
            }
          : {}),
        ...(plan.offensive
          ? {
              offensive: {
                from: Date.parse(plan.offensive.from),
                target: projection.project(
                  plan.offensive.target.lon,
                  plan.offensive.target.lat,
                ),
                influenceKm: plan.offensive.influenceKm,
              },
            }
          : {}),
        ...(plan.nationalResolve
          ? {
              nationalResolve: {
                maximumAtTerritoryLoss:
                  plan.nationalResolve.maximumAtTerritoryLoss,
                combatMultiplier: plan.nationalResolve.combatMultiplier,
                recoveryMultiplier: plan.nationalResolve.recoveryMultiplier,
                mobilizationMultiplier:
                  plan.nationalResolve.mobilizationMultiplier,
              },
            }
          : {}),
      })),
    );
  }

  if (scenario.supply) {
    const initialControl = scenario.supply.initialControl
      ? buildInitialControlGrid(
          scenario,
          nations,
          projection,
          terrain,
        )
      : undefined;
    world.enableSupply(
      scenario.supply.sources.map((s) => {
        const alliance = scenario.factions.find((f) => f.id === s.faction)?.alliance;
        if (!alliance) throw new Error(`Supply source "${s.name}" references unknown faction "${s.faction}"`);
        return {
          name: s.name,
          alliance,
          position: projection.project(s.lon, s.lat),
          rangeKm: s.rangeKm,
          capturable: s.capturable ?? false,
          networkRoot: s.networkRoot ?? !(s.capturable ?? false),
        };
      }),
      scenario.supply.climate ?? 'temperate',
      initialControl,
    );
  }

  reportDeployment(world);

  report('Ready', 1);
  return { scenario, world, mapData: { land, lakes, rivers, cities, borders } };
}

// --------------------------------------------------------------- internals --

function buildInitialControlGrid(
  scenario: ScenarioFile,
  nations: FeatureCollection<{ name?: string }> | null,
  projection: Projection,
  terrain: TerrainGrid,
): InitialControlGrid {
  const spec = scenario.supply?.initialControl;
  if (!spec) throw new Error('Initial control requested without a control specification');
  if (!nations) {
    throw new Error(
      `Scenario "${scenario.id}" declares initial control but no nations map layer`,
    );
  }

  const allianceOf = (faction: string): string => {
    const alliance = scenario.factions.find((entry) => entry.id === faction)
      ?.alliance;
    if (!alliance) {
      throw new Error(
        `Initial control references unknown faction "${faction}"`,
      );
    }
    return alliance;
  };
  const alliances = [
    ...new Set([
      ...spec.countries.map((group) => allianceOf(group.faction)),
      ...(spec.overrides ?? []).map((region) =>
        allianceOf(region.faction),
      ),
    ]),
  ].sort();
  if (alliances.length > 8) {
    throw new Error('Initial control supports at most eight alliances');
  }

  const layers: TerrainLayerSpec[] = [];
  for (const group of spec.countries) {
    const names = new Set(group.names);
    const features = nations.features.filter((feature) =>
      feature.properties.name
        ? names.has(feature.properties.name)
        : false,
    );
    const alliance = allianceOf(group.faction);
    layers.push({
      data: { type: 'FeatureCollection', features },
      terrain: (alliances.indexOf(alliance) + 1) as Terrain,
    });
  }

  for (const region of spec.overrides ?? []) {
    const alliance = allianceOf(region.faction);
    layers.push({
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                region.polygon.map(
                  (point) => [point.lon, point.lat] as [number, number],
                ),
              ],
            },
          },
        ],
      },
      terrain: (alliances.indexOf(alliance) + 1) as Terrain,
    });
  }

  const grid = buildTerrainGrid({
    projection,
    origin: terrain.origin,
    worldWidth: terrain.worldWidth,
    worldHeight: terrain.worldHeight,
    cellSize: CONTROL_CELL_SIZE_KM,
    layers,
  });
  return { cells: grid.cells, alliances };
}

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
    state: 'FRONTLINE',
    advance: null,
    frontlineSegment: null,
    manpower,
    maxManpower: t.maxManpower,
    organisation,
    maxOrganisation: t.maxOrganisation,
    morale: spec.morale ?? t.morale ?? 0.8,
    supply: spec.supply ?? t.supply ?? 1,
    encircled: false,
    encircledTicks: 0,
    experience: spec.experience ?? t.experience ?? 0.3,
    equipmentRatio: spec.equipmentRatio ?? t.equipmentRatio ?? 1,
    doctrine: spec.doctrine ?? t.doctrine ?? 1,
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
  const boundary: { x: number; y: number }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const append = (lon: number, lat: number) => {
    const p = projection.project(lon, lat);
    boundary.push(p);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  // Walk the perimeter once in order. Duplicate corners are deliberately
  // omitted; Pixi closes the last edge for the theatre mask.
  for (let i = 0; i < SAMPLES; i++)
    append(b.minLon + ((b.maxLon - b.minLon) * i) / SAMPLES, b.minLat);
  for (let i = 0; i < SAMPLES; i++)
    append(b.maxLon, b.minLat + ((b.maxLat - b.minLat) * i) / SAMPLES);
  for (let i = 0; i < SAMPLES; i++)
    append(b.maxLon - ((b.maxLon - b.minLon) * i) / SAMPLES, b.maxLat);
  for (let i = 0; i < SAMPLES; i++)
    append(b.minLon, b.maxLat - ((b.maxLat - b.minLat) * i) / SAMPLES);

  return { minX, minY, maxX, maxY, boundary };
}

/**
 * Rescues divisions authored onto impassable ground, loudly.
 *
 * Coordinates are written by hand against a coastline the author cannot see,
 * and at 2-4 km cells a beach landing is easily a cell offshore. A division
 * that starts in water is not merely misplaced — it can never move, because
 * water is impassable, so the symptom is one silent unit that ignores every
 * order for the rest of the campaign.
 *
 * Snapping keeps the scenario playable; the warning keeps the mistake visible.
 * Failing the load outright would be worse: one stray coordinate should not
 * cost the player the whole campaign.
 */
function reportDeployment(world: World): void {
  const moved: string[] = [];
  const lost: string[] = [];

  for (const d of world.divisions.values()) {
    if (world.terrain.isPassableAt(d.position)) continue;
    const snapped = world.terrain.nearestPassable(d.position, 150);
    if (!snapped) {
      lost.push(d.name);
      continue;
    }
    const km = Math.hypot(snapped.x - d.position.x, snapped.y - d.position.y);
    const { lon, lat } = world.projection.unproject(snapped);
    d.position = snapped;
    d.prevPosition = { ...snapped };
    moved.push(`${d.id} (${d.name}) — ${km.toFixed(0)} km, try lon ${lon.toFixed(3)} lat ${lat.toFixed(3)}`);
  }

  if (moved.length) {
    console.warn(
      `Scenario deploys ${moved.length} division(s) on impassable terrain; moved to the nearest passable ground:\n  ${moved.join('\n  ')}`,
    );
  }
  if (lost.length) {
    console.error(
      `Scenario deploys ${lost.length} division(s) with no passable ground within 150 km: ${lost.join(', ')}`,
    );
  }
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
  const factionIds = new Set(s.factions.map((f) => f.id));
  for (const policy of s.campaign?.mobilization ?? []) {
    if (!factionIds.has(policy.faction)) {
      throw new Error(`Mobilization policy references unknown faction "${policy.faction}"`);
    }
    if (
      policy.daysPerDivision <= 0 ||
      policy.maxForceMultiplier < 1 ||
      (policy.divisionsPerFrontlineSegment ?? 0.75) < 0
    ) {
      throw new Error(`Invalid mobilization policy for "${policy.faction}"`);
    }
  }
  for (const plan of s.campaign?.plans ?? []) {
    if (!factionIds.has(plan.faction)) {
      throw new Error(`Campaign plan references unknown faction "${plan.faction}"`);
    }
    const dates = [
      plan.openingShock?.from,
      plan.openingShock?.until,
      plan.fallback?.until,
      plan.halt?.from,
      plan.halt?.until,
      plan.offensive?.from,
    ];
    if (dates.some((date) => date !== undefined && Number.isNaN(Date.parse(date)))) {
      throw new Error(`Campaign plan for "${plan.faction}" contains an invalid date`);
    }
    if (plan.fallback && plan.fallback.line.length < 2) {
      throw new Error(`Fallback plan for "${plan.faction}" needs at least two line points`);
    }
    if (
      plan.nationalResolve &&
      (plan.nationalResolve.maximumAtTerritoryLoss <= 0 ||
        plan.nationalResolve.maximumAtTerritoryLoss > 1 ||
        plan.nationalResolve.combatMultiplier <= 0 ||
        plan.nationalResolve.recoveryMultiplier <= 0 ||
        plan.nationalResolve.mobilizationMultiplier <= 0)
    ) {
      throw new Error(`Invalid national resolve plan for "${plan.faction}"`);
    }
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
