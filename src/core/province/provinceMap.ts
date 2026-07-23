import type { Vec2 } from '@core/math/vec2';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { NEUTRAL, NO_PROVINCE, type Province } from './province';

/**
 * Holds the province mesh and, separately, who owns each one.
 *
 * Geometry (`provinces`, `cellProvince`) is immutable and built once at load.
 * Ownership (`owner`) is simulation state: it changes as armies advance, is
 * saved and hashed with everything else, and is what the political map draws.
 *
 * The split matters. Regenerating provinces would be expensive and would
 * invalidate every saved game; keeping the shapes fixed and only moving the
 * colours is what makes the front cheap to update and trivial to serialise.
 */
export class ProvinceMap {
  /** Owner alliance index per province, or NEUTRAL. Simulation state. */
  readonly owner: Int16Array;

  constructor(
    readonly provinces: Province[],
    /** Province id per terrain cell, NO_PROVINCE for water/off-map. */
    readonly cellProvince: Int32Array,
    readonly terrain: TerrainGrid,
    readonly alliances: readonly string[],
  ) {
    this.owner = new Int16Array(provinces.length).fill(NEUTRAL);
  }

  get count(): number {
    return this.provinces.length;
  }

  allianceIndex(alliance: string): number {
    return this.alliances.indexOf(alliance);
  }

  /** Province id at a world position, or NO_PROVINCE. */
  provinceAt(p: Vec2): number {
    const i = this.terrain.indexAt(p);
    return i < 0 ? NO_PROVINCE : this.cellProvince[i]!;
  }

  ownerAt(p: Vec2): number {
    const id = this.provinceAt(p);
    return id === NO_PROVINCE ? NEUTRAL : this.owner[id]!;
  }

  ownerAllianceAt(p: Vec2): string | null {
    const a = this.ownerAt(p);
    return a === NEUTRAL ? null : this.alliances[a]!;
  }

  /**
   * Seeds initial ownership by nearest-presence: each province takes the
   * alliance of the closest starting division or depot within range.
   *
   * Approximate by construction — a province 200 km behind a border is
   * assigned to whoever is nearest, not to whoever a treaty says. That is the
   * right trade: roughly right everywhere, no hand-drawn data, and every error
   * self-corrects the moment an army actually walks there. Called once at load.
   */
  seedOwnership(seeds: readonly { x: number; y: number; alliance: string }[], maxRangeKm = 400): void {
    const indexed = seeds
      .map((s) => ({ x: s.x, y: s.y, ai: this.allianceIndex(s.alliance) }))
      .filter((s) => s.ai >= 0);
    const max2 = maxRangeKm * maxRangeKm;

    for (const province of this.provinces) {
      let best = NEUTRAL;
      let bestD = max2;
      for (const s of indexed) {
        const dx = s.x - province.cx;
        const dy = s.y - province.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) {
          bestD = d2;
          best = s.ai;
        }
      }
      this.owner[province.id] = best;
    }
  }
}
