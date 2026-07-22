import type { Vec2 } from '@core/math/vec2';
import type { DivisionId, FactionId } from './ids';

/**
 * Combat arm. Drives the NATO symbol drawn on the counter and, later, the
 * combat maths (armour vs. soft targets, terrain affinity).
 */
export type Branch =
  | 'infantry'
  | 'motorised'
  | 'mechanised'
  | 'armoured'
  | 'cavalry'
  | 'mountain'
  | 'airborne'
  | 'artillery'
  | 'security';

/**
 * `retreat` is a real state, not a flavour of `move`: ContactSystem refuses to
 * enrol a retreating division in a new battle, which is what stops a broken
 * formation walking 500 m, coming back into range and being ground to nothing.
 */
export type Stance = 'move' | 'hold' | 'entrench' | 'retreat';

/**
 * A movement order: an ordered list of world-space waypoints.
 *
 * Milestone 1 follows waypoints in a straight line and simply refuses to enter
 * impassable cells. Milestone 2 replaces `waypoints` with the output of a
 * pathfinder over the terrain grid — note that the *order* type does not have
 * to change for that, only who produces the list.
 */
export interface MoveOrder {
  kind: 'move';
  waypoints: Vec2[];
  /** Index of the waypoint currently being approached. */
  cursor: number;
  /**
   * Closest the division has come to the current waypoint, in km, and how many
   * ticks it has failed to beat that.
   *
   * Without this a division ordered across a lake walks into the shore and
   * grinds against it forever: coast-sliding "succeeds" every tick, so nothing
   * ever reports the order as impossible, while organisation bleeds away. This
   * is the stopgap until Milestone 2's pathfinder makes such orders unissuable
   * in the first place.
   */
  bestDistance: number;
  stalledTicks: number;
}

export type Order = MoveOrder;

/**
 * A single division — the atomic manoeuvre unit of the game.
 *
 * Mutable plain object rather than a class: systems own the behaviour, the
 * record owns the data. That split is what lets us snapshot the entire world
 * with a structured clone for saves, replays and rollback.
 */
export interface Division {
  readonly id: DivisionId;
  readonly faction: FactionId;

  /** "1. Panzer-Division" */
  name: string;
  /** Short label drawn on the counter: "1.Pz" */
  shortName: string;
  /** Parent formation for grouping in the UI: "6. Armee" */
  formation: string;
  branch: Branch;

  /** World position in km. */
  position: Vec2;
  /** Position at the start of the current tick, for render interpolation. */
  prevPosition: Vec2;
  /** Heading in radians, for drawing movement arrows. */
  heading: number;

  order: Order | null;
  stance: Stance;

  // --- Fighting power -------------------------------------------------------
  /** Current men under arms. */
  manpower: number;
  maxManpower: number;
  /** Cohesion. Spent by combat and movement, recovered while resting. */
  organisation: number;
  maxOrganisation: number;
  /** 0..1 — willingness to keep fighting. */
  morale: number;
  /** 0..1 — fraction of required supply actually received. */
  supply: number;
  /**
   * Cut off, as distinct from merely badly supplied. Drives the pocket
   * attrition multiplier and the warning on the counter.
   */
  encircled: boolean;
  /** 0..1 — veterancy. */
  experience: number;

  /** Unopposed road speed in km/h, before terrain and supply modifiers. */
  speedKmh: number;
  /** Reserved for Milestone 2 combat resolution. */
  softAttack: number;
  hardAttack: number;
  defence: number;
  /** 0..1 — share of the division that is armoured. */
  hardness: number;
}

/** 0..1 headline readiness, used for the strength bar on the counter. */
export const strengthRatio = (d: Division): number =>
  d.maxManpower > 0 ? d.manpower / d.maxManpower : 0;

export const organisationRatio = (d: Division): number =>
  d.maxOrganisation > 0 ? d.organisation / d.maxOrganisation : 0;

/**
 * Effective speed in km/h before terrain is applied.
 *
 * Low supply and shattered organisation both slow a division down: a formation
 * out of fuel does not advance at parade speed. Kept here rather than in the
 * movement system so the UI can show the same number the sim uses.
 */
export function effectiveSpeedKmh(d: Division, weatherMovement = 1): number {
  const supplyFactor = 0.35 + 0.65 * d.supply;
  const orgFactor = 0.5 + 0.5 * organisationRatio(d);
  // A broken formation still moves — that is the whole point of retreating —
  // and men in flight are not slow. What a rout lacks is cohesion, and the
  // organisation factor above already collapses for a broken division; taxing
  // the stance as well made routers so slow that pursuers drove straight over
  // them, which read as "the enemy retreats in slow motion".
  const stanceFactor = d.stance === 'move' ? 1 : d.stance === 'retreat' ? 0.9 : 0;
  return d.speedKmh * supplyFactor * orgFactor * stanceFactor * weatherMovement;
}
