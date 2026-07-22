import type { Command, CommandQueue } from '@core/commands/commands';
import type { Vec2 } from '@core/math/vec2';
import type { System, TickContext } from './system';

/**
 * Translates queued player Commands into world state.
 *
 * Runs first in the tick so that an order issued during the previous frame
 * takes effect on the same tick it is consumed — the player sees an immediate
 * response, and the simulation still only mutates at tick boundaries.
 */
export class OrderSystem implements System {
  readonly name = 'order';

  constructor(private readonly queue: CommandQueue) {}

  update(ctx: TickContext): void {
    for (const cmd of this.queue.drain()) this.apply(cmd, ctx);
  }

  private apply(cmd: Command, ctx: TickContext): void {
    const { world, events } = ctx;

    switch (cmd.type) {
      case 'move': {
        // Snap a click on water or off-map to the nearest ground the unit can
        // actually stand on, so a slightly misplaced click is forgiving
        // instead of silently doing nothing.
        const target: Vec2 | null = world.terrain.nearestPassable(cmd.destination);

        for (const id of cmd.divisions) {
          const d = world.getDivision(id);
          if (!d) continue;
          if (!target) {
            events.emit({ type: 'orderBlocked', division: id, reason: 'impassable' });
            continue;
          }
          if (cmd.append && d.order?.kind === 'move') {
            d.order.waypoints.push({ ...target });
          } else {
            d.order = {
              kind: 'move',
              waypoints: [{ ...target }],
              cursor: 0,
              bestDistance: Infinity,
              stalledTicks: 0,
            };
          }
          d.stance = 'move';
          events.emit({ type: 'orderIssued', division: id });
        }
        break;
      }

      case 'stop': {
        for (const id of cmd.divisions) {
          const d = world.getDivision(id);
          if (!d) continue;
          d.order = null;
          d.stance = 'hold';
        }
        break;
      }

      case 'setStance': {
        for (const id of cmd.divisions) {
          const d = world.getDivision(id);
          if (!d) continue;
          d.stance = cmd.stance;
          if (cmd.stance !== 'move') d.order = null;
        }
        break;
      }
    }
  }
}
