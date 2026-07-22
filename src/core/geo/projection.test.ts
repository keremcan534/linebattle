import { describe, expect, it } from 'vitest';
import { Equirectangular, LambertConformalConic, createProjection } from './projection';

/** Great-circle distance in km, as ground truth for scale checks. */
function haversineKm(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Must mirror the projection declared in barbarossa-1941.json. */
const EASTERN_FRONT = new LambertConformalConic({ lon0: 28, lat0: 52, lat1: 47, lat2: 59 });

describe('LambertConformalConic', () => {
  it('round-trips across the theatre', () => {
    for (let lon = 6; lon <= 50; lon += 4) {
      for (let lat = 38; lat <= 66; lat += 4) {
        const back = EASTERN_FRONT.unproject(EASTERN_FRONT.project(lon, lat));
        expect(back.lon).toBeCloseTo(lon, 8);
        expect(back.lat).toBeCloseTo(lat, 8);
      }
    }
  });

  it('puts y increasing southwards', () => {
    // The renderer depends on this: world space matches screen conventions so
    // no layer has to flip a sign.
    const north = EASTERN_FRONT.project(28, 60);
    const south = EASTERN_FRONT.project(28, 45);
    expect(south.y).toBeGreaterThan(north.y);
  });

  it('puts x increasing eastwards', () => {
    expect(EASTERN_FRONT.project(40, 52).x).toBeGreaterThan(EASTERN_FRONT.project(20, 52).x);
  });

  it('holds operational distances within 0.6% of ground truth', () => {
    // This is the whole reason for choosing LCC over Web Mercator: a kilometre
    // of world space must be a kilometre on the ground, at Leningrad's
    // latitude as much as at Odessa's.
    //
    // 0.6% is the MEASURED bound for the 47/59 standard parallels, not a
    // round number picked to be safe. Widening the parallels to 44/62 pushes
    // these same pairs to 1.23%; the threshold is deliberately tight enough
    // that such a regression fails here.
    const pairs: [string, number, number, number, number][] = [
      ['Brest-Minsk', 23.5, 52.1, 27.6, 53.9],
      ['Kyiv-Moscow', 30.5, 50.5, 37.6, 55.8],
      ['Leningrad-Chisinau', 30.3, 59.9, 28.9, 47.0],
      ['Warsaw-Lviv', 21.0, 52.2, 24.0, 49.8],
      ['Berlin-Moscow', 13.4, 52.5, 37.6, 55.8],
      ['Odessa-Leningrad', 30.7, 46.5, 30.3, 59.9],
      ['Riga-Sevastopol', 24.1, 56.9, 33.5, 44.6],
    ];

    for (const [name, aLon, aLat, bLon, bLat] of pairs) {
      const a = EASTERN_FRONT.project(aLon, aLat);
      const b = EASTERN_FRONT.project(bLon, bLat);
      const projected = Math.hypot(b.x - a.x, b.y - a.y);
      const truth = haversineKm(aLon, aLat, bLon, bLat);
      const error = Math.abs(projected - truth) / truth;
      expect(error, `${name} scale error ${(error * 100).toFixed(2)}%`).toBeLessThan(0.006);
    }
  });

  it('keeps local scale within 0.6% across the zone that sees fighting', () => {
    // 45-60N covers every front from the Crimea to Leningrad. Outside it the
    // error grows to ~2.7% at the extreme corners of the bounding box, which
    // is empty sea and tundra — an accepted trade, documented here so nobody
    // "fixes" the parallels back without knowing what they are trading.
    for (let lon = 6; lon <= 50; lon += 4) {
      for (let lat = 45; lat <= 60; lat += 3) {
        const step = 0.4;
        const origin = EASTERN_FRONT.project(lon, lat);
        const east = EASTERN_FRONT.project(lon + step, lat);
        const north = EASTERN_FRONT.project(lon, lat + step);

        const eastError =
          Math.abs(Math.hypot(east.x - origin.x, east.y - origin.y) - haversineKm(lon, lat, lon + step, lat)) /
          haversineKm(lon, lat, lon + step, lat);
        const northError =
          Math.abs(Math.hypot(north.x - origin.x, north.y - origin.y) - haversineKm(lon, lat, lon, lat + step)) /
          haversineKm(lon, lat, lon, lat + step);

        expect(Math.max(eastError, northError)).toBeLessThan(0.006);
      }
    }
  });

  it('is far more accurate than the Mercator alternative it replaced', () => {
    // Sanity-check the premise of the decision rather than trusting the doc.
    const mercatorY = (lat: number) =>
      6371.0088 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));

    const truth = haversineKm(30, 50, 30, 60);
    const mercator = Math.abs(mercatorY(60) - mercatorY(50));
    const a = EASTERN_FRONT.project(30, 50);
    const b = EASTERN_FRONT.project(30, 60);
    const lcc = Math.hypot(b.x - a.x, b.y - a.y);

    const lccError = Math.abs(lcc - truth) / truth;
    const mercatorError = Math.abs(mercator - truth) / truth;
    expect(lccError).toBeLessThan(mercatorError);
    expect(mercatorError).toBeGreaterThan(0.1); // Mercator is >10% wrong here
  });
});

describe('Equirectangular', () => {
  it('round-trips', () => {
    const p = new Equirectangular(20, 50);
    const back = p.unproject(p.project(25, 45));
    expect(back.lon).toBeCloseTo(25, 8);
    expect(back.lat).toBeCloseTo(45, 8);
  });
});

describe('createProjection', () => {
  it('builds each declared type', () => {
    expect(createProjection({ type: 'lcc', lon0: 28, lat0: 52, lat1: 44, lat2: 62 }).id).toBe('lcc');
    expect(createProjection({ type: 'equirect', lon0: 0, lat0: 0 }).id).toBe('equirect');
  });

  it('handles equal standard parallels without dividing by zero', () => {
    const p = new LambertConformalConic({ lon0: 28, lat0: 50, lat1: 50, lat2: 50 });
    const back = p.unproject(p.project(30, 52));
    expect(back.lon).toBeCloseTo(30, 6);
    expect(back.lat).toBeCloseTo(52, 6);
  });
});
