import { deriveFrontPositions } from '@core/front/frontFormation';
import type { System, TickContext } from './system';

/**
 * Projects the simulation onto the map.
 *
 * Runs last in the tick, after the line has moved and formations have been
 * assigned, and writes nothing but presentation: counter positions and
 * headings derived from each division's sector and slot. Simulation state is
 * never read back from these positions.
 */
export class FrontFormationSystem implements System {
  readonly name = 'frontFormation';

  update(ctx: TickContext): void {
    const { world } = ctx;
    if (!world.front) return;
    deriveFrontPositions(world.front, world.divisions.values(), (division) =>
      world.getFaction(division.faction)?.alliance,
    );
  }
}
