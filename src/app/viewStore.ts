import type { Branch, Stance } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { effectiveSpeedKmh, organisationRatio, strengthRatio } from '@core/world/division';
import { formatGameDate, MINUTES_PER_TICK, TICKS_PER_DAY } from '@core/time/gameClock';
import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import type { StrategicObjectiveKind } from '@core/world/strategicObjective';
import {
  activeFallback,
  activeHalt,
  activeOffensive,
} from '@core/world/campaign';

/**
 * The bridge between the 60fps simulation and React.
 *
 * React must never re-render on a game frame — reconciling a component tree
 * sixty times a second while Pixi is also drawing is how these projects end up
 * at 20fps. So:
 *   - Pixi reads world state directly, every frame, with no React involvement.
 *   - React subscribes here and receives an immutable snapshot at ~10 Hz.
 *   - Selection lives in this store, NOT in the World: what the player has
 *     clicked on is view state, not simulation state, and putting it in the
 *     world would mean saved games remember your last click.
 */

export interface DivisionSummary {
  id: DivisionId;
  name: string;
  formation: string;
  factionName: string;
  factionColor: number;
  branch: Branch;
  stance: Stance;
  manpower: number;
  maxManpower: number;
  strength: number;
  organisation: number;
  morale: number;
  supply: number;
  experience: number;
  speedKmh: number;
  terrain: string;
  encircled: boolean;
  encircledDays: number;
  hasOrder: boolean;
  frontlineSegment: string | null;
  lon: number;
  lat: number;
}

export interface BattleSummary {
  id: string;
  /** Where it is, so the HUD can fly the camera there. */
  x: number;
  y: number;
  lon: number;
  lat: number;
  terrain: string;
  /** 0..1 — how the fight is going for the PLAYER's side. */
  progress: number;
  playerPower: number;
  enemyPower: number;
  playerDivisions: number;
  enemyDivisions: number;
  /** Elapsed hours, for "how long has this been grinding?". */
  hours: number;
  attacking: boolean;
}

export interface StrategicObjectiveSummary {
  id: string;
  kind: StrategicObjectiveKind;
  x: number;
  y: number;
}

export interface ViewSnapshot {
  selection: readonly DivisionId[];
  selectedDetails: readonly DivisionSummary[];
  hovered: DivisionId | null;
  dateLabel: string;
  tick: number;
  speed: number;
  paused: boolean;
  zoom: number;
  cursor: { lon: number; lat: number; terrain: string } | null;
  divisionCount: number;
  frontlineSegmentCount: number;
  objectives: readonly StrategicObjectiveSummary[];
  objectivePlacement: StrategicObjectiveKind | null;
  battles: readonly BattleSummary[];
  weather: string;
  campaignPhase: string;
  /** Divisions of the player's own alliance currently cut off. */
  encircled: number;
}

const EMPTY_SNAPSHOT: ViewSnapshot = {
  selection: [],
  selectedDetails: [],
  hovered: null,
  dateLabel: '',
  tick: 0,
  speed: 0,
  paused: true,
  zoom: 0.1,
  cursor: null,
  divisionCount: 0,
  frontlineSegmentCount: 0,
  objectives: [],
  objectivePlacement: null,
  battles: [],
  weather: '',
  campaignPhase: '',
  encircled: 0,
};

export class ViewStore {
  /** Mutable, read by the renderer every frame. */
  selection = new Set<DivisionId>();
  hovered: DivisionId | null = null;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  cursorWorld: { x: number; y: number } | null = null;
  objectivePlacement: StrategicObjectiveKind | null = null;

  private world: World | null = null;
  /** Set at boot; battles are reported from this side's point of view. */
  playerAlliance = '';
  private snapshot: ViewSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private dirty = true;

  attach(world: World): void {
    this.world = world;
    // A new campaign must not inherit selection or cursor state from the
    // scenario that was just left through the menu.
    this.selection.clear();
    this.hovered = null;
    this.dragBox = null;
    this.cursorWorld = null;
    this.objectivePlacement = null;
    this.dirty = true;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ViewSnapshot => this.snapshot;

  /** Marks the snapshot stale; the next publish will rebuild and notify. */
  invalidate(): void {
    this.dirty = true;
  }

  setSelection(ids: Iterable<DivisionId>): void {
    this.selection = new Set(ids);
    this.dirty = true;
  }

  toggleSelection(id: DivisionId): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.dirty = true;
  }

  clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.dirty = true;
  }

  setObjectivePlacement(kind: StrategicObjectiveKind | null): void {
    this.objectivePlacement = kind;
    this.dirty = true;
  }

  setHovered(id: DivisionId | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.dirty = true;
  }

  /**
   * Rebuilds the snapshot and notifies React. Called by the renderer on a
   * throttle, and immediately after any interaction that must feel instant.
   */
  publish(zoom: number, force = false): void {
    if (!this.world || (!this.dirty && !force)) return;
    this.dirty = false;

    const world = this.world;
    const details: DivisionSummary[] = [];
    for (const id of this.selection) {
      const d = world.getDivision(id);
      if (!d) continue;
      const faction = world.getFaction(d.faction);
      const { lon, lat } = world.projection.unproject(d.position);
      details.push({
        id: d.id,
        name: d.name,
        formation: d.formation,
        factionName: faction?.name ?? '—',
        factionColor: faction?.color ?? 0x888888,
        branch: d.branch,
        stance: d.stance,
        manpower: Math.round(d.manpower),
        maxManpower: d.maxManpower,
        strength: strengthRatio(d),
        organisation: organisationRatio(d),
        morale: d.morale,
        supply: d.supply,
        experience: d.experience,
        speedKmh: effectiveSpeedKmh(d, world.weather.movement),
        terrain: TERRAIN_PROFILES[world.terrain.sample(d.position)].name,
        encircled: d.encircled,
        encircledDays: d.encircledTicks / TICKS_PER_DAY,
        hasOrder: d.order !== null,
        frontlineSegment: d.frontlineSegment,
        lon,
        lat,
      });
    }

    let cursor: ViewSnapshot['cursor'] = null;
    if (this.cursorWorld) {
      const { lon, lat } = world.projection.unproject(this.cursorWorld);
      cursor = { lon, lat, terrain: TERRAIN_PROFILES[world.terrain.sample(this.cursorWorld)].name };
    }

    // Always reported from the player's point of view: `progress` above 0.5
    // means the player is winning, whichever side of the battle they are on.
    // A HUD that made the player work out which arc was theirs would be
    // useless at a glance, which is the only speed that matters here.
    const battles: BattleSummary[] = [];
    for (const battle of world.battles.values()) {
      const mine = battle.sides.findIndex((s) => s.alliance === this.playerAlliance);
      if (mine < 0) continue;
      const theirs = mine === 0 ? 1 : 0;
      const { lon, lat } = world.projection.unproject(battle.position);

      battles.push({
        id: battle.id,
        x: battle.position.x,
        y: battle.position.y,
        lon,
        lat,
        terrain: battle.terrain,
        progress: mine === 0 ? battle.progress : 1 - battle.progress,
        playerPower: battle.sides[mine]!.power,
        enemyPower: battle.sides[theirs]!.power,
        playerDivisions: battle.sides[mine]!.divisions.length,
        enemyDivisions: battle.sides[theirs]!.divisions.length,
        hours: ((world.clock.tick - battle.startedTick) * MINUTES_PER_TICK) / 60,
        attacking: battle.sides[mine]!.attacking,
      });
    }
    // Worst first: the player should see where they are losing.
    battles.sort((a, b) => a.progress - b.progress);

    const objectives = [...world.strategicObjectives.values()]
      .filter((objective) => objective.alliance === this.playerAlliance)
      .sort((a, b) => a.createdTick - b.createdTick || (a.id < b.id ? -1 : 1))
      .map((objective) => ({
        id: objective.id,
        kind: objective.kind,
        x: objective.position.x,
        y: objective.position.y,
      }));

    const plans = [...world.campaignPlans.values()];
    const campaignPhase = plans.some((plan) =>
      activeFallback(plan, world.clock.date),
    )
      ? 'Strategic withdrawal'
      : plans.some((plan) => activeHalt(plan, world.clock.date))
        ? 'Winter quarters'
        : plans.some((plan) => activeOffensive(plan, world.clock.date))
          ? 'Grand offensive'
          : '';

    this.snapshot = {
      selection: [...this.selection],
      selectedDetails: details,
      hovered: this.hovered,
      dateLabel: formatGameDate(world.clock.date),
      tick: world.clock.tick,
      speed: world.clock.speed,
      paused: world.clock.paused,
      zoom,
      cursor,
      divisionCount: world.divisions.size,
      frontlineSegmentCount: world.frontlineSegments.size,
      objectives,
      objectivePlacement: this.objectivePlacement,
      battles,
      weather: world.weather.season,
      campaignPhase,
      encircled: [...world.divisions.values()].filter(
        (d) => d.encircled && world.getFaction(d.faction)?.alliance === this.playerAlliance,
      ).length,
    };

    for (const listener of this.listeners) listener();
  }
}
