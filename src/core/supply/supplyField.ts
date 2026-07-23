import type { Vec2 } from '@core/math/vec2';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { Terrain, type TerrainProfile, TERRAIN_PROFILES } from '@core/terrain/terrainTypes';

export interface InitialControlGrid {
  /** One byte per control cell: 0 = neutral, otherwise 1 + alliance index. */
  cells: Uint8Array;
  /** Alliance lookup used by `cells`, independent of the field's sort order. */
  alliances: readonly string[];
}

export const CONTROL_CELL_SIZE_KM = 16;

/**
 * Historical rationale for the coarse logistics grid (the heat field itself
 * has since been replaced by binary capital connectivity).
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
/**
 * Presence, persistent political control and capital connectivity on 16 km
 * cells. `network` is binary: connected land is supplied, disconnected land
 * is not.
 */
export class SupplyField {
  readonly width: number;
  readonly height: number;
  readonly origin: Vec2;

  private readonly presence = new Map<string, Float32Array>();
  /** Cells with an unbroken land route back to an alliance logistics root. */
  private readonly network = new Map<string, Uint8Array>();

  /** Terrain cost multiplier per cell, precomputed: 0 means impassable. */
  readonly throughput: Float32Array;

  /**
   * Who holds each cell: 0 = nobody, otherwise 1 + alliance index.
   *
   * This is the liquid political map. Ownership persists until another side
   * actually dominates the cell, so the coloured boundary moves
   * continuously with the armies instead of jumping province by province.
   */
  readonly control: Uint8Array;
  readonly controlAlliances: readonly string[];

  constructor(
    private readonly terrain: TerrainGrid,
    alliances: readonly string[],
    readonly cellSize = CONTROL_CELL_SIZE_KM,
  ) {
    this.width = Math.ceil(terrain.worldWidth / cellSize);
    this.height = Math.ceil(terrain.worldHeight / cellSize);
    this.origin = terrain.origin;
    this.throughput = new Float32Array(this.width * this.height);
    this.control = new Uint8Array(this.width * this.height);
    this.controlAlliances = [...alliances].sort();
    this.bakeThroughput();
  }

  allianceIndex(alliance: string): number {
    return this.controlAlliances.indexOf(alliance);
  }

  /**
   * Seeds the initial line from the nearest deployed formation or supply hub.
   * Open water remains neutral because its throughput is zero.
   */
  initControl(
    seeds: readonly { x: number; y: number; alliance: string }[],
    maxRangeKm = 350,
  ): void {
    const indexed = seeds
      .map((s) => ({ x: s.x, y: s.y, idx: this.allianceIndex(s.alliance) }))
      .filter((s) => s.idx >= 0);
    const maxDistanceSq = maxRangeKm * maxRangeKm;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        if (this.throughput[i]! <= 0) continue;

        const cx = this.origin.x + (x + 0.5) * this.cellSize;
        const cy = this.origin.y + (y + 0.5) * this.cellSize;
        let bestAlliance = -1;
        let bestDistanceSq = maxDistanceSq;

        for (const seed of indexed) {
          const dx = seed.x - cx;
          const dy = seed.y - cy;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestAlliance = seed.idx;
          }
        }

        if (bestAlliance >= 0) this.control[i] = bestAlliance + 1;
      }
    }
  }

  /**
   * Loads scenario-authored political control instead of guessing the opening
   * frontier from the locations of deployed units and depots.
   */
  initControlGrid(initial: InitialControlGrid): void {
    if (initial.cells.length !== this.control.length) {
      throw new Error(
        `Initial control grid has ${initial.cells.length} cells; expected ${this.control.length}`,
      );
    }

    this.control.fill(0);
    for (let i = 0; i < initial.cells.length; i++) {
      if (this.throughput[i]! <= 0) continue;
      const sourceAlliance = initial.alliances[initial.cells[i]! - 1];
      const targetIndex = sourceAlliance
        ? this.allianceIndex(sourceAlliance)
        : -1;
      if (targetIndex >= 0) this.control[i] = targetIndex + 1;
    }
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

  presenceFor(alliance: string): Float32Array {
    let field = this.presence.get(alliance);
    if (!field) this.presence.set(alliance, (field = new Float32Array(this.width * this.height)));
    return field;
  }

  networkFor(alliance: string): Uint8Array {
    let field = this.network.get(alliance);
    if (!field) this.network.set(alliance, (field = new Uint8Array(this.width * this.height)));
    return field;
  }

  get alliances(): string[] {
    return [...this.controlAlliances];
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

  presenceAt(alliance: string, p: Vec2): number {
    const i = this.indexAt(p);
    return i < 0 ? 0 : this.presenceFor(alliance)[i]!;
  }

  networkAt(alliance: string, p: Vec2): boolean {
    const i = this.indexAt(p);
    return i >= 0 && this.networkFor(alliance)[i] === 1;
  }

  /**
   * Closest secure cell on the capital-linked logistics network.
   *
   * Used by operational AI to withdraw a formation from a closing pocket.
   * A full scan is cheap on the coarse field and only happens for threatened
   * formations during the three-hour AI review.
   */
  nearestNetworkPoint(alliance: string, p: Vec2): Vec2 | null {
    const network = this.networkFor(alliance);
    const owner = this.allianceIndex(alliance) + 1;
    let best = -1;
    let bestDistanceSq = Infinity;

    for (let i = 0; i < network.length; i++) {
      if (network[i] !== 1 || this.control[i] !== owner) continue;
      const centre = this.centreOf(i);
      const dx = centre.x - p.x;
      const dy = centre.y - p.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = i;
      }
    }

    return best >= 0 ? this.centreOf(best) : null;
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
