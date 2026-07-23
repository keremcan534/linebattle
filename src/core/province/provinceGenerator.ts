import { Rng } from '@core/math/random';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { TERRAIN_PROFILES, Terrain, TERRAIN_COUNT } from '@core/terrain/terrainTypes';
import { NO_PROVINCE, type Province } from './province';
import { ProvinceMap } from './provinceMap';

export interface ProvinceGenOptions {
  /** Target province diameter in km. ~45 gives HOI4-scale chunks. */
  spacingKm?: number;
  /** Fixed seed so a theatre always produces the same mesh. */
  seed?: string;
  /**
   * Per terrain cell, the owner region a province may not cross — an alliance
   * index, or −1 for neutral/unowned ground. When given, the flood is confined
   * so no province spans two regions, which makes every province edge along a
   * national frontier fall exactly on the frontier, and lets a province's
   * initial owner be read straight off the region it sits in. When omitted,
   * generation ignores politics and ownership must be seeded separately.
   */
  confine?: Int8Array;
}

/**
 * Generates a province mesh over the passable terrain of a theatre.
 *
 * Approach: scatter seeds on a jittered grid, then grow every seed outward at
 * once with a multi-source breadth-first flood. Each land cell joins whichever
 * seed's front reaches it first. That is a Manhattan-metric Voronoi — chunky,
 * contiguous provinces with no slivers — computed in a single O(cells) pass
 * rather than the O(cells × seeds) a naive nearest-seed scan would cost.
 *
 * Two properties we depend on downstream:
 *  - **Every passable cell belongs to exactly one province.** A stray pocket
 *    of land too small to catch a seed is swept up by a second flood into its
 *    own province, so `provinceAt` never returns a hole over dry ground.
 *  - **Determinism.** Jitter comes from a local RNG seeded by the theatre, not
 *    from `world.rng`, so the mesh is reproducible AND generating it never
 *    perturbs the simulation's random stream.
 *
 * Water is left unassigned (`NO_PROVINCE`): the sea is nobody's province,
 * which keeps the political map from bleeding across coastlines.
 */
export function generateProvinces(
  terrain: TerrainGrid,
  alliances: readonly string[],
  opts: ProvinceGenOptions = {},
): ProvinceMap {
  const spacing = Math.max(2, Math.round((opts.spacingKm ?? 45) / terrain.cellSize));
  const rng = new Rng(opts.seed ?? 'provinces');
  const { width, height } = terrain;
  const n = width * height;
  const confine = opts.confine;

  // Interim province ids are dense seed indices; we compact them at the end.
  const raw = new Int32Array(n).fill(NO_PROVINCE);
  const passable = (i: number) => TERRAIN_PROFILES[terrain.cells[i] as Terrain].moveMultiplier > 0;

  const seeds: number[] = [];
  for (let gy = 0; gy < height; gy += spacing) {
    for (let gx = 0; gx < width; gx += spacing) {
      const jx = gx + Math.floor(rng.range(0, spacing));
      const jy = gy + Math.floor(rng.range(0, spacing));
      if (jx >= width || jy >= height) continue;
      const i = jy * width + jx;
      if (passable(i) && raw[i] === NO_PROVINCE) {
        raw[i] = seeds.length;
        seeds.push(i);
      }
    }
  }

  // A province may not cross an owner boundary when confining: the neighbour
  // must share the seed cell's region as well as being passable.
  const canEnter = confine
    ? (from: number, to: number) => passable(to) && confine[to] === confine[from]
    : (_from: number, to: number) => passable(to);

  floodFill(raw, seeds, width, height, canEnter);

  // Adopt any passable cell no seed reached into a fresh singleton province.
  for (let i = 0; i < n; i++) {
    if (raw[i] === NO_PROVINCE && passable(i)) {
      const id = seeds.length;
      seeds.push(i);
      raw[i] = id;
      floodFill(raw, [i], width, height, canEnter, id);
    }
  }

  return build(raw, seeds.length, terrain, alliances, confine);
}

// ------------------------------------------------------------------ internals

function floodFill(
  cell: Int32Array,
  starts: number[],
  width: number,
  height: number,
  canEnter: (from: number, to: number) => boolean,
  onlyId?: number,
): void {
  let queue = starts.slice();
  let next: number[] = [];

  while (queue.length) {
    for (const i of queue) {
      const pid = cell[i]!;
      if (onlyId !== undefined && pid !== onlyId) continue;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0) tryClaim(i, i - 1, pid, cell, canEnter, next);
      if (x < width - 1) tryClaim(i, i + 1, pid, cell, canEnter, next);
      if (y > 0) tryClaim(i, i - width, pid, cell, canEnter, next);
      if (y < height - 1) tryClaim(i, i + width, pid, cell, canEnter, next);
    }
    queue = next;
    next = [];
  }
}

