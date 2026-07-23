import { organisationRatio } from '@core/world/division';
import type { System, TickContext } from './system';

/**
 * Organisation recovery.
 *
 * Deliberately minimal for Milestone 1 — there is no combat yet, so nothing
 * spends organisation except marching. It exists now so that the *shape* of
 * per-tick attrition/recovery is established and Milestone 2 has somewhere
 * obvious to plug supply consumption in.
 */
export class RecoverySystem implements System {
  readonly name = 'recovery';

  update(ctx: TickContext): void {
    const hours = ctx.dtSeconds / 3600;
    const engaged = new Set(
      [...ctx.world.battles.values()].flatMap((battle) =>
        battle.sides.flatMap((side) => side.divisions),
      ),
    );

    for (const d of ctx.world.divisions.values()) {
      // An ADVANCE formation waiting for retreat clearance has no route yet,
      // but it is not resting. Counting it as resting refunded the winner's
      // combat organisation in the same 12-hour strategic tick.
      const resting = d.order === null && d.stance === 'hold';
      const ratio = organisationRatio(d);
      const alliance = ctx.world.getFaction(d.faction)?.alliance;
      const campaignRecovery = alliance
        ? ctx.world.campaignModifiers(alliance).recovery
        : 1;
      if (!engaged.has(d.id)) {
        // Normal marching creates fatigue, but cannot dissolve an army by
        // itself. Operational AI makes frequent short alignment moves, so an
        // unconditional marching drain eventually emptied every organisation
        // bar even on a quiet front. Below 55% a moving formation regroups;
        // above 70% it sheds only a small amount of parade-ground cohesion.
        let ratePerDay = 0;
        if (resting) {
          ratePerDay =
            0.25 *
            d.supply *
            ctx.world.weather.recovery *
            campaignRecovery;
        } else if (ratio > 0.7) {
          ratePerDay = -0.015;
        } else if (ratio < 0.55) {
          ratePerDay =
            0.05 *
            d.supply *
            ctx.world.weather.recovery *
            campaignRecovery;
        }
        d.organisation = Math.max(
          0,
          Math.min(
            d.maxOrganisation,
            d.organisation + d.maxOrganisation * ratePerDay * (hours / 24),
          ),
        );
      }

      if (
        d.state === 'RECOVERING' &&
        organisationRatio(d) >= 0.55
      ) {
        d.state = 'FRONTLINE';
      }

      const target = 0.4 + 0.6 * organisationRatio(d);
      d.morale += (target - d.morale) * 0.02 * hours;
      d.morale = Math.max(0, Math.min(1, d.morale));
    }
  }
}
