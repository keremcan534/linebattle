import type { Branch, Stance } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { effectiveSpeedKmh, organisationRatio, strengthRatio } from '@core/world/division';
import { formatGameDate } from '@core/time/gameClock';
import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';

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
  hasOrder: boolean;
  lon: number;
  lat: number;
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
};

export class ViewStore {
  /** Mutable, read by the renderer every frame. */
  selection = new Set<DivisionId>();
  hovered: DivisionId | null = null;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  cursorWorld: { x: number; y: number } | null = null;

  private world: World | null = null;
  private snapshot: ViewSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private dirty = true;

  attach(world: World): void {
    this.world = world;
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
        speedKmh: effectiveSpeedKmh(d),
        terrain: TERRAIN_PROFILES[world.terrain.sample(d.position)].name,
        hasOrder: d.order !== null,
        lon,
        lat,
      });
    }

    let cursor: ViewSnapshot['cursor'] = null;
    if (this.cursorWorld) {
      const { lon, lat } = world.projection.unproject(this.cursorWorld);
      cursor = { lon, lat, terrain: TERRAIN_PROFILES[world.terrain.sample(this.cursorWorld)].name };
    }

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
    };

    for (const listener of this.listeners) listener();
  }
}
