import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { organisationRatio, type Division } from '@core/world/division';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Extra daily losses for a division with no supply at all. */
const STARVATION_PER_DAY = 0.055;
/** A pocket bleeds faster than open country at the same supply level. */
const ENCIRCLEMENT_MULTIPLIER = 1.7;
/** Organisation a starving formation loses per day. */
const STARVATION_ORG_PER_DAY = 0.2;
/** A sealed pocket gets one day to reopen a route before collapse accelerates. */
const POCKET_GRACE_DAYS = 1;
/** Additional daily losses once isolation has fully paralysed the formation. */
const POCKET_COLLAPSE_PER_DAY = 0.12;
/** Organisation lost per day during the final collapse of a pocket. */
const POCKET_ORG_COLLAPSE_PER_DAY = 0.3;
/** A continuously sealed, broken pocket surrenders after this many days. */
export const POCKET_SURRENDER_DAYS = 7;
/**
 * A cut-off formation is only doomed inside a genuine cauldron. If at least
 * this many encircled friendly divisions are clustered together, the pocket
 * collapses and its formations eventually surrender; a lone or small cut-off
 * is merely pinned and unsupplied, and can still fight its way out.
 */
const CAULDRON_MIN_DIVISIONS = 5;
/** Radius within which encircled friendly divisions count as one cauldron. */
const CAULDRON_CLUSTER_KM = 120;

/**
 * Losses that are nobody's fault.
 *
 * Terrain, weather and hunger, applied to every division whether or not it is
 * fighting. This is the system that makes distance cost something and turns a
 * pocket into a death sentence rather than an inconvenience: combat alone
 * cannot destroy a division (organisation breaks first), so encirclement is
 * the only reliable way to remove one from the map — which is exactly how the
 * 1941 campaign actually worked.
 *
 * Runs after combat, so a division that broke out this tick is not billed for
 * a pocket it is no longer in.
 */
export class AttritionSystem implements System {
  readonly name = 'attrition';

  update(ctx: TickContext): void {
    const { world } = ctx;
    const days = ctx.dtSeconds / 86_400;
    const weather = world.weather;

    for (const d of [...world.divisions.values()]) {
      const terrain = TERRAIN_PROFILES[world.terrain.sample(d.position)];

      // A lone or small cut-off is pinned and hungry, but not doomed: only a
      // genuine cauldron collapses and surrenders. This stops formations from
      // quietly dissolving in one-division "pixel pockets" every time an enemy
      // slips behind the line.
      const inCauldron = d.encircled && this.inCauldron(world, d);

      // Terrain and weather bite everyone; hunger only the badly supplied.
      let rate = terrain.attritionPerDay * weather.attrition;
      const starvation = Math.max(0, 1 - d.supply / 0.5);
      if (starvation > 0) {
        rate += STARVATION_PER_DAY * starvation * (inCauldron ? ENCIRCLEMENT_MULTIPLIER : 1);
      }
      const pocketDays = d.encircledTicks / TICKS_PER_DAY;
      const collapse = inCauldron
        ? Math.max(0, Math.min(1, (pocketDays - POCKET_GRACE_DAYS) / 3))
        : 0;
      rate += POCKET_COLLAPSE_PER_DAY * collapse;

      if (rate > 0) {
        const lost = d.manpower * rate * days;
        d.manpower = Math.max(0, d.manpower - lost);
      }

      // Starving formations come apart even when nobody is shooting at them.
      if (starvation > 0) {
        d.organisation = Math.max(
          0,
          d.organisation - d.maxOrganisation * STARVATION_ORG_PER_DAY * starvation * days,
        );
        d.morale = Math.max(0, d.morale - 0.08 * starvation * days);
      }
      if (collapse > 0) {
        d.organisation = Math.max(
          0,
          d.organisation - d.maxOrganisation * POCKET_ORG_COLLAPSE_PER_DAY * collapse * days,
        );
        d.morale = Math.max(0, d.morale - 0.12 * collapse * days);
      }

      const surrendered =
        inCauldron &&
        pocketDays >= POCKET_SURRENDER_DAYS &&
        d.supply <= 0.08 &&
        organisationRatio(d) <= 0.12;
      if (surrendered || d.manpower <= d.maxManpower * 0.08) {
        world.divisions.delete(d.id);
        ctx.events.emit({ type: 'divisionDestroyed', division: d.id, position: { ...d.position } });
      }
    }
  }

  /**
   * True when a cut-off formation is part of a real cauldron: at least
   * {@link CAULDRON_MIN_DIVISIONS} encircled friendly divisions packed within
   * {@link CAULDRON_CLUSTER_KM}. Counts the formation itself.
   */
  private inCauldron(world: World, d: Division): boolean {
    const alliance = world.getFaction(d.faction)?.alliance;
    if (!alliance) return false;
    let count = 0;
    for (const other of world.divisionsNear(
      d.position.x,
      d.position.y,
      CAULDRON_CLUSTER_KM,
    )) {
      if (other.encircled && world.getFaction(other.faction)?.alliance === alliance) {
        count++;
        if (count >= CAULDRON_MIN_DIVISIONS) return true;
      }
    }
    return false;
  }
}
