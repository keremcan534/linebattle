import type { Projection } from '@core/geo/projection';
import { Rng } from '@core/math/random';
import { Pathfinder } from '@core/pathfinding/pathfinder';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { GameClock } from '@core/time/gameClock';
import { computeWeather, type Climate, type Weather } from '@core/weather/weather';
import { SupplyField } from '@core/supply/supplyField';
import type { Battle } from './battle';
import type { Division } from './division';
import type { Faction } from './faction';
import type { BattleId, DivisionId, FactionId } from './ids';
import { SpatialIndex } from './spatialIndex';

/** A depot, railhead or port that supply flows out of. */
export interface SupplySource {
  name: string;
  /**
   * Who currently draws supply from it. MUTABLE for capturable hubs — an
   * advancing army that takes a rail junction gets to use it, which is the
   * only way an offensive can outrun its start line and survive.
   */
  alliance: string;
  position: { x: number; y: number };
  /** How far its reach extends across good ground, in km. */
  rangeKm: number;
  /** Can the other side take it? Home ports and rail heads usually cannot. */
  capturable: boolean;
}

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

  readonly battles = new Map<BattleId, Battle>();
  /** Monotonic, so battle ids are stable across identical runs. */
  nextBattleSerial = 1;

  /** Rebuilt every tick by ContactSystem; see SpatialIndex for why. */
  readonly index: SpatialIndex;
  readonly pathfinder: Pathfinder;

  /** Null until a scenario declares supply sources. */
  supply: SupplyField | null = null;
  readonly supplySources: SupplySource[] = [];
  climate: Climate = 'temperate';

  /** Derived from the clock every tick — never stored, so it cannot drift. */
  weather: Weather;

  constructor(
    readonly projection: Projection,
    readonly terrain: TerrainGrid,
    readonly bounds: WorldBounds,
    startDate: Date,
    seed: number | string = 0,
  ) {
    this.clock = new GameClock(startDate);
    this.rng = new Rng(seed);
    this.pathfinder = new Pathfinder(terrain);
    // Bucket edge ~ twice the engagement range, so a contact query touches a
    // 3x3 neighbourhood at most.
    this.index = new SpatialIndex(25);
    this.weather = computeWeather(this.clock.date, this.climate);
  }

  /** Distinct alliances present, sorted so iteration is deterministic. */
  get alliances(): string[] {
    return [...new Set([...this.factions.values()].map((f) => f.alliance))].sort();
  }

  enableSupply(sources: SupplySource[], climate: Climate): void {
    this.supplySources.push(...sources);
    this.climate = climate;
    this.supply = new SupplyField(this.terrain);
    this.weather = computeWeather(this.clock.date, climate);
  }

  /** The battle this division is committed to, if any. */
  battleOf(id: DivisionId): Battle | undefined {
    for (const battle of this.battles.values()) {
      for (const side of battle.sides) if (side.divisions.includes(id)) return battle;
    }
    return undefined;
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

  /** Divisions whose centre lies within `radiusKm` of a world point. */
  divisionsNear(x: number, y: number, radiusKm: number): Division[] {
    return this.index.query(x, y, radiusKm);
  }
}
