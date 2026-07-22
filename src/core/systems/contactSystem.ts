import { battleId } from '@core/world/ids';
import type { Battle, BattleSide } from '@core/world/battle';
import type { Division } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import type { System, TickContext } from './system';

/**
 * How close two hostile divisions must be to be in contact, in km.
 *
 * A 1941 division held roughly 10-25 km of front, so 14 km is about "our
 * forward troops can see and shoot at theirs". It also sets the granularity of
 * the front line: too small and units slip past each other, too large and
 * battles merge into one continental brawl.
 */
export const ENGAGEMENT_RANGE_KM = 14;

/** Hysteresis — a battle survives until the sides are this far apart. */
export const DISENGAGE_RANGE_KM = 20;

/**
 * Forms, maintains and dissolves battles.
 *
 * Runs after movement: units move, then we look at where they ended up. The
 * alternative — detecting contact before movement — lets a division march
 * clean through an enemy formation in the same tick it touches it.
 *
 * Battles form by transitive clustering: any two hostile divisions in range
 * join the same engagement, and so does anyone in range of them. That is what
 * makes a continuous front behave like a front rather than a hundred separate
 * duels, and it is only affordable because of the spatial index.
 */
export class ContactSystem implements System {
  readonly name = 'contact';

  update(ctx: TickContext): void {
    const { world, events } = ctx;

    world.index.rebuild(world.divisions.values());

    // Retreating formations are out of the line; they cannot anchor a battle.
    const engaged = new Set<DivisionId>();
    const clusters: Division[][] = [];

    for (const d of world.divisions.values()) {
      if (engaged.has(d.id) || d.stance === 'retreat') continue;

      const enemies = world
        .divisionsNear(d.position.x, d.position.y, ENGAGEMENT_RANGE_KM)
        .filter((o) => o.stance !== 'retreat' && world.hostile(d.faction, o.faction));
      if (!enemies.length) continue;

      clusters.push(this.growCluster(d, engaged, ctx));
    }

    // Rebuild the battle set from this tick's clusters. Battles are cheap
    // value objects; carrying identity across ticks would mean reconciling
    // splits and merges every time a division steps 500 metres.
    const previous = new Map(world.battles);
    world.battles.clear();

    for (const cluster of clusters) {
      const battle = this.formBattle(cluster, ctx, previous);
      if (battle) world.battles.set(battle.id, battle);
    }

    for (const [id, battle] of previous) {
      if (!world.battles.has(id)) events.emit({ type: 'battleEnded', battle: id, position: battle.position });
    }
    for (const [id, battle] of world.battles) {
      if (!previous.has(id)) events.emit({ type: 'battleStarted', battle: id, position: battle.position });
    }
  }

  /** Flood fill through mutual contact, so a whole sector becomes one battle. */
  private growCluster(seed: Division, engaged: Set<DivisionId>, ctx: TickContext): Division[] {
    const { world } = ctx;
    const cluster: Division[] = [];
    const queue: Division[] = [seed];
    engaged.add(seed.id);

    while (queue.length) {
      const current = queue.pop()!;
      cluster.push(current);

      for (const neighbour of world.divisionsNear(
        current.position.x,
        current.position.y,
        ENGAGEMENT_RANGE_KM,
      )) {
        if (engaged.has(neighbour.id) || neighbour.stance === 'retreat') continue;
        // Friends join only if they are themselves touching an enemy; this
        // stops a battle absorbing the entire rear echelon.
        const relevant = world.hostile(current.faction, neighbour.faction) || this.touchesEnemy(neighbour, ctx);
        if (!relevant) continue;
        engaged.add(neighbour.id);
        queue.push(neighbour);
      }
    }
    return cluster;
  }

  private touchesEnemy(d: Division, ctx: TickContext): boolean {
    return ctx.world
      .divisionsNear(d.position.x, d.position.y, ENGAGEMENT_RANGE_KM)
      .some((o) => o.stance !== 'retreat' && ctx.world.hostile(d.faction, o.faction));
  }

  private formBattle(
    cluster: Division[],
    ctx: TickContext,
    previous: Map<ReturnType<typeof battleId>, Battle>,
  ): Battle | null {
    const { world } = ctx;

    const byAlliance = new Map<string, Division[]>();
    for (const d of cluster) {
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;
      const list = byAlliance.get(alliance);
      if (list) list.push(d);
      else byAlliance.set(alliance, [d]);
    }
    if (byAlliance.size < 2) return null;

    // Two sides only. With three-way wars this would pick the two largest;
    // for now every scenario is bipolar and the assertion keeps it honest.
    const [first, second] = [...byAlliance.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!first || !second) return null;

    const makeSide = (alliance: string, divisions: Division[]): BattleSide => ({
      alliance,
      divisions: divisions.map((d) => d.id).sort(),
      attacking: divisions.some((d) => d.order !== null),
      power: 0,
    });

    const sides: [BattleSide, BattleSide] = [makeSide(first[0], first[1]), makeSide(second[0], second[1])];

    let x = 0;
    let y = 0;
    for (const d of cluster) {
      x += d.position.x;
      y += d.position.y;
    }
    const position = { x: x / cluster.length, y: y / cluster.length };

    // Reuse the id of an overlapping battle from last tick so the UI, the
    // event log and the bubble on screen see one continuous engagement rather
    // than a new battle every fifteen minutes.
    const inherited = this.inheritId(sides, previous);
    const id = inherited ?? battleId(`battle-${world.nextBattleSerial++}`);
    const carried = inherited ? previous.get(inherited) : undefined;

    // The defender's ground is what counts, so sample terrain under whichever
    // side is not attacking (or the centroid in a meeting engagement).
    const defending = sides.find((s) => !s.attacking);
    const sample = defending?.divisions[0]
      ? (world.getDivision(defending.divisions[0])?.position ?? position)
      : position;

    return {
      id,
      sides,
      position,
      startedTick: carried?.startedTick ?? ctx.tick,
      terrain: TERRAIN_PROFILES[world.terrain.sample(sample)].name,
      progress: carried?.progress ?? 0.5,
    };
  }

  private inheritId(
    sides: [BattleSide, BattleSide],
    previous: Map<ReturnType<typeof battleId>, Battle>,
  ): ReturnType<typeof battleId> | null {
    const members = new Set<DivisionId>();
    for (const side of sides) for (const id of side.divisions) members.add(id);

    let best: { id: ReturnType<typeof battleId>; overlap: number } | null = null;
    for (const [id, battle] of previous) {
      let overlap = 0;
      for (const side of battle.sides) for (const d of side.divisions) if (members.has(d)) overlap++;
      // Ties broken by id so inheritance cannot depend on Map ordering.
      if (overlap > 0 && (!best || overlap > best.overlap || (overlap === best.overlap && id < best.id))) {
        best = { id, overlap };
      }
    }
    return best?.id ?? null;
  }
}
