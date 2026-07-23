import type { DivisionId } from '@core/world/ids';
import type { System, TickContext } from './system';

/** Maximum field replacements received per fully supplied game-day. */
const REPLACEMENTS_PER_DAY = 0.02;
const MIN_REINFORCEMENT_SUPPLY = 0.35;

/**
 * Symmetric, supply-gated field replacements.
 *
 * This is deliberately not production yet. It represents wounded returning,
 * march battalions and ordinary replacement drafts reaching an existing
 * division. Destroyed formations never respawn, pockets receive nothing, and
 * a moving formation absorbs replacements at half the rate of one holding.
 */
export class ReinforcementSystem implements System {
  readonly name = 'reinforcement';

  update(ctx: TickContext): void {
    const days = ctx.dtSeconds / 86_400;
    const engaged = new Set<DivisionId>();
    for (const battle of ctx.world.battles.values()) {
      for (const side of battle.sides) {
        for (const id of side.divisions) engaged.add(id);
      }
    }

    for (const d of ctx.world.divisions.values()) {
      if (
        d.manpower >= d.maxManpower ||
        d.encircled ||
        d.stance === 'retreat' ||
        engaged.has(d.id) ||
        d.supply < MIN_REINFORCEMENT_SUPPLY
      ) {
        continue;
      }

      const activity = d.order === null ? 1 : 0.5;
      const supplyFlow =
        (d.supply - MIN_REINFORCEMENT_SUPPLY) / (1 - MIN_REINFORCEMENT_SUPPLY);
      const replacements =
        d.maxManpower * REPLACEMENTS_PER_DAY * days * activity * supplyFlow;
      d.manpower = Math.min(d.maxManpower, d.manpower + replacements);
    }
  }
}
