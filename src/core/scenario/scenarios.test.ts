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

describe('scenario index', () => {
  it('lists at least the three shipped campaigns', () => {
    expect(index.scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it('agrees with the id inside each scenario file', () => {
    for (const { entry, file } of scenarios) expect(file.id).toBe(entry.id);
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
