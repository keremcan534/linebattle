import type { Projection } from '@core/geo/projection';
import { Rng } from '@core/math/random';
import { Pathfinder } from '@core/pathfinding/pathfinder';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { GameClock } from '@core/time/gameClock';
import { computeWeather, type Climate, type Weather } from '@core/weather/weather';
import {
  SupplyField,
  type InitialControlGrid,
} from '@core/supply/supplyField';
import type { Battle } from './battle';
import type { Division } from './division';
import type { Faction } from './faction';
import type { FrontlineSegment, FrontlineSegmentId } from './frontline';
import type { BattleId, DivisionId, FactionId } from './ids';
import type { StrategicObjective, StrategicObjectiveId } from './strategicObjective';
import { SpatialIndex } from './spatialIndex';
import {
  campaignModifiers,
  type AllianceCampaignPlan,
  type CampaignModifiers,
  type MobilizationPolicy,
} from './campaign';

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
  /**
   * Root of the logistics network: capital, home port or off-map rail entry.
   * Forward hubs only work while connected to one of these.
   */
  networkRoot?: boolean;
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * Projected outline of the geographic theatre.
   *
   * LCC turns a lon/lat rectangle into a curved trapezium. The enclosing
   * numeric bounds remain useful to the camera and grids, while render layers
   * use this outline to avoid exposing the unused corners of that rectangle.
   */
  boundary?: readonly { x: number; y: number }[];
}

export type MobilizationCadre = Pick<
  Division,
  | 'faction'
  | 'branch'
  | 'maxManpower'
  | 'maxOrganisation'
  | 'morale'
  | 'experience'
  | 'speedKmh'
  | 'softAttack'
  | 'hardAttack'
  | 'defence'
  | 'hardness'
>;

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
  /** The living front is simulation state; divisions are assigned into it. */
  readonly frontlineSegments = new Map<FrontlineSegmentId, FrontlineSegment>();
  /** Player/AI strategic intent; operational HQ translates it into sector bias. */
  readonly strategicObjectives = new Map<StrategicObjectiveId, StrategicObjective>();
  nextObjectiveSerial = 1;
  /** Incremented whenever intent changes so frontage can rebalance immediately. */
  objectiveRevision = 0;
  /** Monotonic, so battle ids are stable across identical runs. */
  nextBattleSerial = 1;
  /** Monotonic id source for newly raised formations. */
  nextMobilizationSerial = 1;
  /** Starting force and production state, keyed by alliance. */
  readonly initialDivisionCounts = new Map<string, number>();
  readonly mobilizationProgress = new Map<string, number>();
  readonly mobilizationCadres = new Map<string, MobilizationCadre>();
  readonly mobilizationPolicies = new Map<string, MobilizationPolicy>();
  readonly campaignPlans = new Map<string, AllianceCampaignPlan>();
  /** Immutable opening control used to measure occupied homeland. */
  private initialControl: Uint8Array | null = null;
  private territoryLossCacheTick = -1;
  private readonly territoryLossCache = new Map<string, number>();

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

  enableSupply(
    sources: SupplySource[],
    climate: Climate,
    initialControl?: InitialControlGrid,
  ): void {
    this.supplySources.push(...sources);
    this.climate = climate;
    this.supply = new SupplyField(this.terrain, this.alliances);
    this.weather = computeWeather(this.clock.date, climate);

    if (initialControl) {
      this.supply.initControlGrid(initialControl);
    } else {
      // Small synthetic/test scenarios may omit a dated political map.
      const seeds: { x: number; y: number; alliance: string }[] = [];
      for (const d of this.divisions.values()) {
        const alliance = this.getFaction(d.faction)?.alliance;
        if (alliance) {
          seeds.push({
            x: d.position.x,
            y: d.position.y,
            alliance,
          });
        }
      }
      for (const s of sources) {
        seeds.push({
          x: s.position.x,
          y: s.position.y,
          alliance: s.alliance,
        });
      }
      this.supply.initControl(seeds);
    }
    this.initialControl = this.supply.control.slice();
    this.prepareMobilization();
  }

  configureCampaign(
    mobilization: readonly MobilizationPolicy[],
    plans: readonly AllianceCampaignPlan[],
  ): void {
    this.mobilizationPolicies.clear();
    this.campaignPlans.clear();
    for (const policy of mobilization) {
      this.mobilizationPolicies.set(policy.alliance, policy);
    }
    for (const plan of plans) this.campaignPlans.set(plan.alliance, plan);
  }

  campaignModifiers(alliance: string): CampaignModifiers {
    return campaignModifiers(
      this.campaignPlans.get(alliance),
      this.clock.date,
      this.territoryLossRatio(alliance),
    );
  }

  /**
   * Fraction of opening homeland cells no longer controlled by the alliance.
   * Conquests elsewhere never cancel this surrender/resolve progress.
   */
  territoryLossRatio(alliance: string): number {
    if (!this.supply || !this.initialControl) return 0;
    if (this.territoryLossCacheTick !== this.clock.tick) {
      this.territoryLossCacheTick = this.clock.tick;
      this.territoryLossCache.clear();
    }
    const cached = this.territoryLossCache.get(alliance);
    if (cached !== undefined) return cached;

    const owner = this.supply.allianceIndex(alliance) + 1;
    if (owner <= 0) return 0;

    let initial = 0;
    let lost = 0;
    for (let i = 0; i < this.initialControl.length; i++) {
      if (this.initialControl[i] !== owner) continue;
      initial++;
      if (this.supply.control[i] !== owner) lost++;
    }
    const ratio = initial > 0 ? lost / initial : 0;
    this.territoryLossCache.set(alliance, ratio);
    return ratio;
  }

  private prepareMobilization(): void {
    for (const alliance of this.alliances) {
      const candidates = [...this.divisions.values()]
        .filter((d) => this.getFaction(d.faction)?.alliance === alliance)
        .sort(
          (a, b) =>
            this.cadreScore(b) - this.cadreScore(a) ||
            (a.id < b.id ? -1 : 1),
        );
      this.initialDivisionCounts.set(alliance, candidates.length);
      this.mobilizationProgress.set(alliance, 0);
      const d = candidates[0];
      if (!d) continue;
      this.mobilizationCadres.set(alliance, {
        faction: d.faction,
        branch: d.branch,
        maxManpower: d.maxManpower,
        maxOrganisation: d.maxOrganisation,
        morale: d.morale,
        experience: d.experience,
        speedKmh: d.speedKmh,
        softAttack: d.softAttack,
        hardAttack: d.hardAttack,
        defence: d.defence,
        hardness: d.hardness,
      });
    }
  }

  private cadreScore(d: Division): number {
    const branch =
      d.branch === 'infantry'
        ? 100
        : d.branch === 'security'
          ? 60
          : d.branch === 'mountain'
            ? 40
            : 0;
    return branch + d.maxManpower / 100_000;
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
