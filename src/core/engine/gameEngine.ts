import { CommandQueue, type Command } from '@core/commands/commands';
import { EventBus } from '@core/events/eventBus';
import { AiSystem } from '@core/systems/aiSystem';
import { AttritionSystem } from '@core/systems/attritionSystem';
import { CombatSystem } from '@core/systems/combatSystem';
import { ContactSystem } from '@core/systems/contactSystem';
import { MovementSystem } from '@core/systems/movementSystem';
import { OrderSystem } from '@core/systems/orderSystem';
import { RecoverySystem } from '@core/systems/recoverySystem';
import { SupplySystem } from '@core/systems/supplySystem';
import type { System, TickContext } from '@core/systems/system';
import { MINUTES_PER_TICK } from '@core/time/gameClock';
import { computeWeather } from '@core/weather/weather';
import type { World } from '@core/world/world';

/**
 * Owns the simulation: the world, the systems, the command queue and the clock.
 *
 * It does NOT own a requestAnimationFrame loop. The engine exposes `advance()`
 * and lets the renderer's ticker drive it, because there must be exactly one
 * clock in the application. Two independent loops is how you get a game that
 * stutters differently on every machine.
 */
export interface EngineOptions {
  /** Override the system list entirely (tests). */
  systems?: System[];
  /** Alliances the computer plays. Empty = every division is the player's. */
  aiAlliances?: readonly string[];
}

export class GameEngine {
  readonly events = new EventBus();
  readonly commands = new CommandQueue();
  private readonly systems: System[];

  constructor(readonly world: World, options: EngineOptions = {}) {
    this.systems = options.systems ?? createDefaultSystems(this.commands, options.aiAlliances ?? []);
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
    // Derived, never stored — the same rule as the date itself.
    this.world.weather = computeWeather(this.world.clock.date, this.world.climate);
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
 * units move, contact is re-evaluated where they ended up, battles are fought,
 * then everyone out of the line recovers.
 *
 * Contact runs AFTER movement on purpose. Detecting it first would let a
 * division march clean through an enemy formation in the same tick it touched
 * it. Recovery runs last so that organisation spent in a battle cannot be
 * refunded in the tick it was lost.
 */
export function createDefaultSystems(queue: CommandQueue, aiAlliances: readonly string[] = []): System[] {
  return [
    // The AI runs first so its commands join the player's in the same drain:
    // both are just command producers, and OrderSystem cannot tell them apart.
    new AiSystem(queue, new Set(aiAlliances)),
    new OrderSystem(queue),
    new SupplySystem(),
    new MovementSystem(),
    new ContactSystem(),
    new CombatSystem(),
    new AttritionSystem(),
    new RecoverySystem(),
  ];
}
