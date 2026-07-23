import type { Vec2 } from '@core/math/vec2';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { Terrain, type TerrainProfile, TERRAIN_PROFILES } from '@core/terrain/terrainTypes';

/**
 * Per-alliance supply and control, on a coarse grid.
 *
 * DELIBERATELY COARSER THAN TERRAIN. Supply is an operational-scale
 * phenomenon — you are never asking "can this truck reach that hedgerow", you
 * are asking "is this corps in supply". A 16 km cell puts the Eastern Front at
 * ~51k cells instead of 821k, which is what makes it affordable to re-flood
 * the whole theatre every game-hour. Halving it would be sixteen times the
 * work for an answer nobody can act on.
 *
 * Two fields per alliance:
 *
 *  - **presence** — where a side's divisions can exert control. Cheap
 *    approximation of a zone of control.
 *  - **supply** — 0..1, flooded outward from sources, blocked by cells the
 *    enemy dominates.
 *
 * Encirclement falls out of this for free rather than being special-cased: a
 * pocket whose every land route is enemy-dominated simply stops being reached
 * by the flood, and its divisions starve. That is what a Kessel *is*.
 */
export class SupplyField {
  readonly width: number;
  readonly height: number;
  readonly origin: Vec2;

  private readonly supply = new Map<string, Float32Array>();
  private readonly presence = new Map<string, Float32Array>();

  /** Terrain cost multiplier per cell, precomputed: 0 means impassable. */
  readonly throughput: Float32Array;

  constructor(
    private readonly terrain: TerrainGrid,
    readonly cellSize = 16,
  ) {
    this.width = Math.ceil(terrain.worldWidth / cellSize);
    this.height = Math.ceil(terrain.worldHeight / cellSize);
    this.origin = terrain.origin;
    this.throughput = new Float32Array(this.width * this.height);
    this.bakeThroughput();
  }

  /**
   * How well supply moves through each coarse cell.
   *
   * Sampled from the terrain grid once at construction, because terrain does
   * not change. Water is a wall; mountains and marsh are the difference
   * between a road net and a track.
   */
  private bakeThroughput(): void {
    // Overlap is computed in WORLD coordinates, not by an integer cell ratio.
    // The first version did `fx = x * round(cellSize / terrainCellSize) + sx`,
    // which is only correct when the supply cell is an exact multiple of the
    // terrain cell. At 16 km over 10 km terrain the sampling grid drifted 25%
    // per cell and ran off the map entirely in the east — a third of the
    // theatre silently baked as "impassable to supply". The shipped scenarios
    // (4 km and 2 km terrain under 16 km supply) happened to divide evenly,
    // which is exactly how this kind of bug survives: the alignment was an
    // accident, not a contract.
    const tcs = this.terrain.cellSize;

    for (let y = 0; y < this.height; y++) {
      const fy0 = Math.max(0, Math.floor((y * this.cellSize) / tcs));
      const fy1 = Math.min(this.terrain.height, Math.ceil(((y + 1) * this.cellSize) / tcs));

      for (let x = 0; x < this.width; x++) {
        const fx0 = Math.max(0, Math.floor((x * this.cellSize) / tcs));
        const fx1 = Math.min(this.terrain.width, Math.ceil(((x + 1) * this.cellSize) / tcs));

        let land = 0;
        let total = 0;
        let sum = 0;
        for (let fy = fy0; fy < fy1; fy++) {
          for (let fx = fx0; fx < fx1; fx++) {
            const t = this.terrain.cells[fy * this.terrain.width + fx] as Terrain;
            const profile: TerrainProfile = TERRAIN_PROFILES[t];
            total++;
            if (profile.moveMultiplier > 0) {
              land++;
              sum += supplyThroughput(t);
            }
          }
        }

        // A cell that is mostly water carries nothing: convoys need a shore.
        this.throughput[y * this.width + x] = total === 0 || land / total < 0.34 ? 0 : sum / land;
      }
    }
  }

  fieldFor(alliance: string): Float32Array {
    let field = this.supply.get(alliance);
    if (!field) this.supply.set(alliance, (field = new Float32Array(this.width * this.height)));
    return field;
  }

  presenceFor(alliance: string): Float32Array {
    let field = this.presence.get(alliance);
    if (!field) this.presence.set(alliance, (field = new Float32Array(this.width * this.height)));
    return field;
  }

  get alliances(): string[] {
    return [...this.supply.keys()].sort();
  }

  indexAt(p: Vec2): number {
    const x = Math.floor((p.x - this.origin.x) / this.cellSize);
    const y = Math.floor((p.y - this.origin.y) / this.cellSize);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  centreOf(index: number): Vec2 {
    const x = index % this.width;
    const y = (index / this.width) | 0;
    return {
      x: this.origin.x + (x + 0.5) * this.cellSize,
      y: this.origin.y + (y + 0.5) * this.cellSize,
    };
  }

  supplyAt(alliance: string, p: Vec2): number {
    const i = this.indexAt(p);
    return i < 0 ? 0 : this.fieldFor(alliance)[i]!;
  }

  presenceAt(alliance: string, p: Vec2): number {
    const i = this.indexAt(p);
    return i < 0 ? 0 : this.presenceFor(alliance)[i]!;
  }
}

/** Relative ease of pushing tonnage through a terrain class. */
function supplyThroughput(t: Terrain): number {
  switch (t) {
    case Terrain.Urban:
      return 1.25; // rail hubs and roads
    case Terrain.Plains:
    case Terrain.Desert:
      return 1;
    case Terrain.Forest:
      return 0.75;
    case Terrain.Hills:
      return 0.7;
    case Terrain.Bocage:
      return 0.6;
    case Terrain.Marsh:
      return 0.45;
    case Terrain.Mountains:
      return 0.4;
    default:
      return 0;
  }
}
