import type { Command, CommandQueue } from '@core/commands/commands';
import type { Vec2 } from '@core/math/vec2';
import type { Division } from '@core/world/division';
import {
  MAX_OBJECTIVES_PER_KIND,
  strategicObjectiveId,
} from '@core/world/strategicObjective';
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
        const formations = cmd.divisions
          .map((id) => world.getDivision(id))
          .filter(
            (d): d is Division =>
              d !== undefined &&
              d.stance !== 'retreat' &&
              d.stance !== 'advance',
          );
        if (!formations.length) break;

        // A frontline assignment belongs to operational HQ, not to the
        // counter-selection UI. Direct player movement cannot pull a division
        // out of its sector; strategic objectives will influence HQ instead.
        const movable =
          cmd.issuer === 'player'
            ? formations.filter((d) => {
                if (!d.frontlineSegment) return true;
                events.emit({
                  type: 'orderBlocked',
                  division: d.id,
                  reason: 'sector-locked',
                });
                return false;
              })
            : formations;
        if (!movable.length) break;

        // A group order translates the formation instead of collapsing every
        // division onto one point. The clicked location is the new group
        // centre; each formation keeps its offset from the current (or queued)
        // centre, so a front advances as a line and a corps keeps its shape.
        const origins = new Map(
          movable.map((d) => [
            d.id,
            cmd.append && d.order?.kind === 'move'
              ? (d.order.waypoints[d.order.waypoints.length - 1] ?? d.position)
              : d.position,
          ]),
        );
        const centre = [...origins.values()].reduce(
          (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
          { x: 0, y: 0 },
        );
        centre.x /= origins.size;
        centre.y /= origins.size;

        for (const d of movable) {
          const origin = origins.get(d.id)!;
          const intended: Vec2 =
            movable.length === 1
              ? cmd.destination
              : {
                  x: origin.x + cmd.destination.x - centre.x,
                  y: origin.y + cmd.destination.y - centre.y,
                };
          // Snap a click on water or off-map to the nearest ground the unit
          // can stand on, so a slightly misplaced order stays forgiving.
          const target = world.terrain.nearestPassable(intended);
          if (!target) {
            events.emit({ type: 'orderBlocked', division: d.id, reason: 'impassable' });
            continue;
          }
          // Route around terrain rather than into it. The pathfinder returns
          // the destination unchanged when the way is already clear, so the
          // common case costs one line-of-sight walk.
          const route = world.pathfinder.findPath(origin, target);

          if (!route) {
            events.emit({ type: 'orderBlocked', division: d.id, reason: 'unreachable' });
            continue;
          }

          if (cmd.append && d.order?.kind === 'move') {
            d.order.waypoints.push(...route);
          } else {
            d.order = {
              kind: 'move',
              waypoints: route,
              cursor: 0,
              bestDistance: Infinity,
              stalledTicks: 0,
            };
          }
          // An explicit command replaces the automatic post-combat advance;
          // it never resumes the pre-combat route hidden underneath it.
          d.advance = null;
          d.stance = 'move';
          if (d.state !== 'CONTACT' && d.state !== 'FIGHTING') {
            d.state = 'MOVING';
          }
          events.emit({ type: 'orderIssued', division: d.id });
        }
        break;
      }

      case 'stop': {
        for (const id of cmd.divisions) {
          const d = world.getDivision(id);
          if (!d) continue;
          d.order = null;
          d.advance = null;
          d.stance = 'hold';
          if (d.state !== 'CONTACT' && d.state !== 'FIGHTING') {
            d.state =
              d.state === 'RECOVERING' ? 'RECOVERING' : 'FRONTLINE';
          }
        }
        break;
      }

      case 'setStance': {
        for (const id of cmd.divisions) {
          const d = world.getDivision(id);
          if (!d) continue;
          d.advance = null;
          d.stance = cmd.stance;
          if (cmd.stance !== 'move') d.order = null;
          if (d.state !== 'CONTACT' && d.state !== 'FIGHTING') {
            d.state = cmd.stance === 'move' ? 'MOVING' : 'FRONTLINE';
          }
        }
        break;
      }

      case 'setObjective': {
        if (!world.alliances.includes(cmd.alliance)) break;
        const existing = [...world.strategicObjectives.values()].filter(
          (objective) =>
            objective.alliance === cmd.alliance && objective.kind === cmd.kind,
        );
        if (existing.length >= MAX_OBJECTIVES_PER_KIND) break;

        const position = world.terrain.nearestPassable(cmd.position);
        if (!position) break;
        const id = strategicObjectiveId(`objective-${world.nextObjectiveSerial++}`);
        world.strategicObjectives.set(id, {
          id,
          alliance: cmd.alliance,
          kind: cmd.kind,
          position,
          createdTick: ctx.tick,
        });
        world.objectiveRevision++;
        break;
      }

      case 'clearObjectives': {
        let changed = false;
        for (const [id, objective] of world.strategicObjectives) {
          if (objective.alliance !== cmd.alliance) continue;
          if (cmd.kind && objective.kind !== cmd.kind) continue;
          world.strategicObjectives.delete(id);
          changed = true;
        }
        if (changed) world.objectiveRevision++;
        break;
      }
    }
  }
}
