import type { Vec2 } from '@core/math/vec2';
import type { BattleId, DivisionId } from './ids';

/** Which side of a battle a division is on. Index into `Battle.sides`. */
export type SideIndex = 0 | 1;

export interface BattleSide {
  /** Alliance key, e.g. "axis". */
  alliance: string;
  divisions: DivisionId[];
  /**
   * Is this side pressing the attack? A side attacks when it has somewhere to
   * be — a live move order. The distinction is what earns the other side its
   * terrain bonus, and it is why sitting in a forest is worth doing.
   */
  attacking: boolean;
  /** Last computed combat power, kept for the UI rather than the maths. */
  power: number;
}

/**
 * An engagement between two hostile groups in contact.
 *
 * A battle is a *relationship*, not a place: it owns no ground and no units,
 * only ids. Divisions keep marching, taking losses and being ordered around
 * while it exists, which is what lets a front be continuous rather than a set
 * of discrete province fights.
 */
export interface Battle {
  readonly id: BattleId;
  sides: [BattleSide, BattleSide];
  /** Centroid of everyone involved — where the bubble is drawn. */
  position: Vec2;
  startedTick: number;
  /** Terrain the defender is standing on, for display. */
  terrain: string;
  /** 0..1, how far the attacker has pushed. Drives the bubble's progress arc. */
  progress: number;
}

export const otherSide = (side: SideIndex): SideIndex => (side === 0 ? 1 : 0);

/** Divisions on both sides, for iteration. */
export function* battleParticipants(battle: Battle): Generator<DivisionId> {
  for (const side of battle.sides) for (const id of side.divisions) yield id;
}
