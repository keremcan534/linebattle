import type { Vec2 } from '@core/math/vec2';

/**
 * Converts between geographic coordinates and the simulation's world space.
 *
 * World space is measured in KILOMETRES with **y increasing southwards**, so it
 * lines up with screen conventions and the renderer never has to flip a sign.
 * Every distance in the simulation (movement, ranges, front widths) is in km,
 * which means designers can reason in real units and the numbers stay
 * historically meaningful.
 */
export interface Projection {
  readonly id: string;
  project(lon: number, lat: number): Vec2;
  unproject(p: Vec2): { lon: number; lat: number };
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

export interface LambertConformalConicOptions {
  /** Central meridian, degrees. */
  lon0: number;
  /** Latitude of origin, degrees. */
  lat0: number;
  /** Standard parallels, degrees. Distortion is zero along these. */
  lat1: number;
  lat2: number;
}

/**
 * Lambert Conformal Conic.
 *
 * Chosen over Web Mercator because the Eastern Front spans 45°N–62°N, where
 * Mercator inflates area by 2-4x and makes a division near Leningrad look
 * twice the size of one near Odessa. LCC keeps scale error under ~1% across
 * the whole theatre when the standard parallels bracket it, so a kilometre of
 * world space is a kilometre everywhere on the map.
 */
export class LambertConformalConic implements Projection {
  readonly id = 'lcc';

  private readonly n: number;
  private readonly F: number;
  private readonly rho0: number;
  private readonly lon0: number;

  constructor(private readonly opts: LambertConformalConicOptions) {
    const { lat0, lat1, lat2 } = opts;
    this.lon0 = opts.lon0 * DEG;

    const p1 = lat1 * DEG;
    const p2 = lat2 * DEG;
    const t = (lat: number) => Math.tan(Math.PI / 4 + lat / 2);

    this.n =
      Math.abs(p1 - p2) < 1e-9
        ? Math.sin(p1)
        : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));

    this.F = (Math.cos(p1) * Math.pow(t(p1), this.n)) / this.n;
    this.rho0 = (EARTH_RADIUS_KM * this.F) / Math.pow(t(lat0 * DEG), this.n);
  }

  project(lon: number, lat: number): Vec2 {
    const phi = lat * DEG;
    const theta = this.n * (lon * DEG - this.lon0);
    const rho = (EARTH_RADIUS_KM * this.F) / Math.pow(Math.tan(Math.PI / 4 + phi / 2), this.n);
    return {
      x: rho * Math.sin(theta),
      // Negated so that y grows southwards.
      y: rho * Math.cos(theta) - this.rho0,
    };
  }

  unproject(p: Vec2): { lon: number; lat: number } {
    const dy = this.rho0 + p.y;
    const sign = this.n >= 0 ? 1 : -1;
    const rho = sign * Math.hypot(p.x, dy);
    const theta = Math.atan2(sign * p.x, sign * dy);
    const lon = (this.lon0 + theta / this.n) / DEG;
    const lat =
      (2 * Math.atan(Math.pow((EARTH_RADIUS_KM * this.F) / rho, 1 / this.n)) - Math.PI / 2) / DEG;
    return { lon, lat };
  }

  get options(): Readonly<LambertConformalConicOptions> {
    return this.opts;
  }
}

/** Equirectangular fallback — used for scenarios near the equator or for tests. */
export class Equirectangular implements Projection {
  readonly id = 'equirect';
  private readonly cosLat0: number;

  constructor(private readonly lon0 = 0, private readonly lat0 = 0) {
    this.cosLat0 = Math.cos(lat0 * DEG);
  }

  project(lon: number, lat: number): Vec2 {
    return {
      x: EARTH_RADIUS_KM * (lon - this.lon0) * DEG * this.cosLat0,
      y: -EARTH_RADIUS_KM * (lat - this.lat0) * DEG,
    };
  }

  unproject(p: Vec2): { lon: number; lat: number } {
    return {
      lon: this.lon0 + p.x / (EARTH_RADIUS_KM * DEG * this.cosLat0),
      lat: this.lat0 - p.y / (EARTH_RADIUS_KM * DEG),
    };
  }
}

export type ProjectionSpec =
  | ({ type: 'lcc' } & LambertConformalConicOptions)
  | { type: 'equirect'; lon0: number; lat0: number };

export function createProjection(spec: ProjectionSpec): Projection {
  switch (spec.type) {
    case 'lcc':
      return new LambertConformalConic(spec);
    case 'equirect':
      return new Equirectangular(spec.lon0, spec.lat0);
  }
}
