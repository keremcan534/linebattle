import type { DivisionId } from '@core/world/ids';

/**
 * Notifications flowing OUT of the simulation.
 *
 * The counterpart to Commands: commands go in, events come out. Nothing in
 * `core/` may reach into the UI, so anything the UI needs to react to
 * (a division arriving, a battle starting) is announced here instead. Sound,
 * notifications, the event log and camera-follow all subscribe without the
 * simulation ever learning they exist.
 */
export type GameEvent =
  | { type: 'tick'; tick: number }
  | { type: 'orderIssued'; division: DivisionId }
  | { type: 'destinationReached'; division: DivisionId }
  | { type: 'orderBlocked'; division: DivisionId; reason: 'impassable' };

type Handler<E extends GameEvent = GameEvent> = (event: E) => void;

export class EventBus {
  private handlers = new Map<GameEvent['type'], Set<Handler>>();
  private anyHandlers = new Set<Handler>();

  on<T extends GameEvent['type']>(
    type: T,
    handler: Handler<Extract<GameEvent, { type: T }>>,
  ): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  emit(event: GameEvent): void {
    this.handlers.get(event.type)?.forEach((h) => h(event));
    this.anyHandlers.forEach((h) => h(event));
  }

  clear(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }
}
