import type { Vec2 } from '@core/math/vec2';
import type { Stance } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import type { StrategicObjectiveKind } from '@core/world/strategicObjective';

/**
 * Every mutation of the world enters through a Command.
 *
 * Input handlers, the future AI and a future network layer are all just
 * *producers* of these; the simulation is the only consumer, and it drains the
 * queue at a tick boundary. Benefits we get for free:
 *   - orders issued mid-frame never corrupt a tick in progress;
 *   - the command stream is a replay file;
 *   - "what did the player do?" is one place, not scattered across the UI.
 */
export type Command =
  | {
      type: 'move';
      divisions: DivisionId[];
      destination: Vec2;
      append: boolean;
      issuer?: 'player' | 'operational-ai' | 'debug';
    }
  | { type: 'stop'; divisions: DivisionId[] }
  | { type: 'setStance'; divisions: DivisionId[]; stance: Stance }
  | {
      type: 'setObjective';
      alliance: string;
      kind: StrategicObjectiveKind;
      position: Vec2;
    }
  | {
      type: 'clearObjectives';
      alliance: string;
      kind?: StrategicObjectiveKind;
    };

export class CommandQueue {
  private pending: Command[] = [];

  push(cmd: Command): void {
    this.pending.push(cmd);
  }

  /** Hands over everything queued and resets. Called once per tick. */
  drain(): readonly Command[] {
    if (this.pending.length === 0) return EMPTY;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  get size(): number {
    return this.pending.length;
  }
}

const EMPTY: readonly Command[] = [];
