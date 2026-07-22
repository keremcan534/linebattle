import type { EventBus } from '@core/events/eventBus';
import type { World } from '@core/world/world';

export interface TickContext {
  world: World;
  events: EventBus;
  /** Simulated seconds represented by this tick. Constant by design. */
  dtSeconds: number;
  tick: number;
}

/**
 * A unit of simulation behaviour.
 *
 * Systems are registered in a fixed order and executed in that order every
 * tick. Order IS the dependency graph — supply must resolve before movement,
 * movement before contact detection, contact before combat — so it is declared
 * explicitly in one place (`createDefaultSystems`) rather than emerging from
 * import order.
 */
export interface System {
  readonly name: string;
  update(ctx: TickContext): void;
}