function tryClaim(
  from: number,
  j: number,
  pid: number,
  cell: Int32Array,
  canEnter: (from: number, to: number) => boolean,
  next: number[],
): void {
  if (cell[j] !== NO_PROVINCE || !canEnter(from, j)) return;
  cell[j] = pid;
  next.push(j);
}

/**
 * Turns the raw seed-indexed assignment into compact provinces.
 *
 * Some seeds are overrun before they claim any cell (an earlier front reached
 * their neighbourhood first), leaving gaps in the id space. We build a
 * remap from raw id → compact id over only the non-empty ones, rewrite
 * `cellProvince` in place, and emit provinces whose neighbour ids are already
 * in the compact space — so `provinces[k].id === k` is an invariant every
 * consumer can rely on.
 */
function build(
  raw: Int32Array,
  rawCount: number,
  terrain: TerrainGrid,
  alliances: readonly string[],
  confine?: Int8Array,
): ProvinceMap {
  const { width, height, cellSize, origin } = terrain;

  const cells = new Int32Array(rawCount);
  // One representative cell per raw province, so we can read its owner region.
  const sample = new Int32Array(rawCount).fill(-1);
  for (let i = 0; i < raw.length; i++) {
    const pid = raw[i]!;
    if (pid !== NO_PROVINCE) {
      cells[pid]!++;
      if (sample[pid] === -1) sample[pid] = i;
    }
  }

  const remap = new Int32Array(rawCount).fill(-1);
  let compact = 0;
  for (let pid = 0; pid < rawCount; pid++) {
    if (cells[pid]! > 0) remap[pid] = compact++;
  }

  // Rewrite the per-cell map into compact ids.
  const cellProvince = new Int32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const pid = raw[i]!;
    cellProvince[i] = pid === NO_PROVINCE ? NO_PROVINCE : remap[pid]!;
  }

  const sumX = new Float64Array(compact);
  const sumY = new Float64Array(compact);
  const area = new Int32Array(compact);
  const terrainHist = new Int32Array(compact * TERRAIN_COUNT);
  const coastal = new Uint8Array(compact);
  const neighbours: Set<number>[] = Array.from({ length: compact }, () => new Set<number>());

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const id = cellProvince[i]!;
      if (id === NO_PROVINCE) continue;

      area[id]!++;
      sumX[id]! += origin.x + (x + 0.5) * cellSize;
      sumY[id]! += origin.y + (y + 0.5) * cellSize;
      terrainHist[id * TERRAIN_COUNT + (terrain.cells[i] as Terrain)]!++;

      const right = x < width - 1 ? cellProvince[i + 1]! : id;
      const down = y < height - 1 ? cellProvince[i + width]! : id;
      edge(id, right, coastal, neighbours);
      edge(id, down, coastal, neighbours);
    }
  }

  const provinces: Province[] = [];
  for (let id = 0; id < compact; id++) {
    let dominant = Terrain.Plains;
    let bestCount = -1;
    for (let t = 0; t < TERRAIN_COUNT; t++) {
      const v = terrainHist[id * TERRAIN_COUNT + t]!;
      if (v > bestCount) {
        bestCount = v;
        dominant = t as Terrain;
      }
    }
    provinces.push({
      id,
      cx: sumX[id]! / area[id]!,
      cy: sumY[id]! / area[id]!,
      terrain: dominant,
      cells: area[id]!,
      neighbours: [...neighbours[id]!].sort((a, b) => a - b),
      coastal: coastal[id] === 1,
    });
  }

  const map = new ProvinceMap(provinces, cellProvince, terrain, alliances);

  // With a confine grid, a province's owner is simply the region it sits in —
  // it cannot straddle two, by construction. Read it off the representative
  // cell. (An owner value < 0 stays NEUTRAL, which ProvinceMap defaults to.)
  if (confine) {
    for (let raw2 = 0; raw2 < rawCount; raw2++) {
      const id = remap[raw2]!;
      if (id < 0) continue;
      const owner = confine[sample[raw2]!]!;
      if (owner >= 0) map.owner[id] = owner;
    }
  }

  return map;
}

function edge(a: number, b: number, coastal: Uint8Array, neighbours: Set<number>[]): void {
  if (a === b) return;
  if (b === NO_PROVINCE) {
    coastal[a] = 1;
    return;
  }
  neighbours[a]!.add(b);
  neighbours[b]!.add(a);
}
