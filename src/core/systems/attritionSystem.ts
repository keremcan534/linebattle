import { TERRAIN_PROFILES } from '@core/terrain/terrainTypes';
import { TICKS_PER_DAY } from '@core/time/gameClock';
import { organisationRatio } from '@core/world/division';
import { hasValidRetreatRoute } from './retreat';
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

      // Terrain and weather bite everyone; hunger only the badly supplied.
      let rate = terrain.attritionPerDay * weather.attrition;
      const starvation = Math.max(0, 1 - d.supply / 0.5);
      if (starvation > 0) {
        rate += STARVATION_PER_DAY * starvation * (d.encircled ? ENCIRCLEMENT_MULTIPLIER : 1);
      }
      const pocketDays = d.encircledTicks / TICKS_PER_DAY;
      const collapse = d.encircled
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
        d.encircled &&
        pocketDays >= POCKET_SURRENDER_DAYS &&
        d.supply <= 0.08 &&
        organisationRatio(d) <= 0.12 &&
        !hasValidRetreatRoute(d, world);
      if (surrendered) {
        world.divisions.delete(d.id);
        ctx.events.emit({ type: 'divisionDestroyed', division: d.id, position: { ...d.position } });
      }
    }
  }
}
