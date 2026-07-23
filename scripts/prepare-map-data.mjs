#!/usr/bin/env node
/**
 * Downloads Natural Earth vector data, clips it to each declared THEATRE,
 * simplifies it, and writes compact GeoJSON to public/data/geo/<theatre>/.
 *
 * Run once (output is committed):
 *   npm run data:prepare                 # every theatre
 *   npm run data:prepare -- normandy     # just one
 *
 * Why offline rather than at runtime?
 *  - The raw world files are 2-100 MB; a clipped theatre is a fraction of that.
 *  - No network dependency and no API key when the game boots.
 *  - Coordinate precision is truncated, which halves the size again.
 *
 * A THEATRE is the unit of map data. Each scenario names one, and each gets its
 * OWN projection (declared in the scenario) and its own source resolution: an
 * Eastern Front spanning 3000 km is well served by 1:50m data at 4 km cells,
 * while Normandy lives or dies on where exactly the coastline is and needs
 * 1:10m at 2 km. One global map could not serve both.
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT_ROOT = join(ROOT, 'public', 'data', 'geo');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/**
 * @typedef {object} Theatre
 * @property {string} id           output directory name
 * @property {string} label        human description
 * @property {[number,number,number,number]} bbox  [minLon, minLat, maxLon, maxLat]
 * @property {'10m'|'50m'} scale   Natural Earth source resolution
 * @property {number} tolerance    Douglas-Peucker tolerance, degrees
 * @property {number} cityRank     keep populated places with scalerank <= this
 */

/** @type {Theatre[]} */
const THEATRES = [
  {
    id: 'eastern-front',
    label: 'Operation Barbarossa and the Eastern Front',
    bbox: [-11, 35, 51, 63.5],
    scale: '50m',
    tolerance: 0.02,
    cityRank: 7,
  },
  {
    id: 'normandy',
    label: 'Overlord and the Normandy campaign',
    // Cornwall to the Belgian border, Brittany to the Wash. 10m data because
    // the entire scenario is an argument about one coastline.
    bbox: [-6.5, 46.8, 5.5, 53.2],
    scale: '10m',
    tolerance: 0.003,
    cityRank: 9,
  },
  {
    id: 'mediterranean',
    label: 'North Africa, Italy and the Mediterranean',
    bbox: [-7, 27, 37, 47],
    scale: '50m',
    tolerance: 0.02,
    cityRank: 7,
  },
];

const LAYERS = [
  { source: 'land', out: 'land.geojson', kind: 'poly' },
  { source: 'lakes', out: 'lakes.geojson', kind: 'poly', props: ['name'] },
  { source: 'rivers_lake_centerlines', out: 'rivers.geojson', kind: 'line', props: ['name', 'scalerank'] },
  {
    source: 'populated_places',
    out: 'cities.geojson',
    kind: 'point',
    props: ['NAME', 'ADM0NAME', 'POP_MAX', 'SCALERANK'],
  },
  // Modern national territory. We keep precise Natural Earth polygons and
  // remap each country to its 1941 owner in the scenario JSON — data-driven
  // national borders without hand-drawing a single 1940s frontier.
  {
    source: 'admin_0_countries',
    out: 'nations.geojson',
    kind: 'poly',
    props: ['NAME', 'ISO_A2', 'ISO_A3', 'ADM0_A3'],
  },
];

// ---------------------------------------------------------------- fetching --

