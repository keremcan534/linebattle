import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProjection } from '@core/geo/projection';
import { SCENARIO_FORMAT_VERSION, type ScenarioFile } from './schema';

/**
 * Static validation of every shipped scenario.
 *
 * These run in Node with no canvas, so they cannot rasterise terrain and
 * cannot answer "is this division standing in the sea?" — that check lives in
 * the browser smoke test. What they can do is catch everything that is purely
 * a property of the file: dangling template references, divisions deployed
 * outside their own map bounds, duplicate ids, a playerFaction that does not
 * exist. Those are the mistakes hand-authored orders of battle actually make.
 */

const read = <T,>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../../../public/data/${path}`, import.meta.url), 'utf8')) as T;

interface IndexEntry {
  id: string;
  file: string;
  name: string;
  date: string;
  theatre: string;
  blurb: string;
}

const index = read<{ scenarios: IndexEntry[] }>('scenarios/index.json');
const scenarios = index.scenarios.map((entry) => ({
  entry,
  file: read<ScenarioFile>(`scenarios/${entry.file}`),
}));
const combatLab = scenarios.find(({ entry }) => entry.id === 'combat-lab-1941')?.file;
const barbarossa = scenarios.find(({ entry }) => entry.id === 'barbarossa-1941')?.file;

describe('scenario index', () => {
  it('lists at least the three shipped campaigns', () => {
    expect(index.scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it('agrees with the id inside each scenario file', () => {
    for (const { entry, file } of scenarios) expect(file.id).toBe(entry.id);
  });
});

describe('combat laboratory', () => {
  it('is a square 10v10 controlled experiment', () => {
    expect(combatLab).toBeDefined();
    const alliances = new Map(combatLab!.factions.map((f) => [f.id, f.alliance]));
    const counts = new Map<string, number>();
    for (const d of combatLab!.divisions) {
      const alliance = alliances.get(d.faction)!;
      counts.set(alliance, (counts.get(alliance) ?? 0) + 1);
    }
    expect([...counts.values()].sort((a, b) => a - b)).toEqual([10, 10]);

    const projection = createProjection(combatLab!.map.projection);
    const b = combatLab!.map.bounds;
    const topLeft = projection.project(b.minLon, b.maxLat);
    const bottomRight = projection.project(b.maxLon, b.minLat);
    const width = Math.abs(bottomRight.x - topLeft.x);
    const height = Math.abs(bottomRight.y - topLeft.y);
    expect(width / height).toBeCloseTo(1, 3);
  });
});

describe('Barbarossa campaign plan', () => {
  it('recruits Soviets faster and defines fallback, winter and grand-offensive phases', () => {
    expect(barbarossa?.campaign).toBeDefined();
    const policies = barbarossa!.campaign!.mobilization!;
    const soviet = policies.find((policy) => policy.faction === 'soviet')!;
    const german = policies.find((policy) => policy.faction === 'germany')!;
    expect(soviet.daysPerDivision).toBeLessThan(german.daysPerDivision);
    expect(soviet.maxForceMultiplier).toBeGreaterThan(german.maxForceMultiplier);

    const sovietPlan = barbarossa!.campaign!.plans!.find(
      (plan) => plan.faction === 'soviet',
    )!;
    const germanPlan = barbarossa!.campaign!.plans!.find(
      (plan) => plan.faction === 'germany',
    )!;
    expect(sovietPlan.openingShock?.combatMultiplier).toBeLessThan(1);
    expect(sovietPlan.fallback?.line.length).toBeGreaterThanOrEqual(6);
    expect(sovietPlan.halt?.combatMultiplier).toBe(1);
    expect(sovietPlan.nationalResolve?.combatMultiplier).toBeGreaterThan(1);
    expect(sovietPlan.nationalResolve?.mobilizationMultiplier).toBeGreaterThan(1);
    expect(germanPlan.halt?.combatMultiplier).toBe(1);
    expect(germanPlan.halt?.recoveryMultiplier).toBeLessThan(1);
    // The Axis drives on Moscow from the opening day so the 1941 front reaches
    // the historical line before the winter halt freezes it. (The 1942 summer
    // offensive becomes a player choice in the Grand Operation screen.)
    expect(germanPlan.offensive?.from).toContain('1941');
    expect(germanPlan.offensive?.target.lon).toBeGreaterThan(35);
    expect(germanPlan.offensive?.target.lon).toBeLessThan(40);
  });

  it('keeps 1941 East Prussia on the Axis side of the opening frontier', () => {
    const overrides = barbarossa!.supply!.initialControl!.overrides!;
    const koenigsberg = { lon: 20.51, lat: 54.71 };
    const containing = overrides.filter(({ polygon }) => {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i]!;
        const b = polygon[j]!;
        if (
          (a.lat > koenigsberg.lat) !== (b.lat > koenigsberg.lat) &&
          koenigsberg.lon <
            ((b.lon - a.lon) * (koenigsberg.lat - a.lat)) /
              (b.lat - a.lat) +
              a.lon
        ) {
          inside = !inside;
        }
      }
      return inside;
    });

    // Overrides are paint-ordered, so the last containing region is the
    // effective 22 June owner even though modern Russia includes Kaliningrad.
    expect(containing.at(-1)?.faction).toBe('germany');
  });
});

describe.each(scenarios)('scenario: $entry.name', ({ file }) => {
  it('declares the supported format version', () => {
    expect(file.formatVersion).toBe(SCENARIO_FORMAT_VERSION);
  });

  it('has a parseable start date', () => {
    expect(Number.isNaN(Date.parse(file.startDate))).toBe(false);
  });

  it('names a playerFaction that exists', () => {
    expect(file.factions.map((f) => f.id)).toContain(file.playerFaction);
  });

  it('has at least two opposing alliances', () => {
    expect(new Set(file.factions.map((f) => f.alliance)).size).toBeGreaterThanOrEqual(2);
  });

  it('gives the player a commandable force', () => {
    const alliance = file.factions.find((f) => f.id === file.playerFaction)!.alliance;
    const friendly = new Set(file.factions.filter((f) => f.alliance === alliance).map((f) => f.id));
    const commandable = file.divisions.filter((d) => friendly.has(d.faction));
    expect(commandable.length).toBeGreaterThan(0);
  });

  it('uses unique division ids', () => {
    const ids = file.divisions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references only declared templates and factions', () => {
    const factions = new Set(file.factions.map((f) => f.id));
    for (const d of file.divisions) {
      expect(file.templates[d.template], `${d.id} -> template ${d.template}`).toBeDefined();
      expect(factions.has(d.faction), `${d.id} -> faction ${d.faction}`).toBe(true);
    }
  });

  it('keeps campaign policies valid and inside the theatre', () => {
    const campaign = file.campaign;
    if (!campaign) return;
    const factions = new Set(file.factions.map((f) => f.id));
    const bounds = file.map.bounds;

    for (const policy of campaign.mobilization ?? []) {
      expect(factions.has(policy.faction)).toBe(true);
      expect(policy.daysPerDivision).toBeGreaterThan(0);
      expect(policy.maxForceMultiplier).toBeGreaterThanOrEqual(1);
      expect(policy.divisionsPerFrontlineSegment ?? 0.75).toBeGreaterThanOrEqual(0);
    }
    for (const plan of campaign.plans ?? []) {
      expect(factions.has(plan.faction)).toBe(true);
      for (const date of [
        plan.openingShock?.from,
        plan.openingShock?.until,
        plan.fallback?.until,
        plan.halt?.from,
        plan.halt?.until,
        plan.offensive?.from,
      ]) {
        if (date) expect(Number.isNaN(Date.parse(date))).toBe(false);
      }
      expect(plan.fallback?.line.length ?? 2).toBeGreaterThanOrEqual(2);
      if (plan.nationalResolve) {
        expect(plan.nationalResolve.maximumAtTerritoryLoss).toBeGreaterThan(0);
        expect(plan.nationalResolve.maximumAtTerritoryLoss).toBeLessThanOrEqual(1);
        expect(plan.nationalResolve.combatMultiplier).toBeGreaterThan(0);
        expect(plan.nationalResolve.recoveryMultiplier).toBeGreaterThan(0);
        expect(plan.nationalResolve.mobilizationMultiplier).toBeGreaterThan(0);
      }
      for (const point of plan.fallback?.line ?? []) {
        expect(point.lon).toBeGreaterThanOrEqual(bounds.minLon);
        expect(point.lon).toBeLessThanOrEqual(bounds.maxLon);
        expect(point.lat).toBeGreaterThanOrEqual(bounds.minLat);
        expect(point.lat).toBeLessThanOrEqual(bounds.maxLat);
      }
      const target = plan.offensive?.target;
      if (target) {
        expect(target.lon).toBeGreaterThanOrEqual(bounds.minLon);
        expect(target.lon).toBeLessThanOrEqual(bounds.maxLon);
        expect(target.lat).toBeGreaterThanOrEqual(bounds.minLat);
        expect(target.lat).toBeLessThanOrEqual(bounds.maxLat);
      }
    }
  });

  it('ships no unused templates', () => {
    const used = new Set(file.divisions.map((d) => d.template));
    for (const name of Object.keys(file.templates)) expect(used.has(name), `unused: ${name}`).toBe(true);
  });

  it('deploys every division inside the map bounds', () => {
    const b = file.map.bounds;
    for (const d of file.divisions) {
      expect(d.lon, `${d.id} lon`).toBeGreaterThanOrEqual(b.minLon);
      expect(d.lon, `${d.id} lon`).toBeLessThanOrEqual(b.maxLon);
      expect(d.lat, `${d.id} lat`).toBeGreaterThanOrEqual(b.minLat);
      expect(d.lat, `${d.id} lat`).toBeLessThanOrEqual(b.maxLat);
    }
  });

  it('brackets its own latitude range with the projection standard parallels', () => {
    // An LCC whose parallels do not straddle the theatre compresses or
    // stretches the whole map — the mistake that cost 1.2% on the Eastern
    // Front until it was measured.
    if (file.map.projection.type !== 'lcc') return;
    const { lat1, lat2 } = file.map.projection;
    const lo = Math.min(lat1, lat2);
    const hi = Math.max(lat1, lat2);
    expect(lo).toBeGreaterThan(file.map.bounds.minLat);
    expect(hi).toBeLessThan(file.map.bounds.maxLat);
    expect(hi - lo).toBeGreaterThan(2);
  });

  it('keeps projected world size plausible for its terrain resolution', () => {
    const projection = createProjection(file.map.projection);
    const b = file.map.bounds;
    const a = projection.project(b.minLon, b.minLat);
    const c = projection.project(b.maxLon, b.maxLat);
    const widthKm = Math.abs(c.x - a.x);
    const heightKm = Math.abs(c.y - a.y);
    const cells = (widthKm / file.map.terrainCellSizeKm) * (heightKm / file.map.terrainCellSizeKm);

    expect(widthKm).toBeGreaterThan(100);
    // A grid over ~8M cells means an 8 MB buffer built at load; that is a
    // design decision, not something to stumble into.
    expect(cells, `${Math.round(cells / 1000)}k cells`).toBeLessThan(8_000_000);
  });

  it('gives every division a plausible operational speed', () => {
    for (const [name, t] of Object.entries(file.templates)) {
      // km/h sustained, including halts: 0.8 = 19 km/day, 3.2 = 77 km/day.
      expect(t.speedKmh, `${name} too slow`).toBeGreaterThanOrEqual(0.8);
      expect(t.speedKmh, `${name} too fast`).toBeLessThanOrEqual(3.2);
      expect(t.maxManpower).toBeGreaterThan(1000);
      expect(t.maxOrganisation).toBeGreaterThan(0);
    }
  });

  it('keeps optional 0..1 stats inside 0..1', () => {
    for (const d of file.divisions) {
      for (const key of ['strength', 'organisation', 'experience', 'morale', 'supply'] as const) {
        const v = d[key];
        if (v === undefined) continue;
        expect(v, `${d.id}.${key}`).toBeGreaterThan(0);
        expect(v, `${d.id}.${key}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
