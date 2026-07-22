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

    for (const d of ctx.world.divisions.values()) {
      const resting = d.order === null;
      // Marching costs cohesion; sitting still restores it. Both scale with
      // supply, because a formation without fuel or rations recovers slowly.
      const ratePerDay = resting ? 0.25 * d.supply : -0.05;
      d.organisation = Math.max(
        0,
        Math.min(d.maxOrganisation, d.organisation + d.maxOrganisation * ratePerDay * (hours / 24)),
      );

      const target = 0.4 + 0.6 * organisationRatio(d);
      d.morale += (target - d.morale) * 0.02 * hours;
      d.morale = Math.max(0, Math.min(1, d.morale));
    }
  }
}
