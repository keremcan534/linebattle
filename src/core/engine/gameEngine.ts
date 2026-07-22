import { CommandQueue, type Command } from '@core/commands/commands';
import { EventBus } from '@core/events/eventBus';
import { MovementSystem } from '@core/systems/movementSystem';
import { OrderSystem } from '@core/systems/orderSystem';
import { RecoverySystem } from '@core/systems/recoverySystem';
import type { System, TickContext } from '@core/systems/system';
import { MINUTES_PER_TICK } from '@core/time/gameClock';
import type { World } from '@core/world/world';

/**
 * Owns the simulation: the world, the systems, the command queue and the clock.
 *
 * It does NOT own a requestAnimationFrame loop. The engine exposes `advance()`
 * and lets the renderer's ticker drive it, because there must be exactly one
 * clock in the application. Two independent loops is how you get a game that
 * stutters differently on every machine.
 */
export class GameEngine {
  readonly events = new EventBus();
  readonly commands = new CommandQueue();
  private readonly systems: System[];

  constructor(readonly world: World, systems?: System[]) {
    this.systems = systems ?? createDefaultSystems(this.commands);
  }

  /** Convenience so callers never touch the queue directly. */
  issue(command: Command): void {
    this.commands.push(command);
  }

  /**
   * Advances real time by `deltaSeconds` and runs whatever whole ticks are due.
   * Returns the number of ticks simulated (0 while paused).
   */
  advance(deltaSeconds: number): number {
    const ticks = this.world.clock.advance(deltaSeconds);
    for (let i = 0; i < ticks; i++) this.step();
    return ticks;
  }

  /** Runs exactly one simulation tick. The only place world state changes. */
  step(): void {
    const ctx: TickContext = {
      world: this.world,
      events: this.events,
      dtSeconds: MINUTES_PER_TICK * 60,
      tick: this.world.clock.tick,
    };

    for (const system of this.systems) system.update(ctx);

    this.world.clock.tick++;
    this.events.emit({ type: 'tick', tick: this.world.clock.tick });
  }

  destroy(): void {
    this.events.clear();
  }
}

/**
 * The canonical system order.
 *
 * Read this list top to bottom and you have the tick: orders are consumed,
 * units move, then formations recover. Milestone 2 inserts supply before
 * movement and contact/combat after it — the ordering contract lives here and
 * only here.
 */
export function createDefaultSystems(queue: CommandQueue): System[] {
  return [
    new OrderSystem(queue),
    // supply           <- Milestone 3
    new MovementSystem(),
    // contact detection <- Milestone 2
    // combat resolution <- Milestone 2
    new RecoverySystem(),
  ];
}
