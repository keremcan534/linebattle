import type { Vec2 } from '@core/math/vec2';
import { Terrain, TERRAIN_PROFILES } from './terrainTypes';

/**
 * A uniform raster of terrain classes covering the theatre.
 *
 * Why a raster rather than testing polygons directly?
 *  - Sampling becomes O(1) array indexing instead of O(edges) point-in-polygon.
 *    Movement queries terrain every tick for every division; at 300 divisions
 *    and 24 hourly ticks/day that is ~7k lookups per simulated day.
 *  - It composes: coastline, forest, marsh and urban layers are painted in
 *    order into the same buffer, so adding a new layer never touches the
 *    sampling code.
 *  - It is trivially serialisable, which we will need for saves and for
 *    handing terrain to a worker thread.
 *
 * This class is pure data + arithmetic: it can be constructed in a test with a
 * hand-written array and needs no browser.
 */
export class TerrainGrid {
  constructor(
    /** World-space position of the grid's top-left corner, in km. */
    readonly origin: Vec2,
    /** Edge length of one cell, in km. */
    readonly cellSize: number,
    readonly width: number,
    readonly height: number,
    /** width*height terrain classes. */
    readonly cells: Uint8Array,
    /**
     * width*height river magnitudes (0 = none, 255 = major river).
     * Rivers are kept separate because a river is a line you *cross*, not an
     * area you stand in — it modifies attacks across a cell boundary rather
     * than the cell itself.
     */
    readonly rivers: Uint8Array,
  ) {}

  get worldWidth(): number {
    return this.width * this.cellSize;
  }

  get worldHeight(): number {
    return this.height * this.cellSize;
  }

  /** Cell index for a world position, or -1 when outside the theatre. */
  indexAt(p: Vec2): number {
    const cx = Math.floor((p.x - this.origin.x) / this.cellSize);
    const cy = Math.floor((p.y - this.origin.y) / this.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return -1;
    return cy * this.width + cx;
  }

  /** Terrain at a world position. Off-map reads as Water, which is impassable. */
  sample(p: Vec2): Terrain {
    const i = this.indexAt(p);
    return i < 0 ? Terrain.Water : (this.cells[i] as Terrain);
  }

  riverAt(p: Vec2): number {
    const i = this.indexAt(p);
    return i < 0 ? 0 : this.rivers[i]!;
  }

  moveMultiplierAt(p: Vec2): number {
    return TERRAIN_PROFILES[this.sample(p)].moveMultiplier;
  }

  isPassableAt(p: Vec2): boolean {
    return TERRAIN_PROFILES[this.sample(p)].moveMultiplier > 0;
  }

  /**
   * Nearest passable world position to `p`, searched in expanding rings.
   * Used to keep orders sane when the player clicks into the Baltic.
   * Returns null if nothing passable exists within `maxRadiusKm`.
   */
  nearestPassable(p: Vec2, maxRadiusKm = 120): Vec2 | null {
    if (this.isPassableAt(p)) return p;
    const maxRings = Math.ceil(maxRadiusKm / this.cellSize);
    const cx = Math.floor((p.x - this.origin.x) / this.cellSize);
    const cy = Math.floor((p.y - this.origin.y) / this.cellSize);

    for (let r = 1; r <= maxRings; r++) {
      let best: { pos: Vec2; d2: number } | null = null;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the perimeter of the ring; the interior was covered already.
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
          if (TERRAIN_PROFILES[this.cells[y * this.width + x] as Terrain].moveMultiplier <= 0) continue;

          const pos = {
            x: this.origin.x + (x + 0.5) * this.cellSize,
            y: this.origin.y + (y + 0.5) * this.cellSize,
          };
          const d2 = (pos.x - p.x) ** 2 + (pos.y - p.y) ** 2;
          if (!best || d2 < best.d2) best = { pos, d2 };
        }
      }
      if (best) return best.pos;
    }
    return null;
  }
}
