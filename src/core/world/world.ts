import type { Projection } from '@core/geo/projection';
import { Rng } from '@core/math/random';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { GameClock } from '@core/time/gameClock';
import type { Division } from './division';
import type { Faction } from './faction';
import type { DivisionId, FactionId } from './ids';

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The complete simulation state.
 *
 * Everything a system may read or write lives here and nowhere else. The
 * renderer holds a reference and only ever reads; React holds no reference at
 * all and goes through the view store. Keeping one authoritative container is
 * what makes save/load a matter of serialising a single object.
 */
export class World {
  readonly divisions = new Map<DivisionId, Division>();
  readonly factions = new Map<FactionId, Faction>();
  readonly clock: GameClock;

  /**
   * The simulation's ONLY source of randomness.
   *
   * It lives on the world rather than in a module because its state is
   * simulation state: it has to be saved, restored and hashed alongside unit
   * positions. A system that reaches for `Math.random()` instead silently
   * destroys reproducibility, so ESLint forbids it inside `core/`.
   */
  readonly rng: Rng;

  constructor(
    readonly projection: Projection,
    readonly terrain: TerrainGrid,
    readonly bounds: WorldBounds,
    startDate: Date,
    seed: number | string = 0,
  ) {
    this.clock = new GameClock(startDate);
    this.rng = new Rng(seed);
  }

  addFaction(f: Faction): void {
    this.factions.set(f.id, f);
  }

  addDivision(d: Division): void {
    this.divisions.set(d.id, d);
  }

  getDivision(id: DivisionId): Division | undefined {
    return this.divisions.get(id);
  }

  getFaction(id: FactionId): Faction | undefined {
    return this.factions.get(id);
  }

  /** Are these two factions on opposing sides? */
  hostile(a: FactionId, b: FactionId): boolean {
    const fa = this.factions.get(a);
    const fb = this.factions.get(b);
    return !!fa && !!fb && fa.alliance !== fb.alliance;
  }

  /**
   * Divisions whose centre lies within `radiusKm` of a world point.
   *
   * Linear scan. At Barbarossa scale (~400 divisions) this is a few
   * microseconds and is only called on player clicks — replacing it with a
   * spatial hash before combat needs proximity queries every tick is a
   * Milestone 2 task, deliberately not done now.
   */
  divisionsNear(x: number, y: number, radiusKm: number): Division[] {
    const r2 = radiusKm * radiusKm;
    const out: Division[] = [];
    for (const d of this.divisions.values()) {
      const dx = d.position.x - x;
      const dy = d.position.y - y;
      if (dx * dx + dy * dy <= r2) out.push(d);
    }
    return out;
  }
}