async function fetchCached(name) {
  const path = join(CACHE, name);
  try {
    await access(path);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    /* not cached yet */
  }
  process.stdout.write(`  downloading ${name} ... `);
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, text);
  console.log(`${(text.length / 1e6).toFixed(1)} MB`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------- geometry --

const makeClipper = (bbox) => {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const clipWindow = [
    [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  ];

  const inside = (p, edge) =>
    edge === 0 ? p[0] >= minLon : edge === 1 ? p[0] <= maxLon : edge === 2 ? p[1] >= minLat : p[1] <= maxLat;

  function intersect(a, b, edge) {
    const [x1, y1] = a;
    const [x2, y2] = b;
    if (edge === 0 || edge === 1) {
      const x = edge === 0 ? minLon : maxLon;
      return [x, y1 + ((y2 - y1) * (x - x1)) / (x2 - x1)];
    }
    const y = edge === 2 ? minLat : maxLat;
    return [x1 + ((x2 - x1) * (y - y1)) / (y2 - y1), y];
  }

  /** Sutherland-Hodgman: correct for any polygon against a convex window. */
  const clipRing = (ring) => {
    let out = ring;
    for (let edge = 0; edge < 4 && out.length; edge++) {
      const input = out;
      out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        const prev = input[(i + input.length - 1) % input.length];
        const curIn = inside(cur, edge);
        const prevIn = inside(prev, edge);
        if (curIn) {
          if (!prevIn) out.push(intersect(prev, cur, edge));
          out.push(cur);
        } else if (prevIn) {
          out.push(intersect(prev, cur, edge));
        }
      }
    }
    return out;
  };

  const within = (p) => p[0] >= minLon && p[0] <= maxLon && p[1] >= minLat && p[1] <= maxLat;

  /*
   * A concave continent can enter and leave a theatre window several times.
   * Sutherland-Hodgman returns one ring, so using it here joined those separate
   * pieces across the clipping edge and produced the enormous diagonal "land"
   * bands visible south of Turkey. polygon-clipping preserves every resulting
   * island/piece as a proper MultiPolygon.
   */
  const clipPolygon = (coordinates) =>
    polygonClipping.intersection(coordinates, clipWindow);

  const clipLine = (coords) => {
    const pieces = [];
    let cur = [];
    for (const p of coords) {
      if (within(p)) cur.push(p);
      else if (cur.length) {
        pieces.push(cur);
        cur = [];
      }
    }
    if (cur.length) pieces.push(cur);
    return pieces.filter((p) => p.length >= 2);
  };

  return { clipRing, clipLine, clipPolygon, within };
};

/** Ramer-Douglas-Peucker. Iterative, so long rings cannot blow the stack. */
function simplify(points, tolerance) {
  if (tolerance <= 0 || points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tol2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];

function processGeometry(geom, clip, tolerance) {
  const polygons = (coordinates) => {
    const clipped = clip.clipPolygon(coordinates);
    const out = [];
    for (const polygon of clipped) {
      const rings = polygon
        .map((ring) => simplify(ring, tolerance).map(round))
        .filter((ring) => ring.length >= 4);
      if (rings.length) out.push(rings);
    }
    return out;
  };

  switch (geom.type) {
    case 'Polygon': {
      const parts = polygons([geom.coordinates]);
      if (!parts.length) return null;
      return parts.length === 1
        ? { type: 'Polygon', coordinates: parts[0] }
        : { type: 'MultiPolygon', coordinates: parts };
    }
    case 'MultiPolygon': {
      const parts = polygons(geom.coordinates);
      return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
    }
    case 'LineString': {
      const parts = clip.clipLine(geom.coordinates).map((l) => simplify(l, tolerance).map(round));
      if (!parts.length) return null;
      return parts.length === 1
        ? { type: 'LineString', coordinates: parts[0] }
        : { type: 'MultiLineString', coordinates: parts };
    }
    case 'MultiLineString': {
      const parts = geom.coordinates
        .flatMap(clip.clipLine)
        .map((l) => simplify(l, tolerance).map(round));
      return parts.length ? { type: 'MultiLineString', coordinates: parts } : null;
    }
    case 'Point':
      return clip.within(geom.coordinates) ? { type: 'Point', coordinates: round(geom.coordinates) } : null;
    default:
      return null;
  }
}

// -------------------------------------------------------------------- main --

async function buildTheatre(theatre) {
  console.log(`\n${theatre.id}  [${theatre.bbox.join(', ')}]  ${theatre.scale}  - ${theatre.label}`);
  const outDir = join(OUT_ROOT, theatre.id);
  await mkdir(outDir, { recursive: true });
  const clip = makeClipper(theatre.bbox);

  for (const layer of LAYERS) {
    const file = `ne_${theatre.scale}_${layer.source}.geojson`;
    const src = await fetchCached(file);

    const features = [];
    for (const f of src.features) {
      if (layer.source === 'populated_places') {
        const rank = f.properties?.SCALERANK ?? 99;
        if (rank > theatre.cityRank) continue;
      }
      const geometry = processGeometry(f.geometry, clip, layer.kind === 'point' ? 0 : theatre.tolerance);
      if (!geometry) continue;

      const properties = {};
      for (const key of layer.props ?? []) {
        const v = f.properties?.[key];
        if (v !== undefined && v !== null && v !== '') properties[key.toLowerCase()] = v;
      }
      features.push({ type: 'Feature', properties, geometry });
    }

    const json = JSON.stringify({ type: 'FeatureCollection', bbox: theatre.bbox, features });
    await writeFile(join(outDir, layer.out), json);
    console.log(
      `  ${layer.out.padEnd(18)} ${String(features.length).padStart(5)} features  ${(json.length / 1024).toFixed(0)} KB`,
    );
  }
}

async function main() {
  const requested = process.argv.slice(2);
  const selected = requested.length ? THEATRES.filter((t) => requested.includes(t.id)) : THEATRES;

  if (!selected.length) {
    console.error(`No theatre matched. Known: ${THEATRES.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  for (const theatre of selected) await buildTheatre(theatre);
  console.log('\ndone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
