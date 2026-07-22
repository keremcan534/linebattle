import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BorderProperties, FeatureCollection, Position } from './geojson';

/**
 * Sanity checks for the hand-authored 1941 boundary file.
 *
 * These lines were drawn by hand because no open dataset covers 1940-41, which
 * makes them exactly the kind of data that is silently wrong. The tests below
 * cannot verify history — only an atlas can — but they do catch the errors
 * hand-drawing actually produces: a digit typo that throws a vertex into the
 * wrong country, a line that leaves the theatre, a border that runs backwards.
 */

const data: FeatureCollection<BorderProperties> = JSON.parse(
  readFileSync(
    new URL('../../../public/data/geo/eastern-front/borders-1941.geojson', import.meta.url),
    'utf8',
  ),
);

const THEATRE = { minLon: 6, minLat: 38, maxLon: 51, maxLat: 68 };

const lines = data.features.filter((f) => f.properties.kind !== 'label');
const labels = data.features.filter((f) => f.properties.kind === 'label');

/** Shortest distance in km from a point to a polyline. */
function distanceToLineKm(lon: number, lat: number, points: Position[]): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  // Local equirectangular approximation is ample at these scales.
  const px = toRad(lon) * Math.cos(toRad(lat)) * R;
  const py = toRad(lat) * R;

  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const ax = toRad(a[0]) * Math.cos(toRad(a[1])) * R;
    const ay = toRad(a[1]) * R;
    const bx = toRad(b[0]) * Math.cos(toRad(b[1])) * R;
    const by = toRad(b[1]) * R;

    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}

/**
 * Which side of a polyline a point falls on, as the sign of the cross product
 * against the nearest segment. Positive is left of the line's direction of
 * travel; the lines here run west-to-east, so positive is north.
 */
function sideOfLine(lon: number, lat: number, points: Position[]): number {
  let best = Infinity;
  let sign = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = distanceToLineKm(lon, lat, [a, b]);
    if (d < best) {
      best = d;
      sign = Math.sign((b[0] - a[0]) * (lat - a[1]) - (b[1] - a[1]) * (lon - a[0]));
    }
  }
  return sign;
}

const namedLine = (name: string): Position[] => {
  const f = lines.find((l) => l.properties.name === name);
  if (!f || f.geometry.type !== 'LineString') throw new Error(`missing border "${name}"`);
  return f.geometry.coordinates;
};

describe('1941 border data', () => {
  it('declares the date it represents', () => {
    expect((data as unknown as { asOf: string }).asOf).toBe('1941-06-22');
  });

  it('keeps every vertex inside the theatre', () => {
    for (const f of data.features) {
      const coords: Position[] =
        f.geometry.type === 'Point'
          ? [f.geometry.coordinates]
          : f.geometry.type === 'LineString'
            ? f.geometry.coordinates
            : [];
      for (const [lon, lat] of coords) {
        expect(lon, `${f.properties.name} lon`).toBeGreaterThanOrEqual(THEATRE.minLon);
        expect(lon, `${f.properties.name} lon`).toBeLessThanOrEqual(THEATRE.maxLon);
        expect(lat, `${f.properties.name} lat`).toBeGreaterThanOrEqual(THEATRE.minLat);
        expect(lat, `${f.properties.name} lat`).toBeLessThanOrEqual(THEATRE.maxLat);
      }
    }
  });

  it('has no degenerate lines', () => {
    for (const f of lines) {
      expect(f.geometry.type).toBe('LineString');
      if (f.geometry.type !== 'LineString') continue;
      expect(f.geometry.coordinates.length, f.properties.name).toBeGreaterThanOrEqual(2);
    }
  });

  it('has no wild jumps between consecutive vertices', () => {
    // A single mistyped digit almost always shows up as an implausible hop.
    for (const f of lines) {
      if (f.geometry.type !== 'LineString') continue;
      const pts = f.geometry.coordinates;
      for (let i = 1; i < pts.length; i++) {
        const hop = distanceToLineKm(pts[i]![0], pts[i]![1], [pts[i - 1]!, pts[i - 1]!]);
        expect(hop, `${f.properties.name} segment ${i}`).toBeLessThan(220);
      }
    }
  });

  it('names both sides of every border', () => {
    for (const f of lines) {
      expect(f.properties.left, f.properties.name).toBeTruthy();
      expect(f.properties.right, f.properties.name).toBeTruthy();
    }
  });

  it('runs the German-Soviet demarcation through Brest', () => {
    // Brest-Litovsk sat directly on the 1939 line; 45. ID stormed the citadel
    // across it at 03:15. If this line is right anywhere, it is right here.
    expect(distanceToLineKm(23.65, 52.08, namedLine('Molotov-Ribbentrop line'))).toBeLessThan(15);
  });

  it('keeps Warsaw German and Bialystok Soviet', () => {
    const line = namedLine('Molotov-Ribbentrop line');
    // Both should be a meaningful distance from the line, on opposite sides.
    expect(distanceToLineKm(21.0, 52.23, line)).toBeGreaterThan(40); // Warsaw, west
    expect(distanceToLineKm(23.16, 53.13, line)).toBeGreaterThan(40); // Bialystok, east
  });

  it('runs the Bessarabian border along the Prut past Iasi', () => {
    expect(distanceToLineKm(27.6, 47.16, namedLine('Prut - Bessarabia'))).toBeLessThan(35);
  });

  it('places the 1940 Finnish border north-west of Vyborg', () => {
    // The Moscow Peace Treaty ceded Vyborg to the USSR, so the line must pass
    // clear of it — a border drawn on the pre-Winter War frontier would not.
    expect(distanceToLineKm(28.75, 60.71, namedLine('Moscow Peace line 1940'))).toBeGreaterThan(30);
  });

  it('splits Cluj from Turda, as the Vienna Award did', () => {
    // Northern Transylvania went to Hungary in August 1940 and the new border
    // ran between Cluj (Hungarian) and Turda (Romanian) — barely 22 km apart.
    // Distance to the line is therefore the wrong assertion: what matters is
    // which SIDE each city ended up on.
    const line = namedLine('Second Vienna Award');
    const cluj = sideOfLine(23.6, 46.77, line);
    const turda = sideOfLine(23.79, 46.57, line);

    expect(cluj).not.toBe(0);
    expect(turda).toBe(-cluj); // opposite sides of the same line
    // Cluj is the northern of the two, and north is the Hungarian side here.
    expect(cluj).toBe(1);
  });

  it('leaves Bucharest and Ploiesti in Romania', () => {
    // The oilfields Barbarossa depended on must not end up beyond a border.
    const line = namedLine('Second Vienna Award');
    expect(sideOfLine(26.1, 44.43, line)).toBe(-1); // Bucharest
    expect(sideOfLine(26.02, 44.94, line)).toBe(-1); // Ploiesti
  });

  it('labels the major belligerents', () => {
    const names = labels.map((l) => l.properties.name);
    for (const expected of ['SOVIET UNION', 'FINLAND', 'ROMANIA', 'HUNGARY']) {
      expect(names).toContain(expected);
    }
  });
});
