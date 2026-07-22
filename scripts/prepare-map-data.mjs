#!/usr/bin/env node
/**
 * Downloads Natural Earth vector data, clips it to the theatre bounding box,
 * simplifies it, and writes compact GeoJSON into public/data/geo/.
 *
 * Run once (output is committed):   npm run data:prepare
 *
 * Why do this offline instead of at runtime?
 *  - The raw world files are ~10 MB; the clipped theatre is ~10% of that.
 *  - No network dependency and no API key when the game boots.
 *  - Coordinate precision is truncated to 4 decimals (~11 m), far beyond
 *    what an operational-scale game needs, which halves the file size again.
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'public', 'data', 'geo');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/** Theatre of operations: Operation Barbarossa. [minLon, minLat, maxLon, maxLat] */
const BBOX = [5, 36, 53, 68];

/** @type {{file:string, out:string, tolerance:number, keep?:(p:any)=>boolean, props?:string[]}[]} */
const LAYERS = [
  { file: 'ne_50m_land.geojson', out: 'land.geojson', tolerance: 0.02 },
  { file: 'ne_50m_lakes.geojson', out: 'lakes.geojson', tolerance: 0.02, props: ['name'] },
  {
    file: 'ne_50m_rivers_lake_centerlines.geojson',
    out: 'rivers.geojson',
    tolerance: 0.02,
    props: ['name', 'scalerank'],
  },
  {
    file: 'ne_50m_populated_places.geojson',
    out: 'cities.geojson',
    tolerance: 0,
    props: ['NAME', 'ADM0NAME', 'POP_MAX', 'SCALERANK'],
    keep: (p) => (p.SCALERANK ?? 99) <= 7,
  },
];

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

const inside = (p, edge) =>
  edge === 0 ? p[0] >= BBOX[0] : edge === 1 ? p[0] <= BBOX[2] : edge === 2 ? p[1] >= BBOX[1] : p[1] <= BBOX[3];

function intersect(a, b, edge) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  if (edge === 0 || edge === 1) {
    const x = edge === 0 ? BBOX[0] : BBOX[2];
    return [x, y1 + ((y2 - y1) * (x - x1)) / (x2 - x1)];
  }
  const y = edge === 2 ? BBOX[1] : BBOX[3];
  return [x1 + ((x2 - x1) * (y - y1)) / (y2 - y1), y];
}

/** Sutherland–Hodgman: correct for any polygon against a convex clip window. */
function clipRing(ring) {
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
}

/** Cohen–Sutherland style: splits a line into the pieces that fall inside. */
function clipLine(coords) {
  const pieces = [];
  let cur = [];
  const within = (p) => p[0] >= BBOX[0] && p[0] <= BBOX[2] && p[1] >= BBOX[1] && p[1] <= BBOX[3];
  for (const p of coords) {
    if (within(p)) cur.push(p);
    else if (cur.length) {
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces.filter((p) => p.length >= 2);
}

/** Ramer–Douglas–Peucker. Iterative to avoid blowing the stack on long rings. */
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

function processGeometry(geom, tolerance) {
  const poly = (rings) => {
    const out = [];
    for (const ring of rings) {
      const clipped = simplify(clipRing(ring), tolerance).map(round);
      if (clipped.length >= 4) out.push(clipped);
    }
    return out.length ? out : null;
  };

  switch (geom.type) {
    case 'Polygon': {
      const p = poly(geom.coordinates);
      return p && { type: 'Polygon', coordinates: p };
    }
    case 'MultiPolygon': {
      const parts = geom.coordinates.map(poly).filter(Boolean);
      return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
    }
    case 'LineString': {
      const parts = clipLine(geom.coordinates).map((l) => simplify(l, tolerance).map(round));
      if (!parts.length) return null;
      return parts.length === 1
        ? { type: 'LineString', coordinates: parts[0] }
        : { type: 'MultiLineString', coordinates: parts };
    }
    case 'MultiLineString': {
      const parts = geom.coordinates
        .flatMap(clipLine)
        .map((l) => simplify(l, tolerance).map(round));
      return parts.length ? { type: 'MultiLineString', coordinates: parts } : null;
    }
    case 'Point': {
      const [x, y] = geom.coordinates;
      const ok = x >= BBOX[0] && x <= BBOX[2] && y >= BBOX[1] && y <= BBOX[3];
      return ok ? { type: 'Point', coordinates: round(geom.coordinates) } : null;
    }
    default:
      return null;
  }
}

// -------------------------------------------------------------------- main --

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`Theatre bbox: ${BBOX.join(', ')}`);

  for (const layer of LAYERS) {
    const src = await fetchCached(layer.file);
    const features = [];
    for (const f of src.features) {
      if (layer.keep && !layer.keep(f.properties ?? {})) continue;
      const geometry = processGeometry(f.geometry, layer.tolerance);
      if (!geometry) continue;
      const properties = {};
      for (const key of layer.props ?? []) {
        const v = f.properties?.[key];
        if (v !== undefined && v !== null && v !== '') properties[key.toLowerCase()] = v;
      }
      features.push({ type: 'Feature', properties, geometry });
    }
    const json = JSON.stringify({ type: 'FeatureCollection', bbox: BBOX, features });
    await writeFile(join(OUT, layer.out), json);
    console.log(`  ${layer.out.padEnd(18)} ${String(features.length).padStart(5)} features  ${(json.length / 1024).toFixed(0)} KB`);
  }
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
