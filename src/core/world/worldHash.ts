import type { World } from './world';

/**
 * A checksum of the entire simulation state.
 *
 * This is the instrument that turns "the simulation is deterministic" from a
 * claim in a document into something a test can fail on. Two runs that agree
 * on this number agree on every position, every stat and the RNG stream.
 *
 * It is also the exact primitive multiplayer needs later: peers exchange the
 * hash each tick and a mismatch localises a desync to the tick it happened,
 * instead of to the hour someone noticed the armies were in different places.
 *
 * Floats are hashed by their raw IEEE-754 bytes, not by a rounded decimal
 * string — rounding would hide precisely the small divergences that grow into
 * desyncs.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

class ByteHasher {
  private h = FNV_OFFSET;
  private readonly view = new DataView(new ArrayBuffer(8));

  byte(b: number): void {
    this.h = Math.imul(this.h ^ (b & 0xff), FNV_PRIME);
  }

  int(value: number): void {
    this.view.setInt32(0, value | 0);
    for (let i = 0; i < 4; i++) this.byte(this.view.getUint8(i));
  }

  float(value: number): void {
    this.view.setFloat64(0, value);
    for (let i = 0; i < 8; i++) this.byte(this.view.getUint8(i));
  }

  text(value: string): void {
    for (let i = 0; i < value.length; i++) this.int(value.charCodeAt(i));
  }

  get value(): number {
    return this.h >>> 0;
  }
}

export function hashWorld(world: World): number {
  const h = new ByteHasher();

  h.int(world.clock.tick);

  const rng = world.rng.getState();
  h.int(rng.s0);
  h.int(rng.s1);
  h.int(rng.s2);
  h.int(rng.s3);

  // Sorted so that Map iteration order can never influence the result.
  const ids = [...world.divisions.keys()].sort();
  for (const id of ids) {
    const d = world.divisions.get(id)!;
    h.text(id);
    h.float(d.position.x);
    h.float(d.position.y);
    h.float(d.heading);
    h.float(d.manpower);
    h.float(d.organisation);
    h.float(d.morale);
    h.float(d.supply);
    h.int(d.encircledTicks);
    h.float(d.experience);
    h.float(d.equipmentRatio);
    h.float(d.doctrine);
    h.text(d.stance);
    h.text(d.state);
    if (d.frontlineSegment) h.text(d.frontlineSegment);
    else h.byte(0);

    if (d.advance) {
      h.text(d.advance.phase);
      h.float(d.advance.target.x);
      h.float(d.advance.target.y);
      for (const blocker of [...d.advance.blockedBy].sort()) h.text(blocker);
    } else {
      h.byte(0);
    }

    if (d.order) {
      h.text(d.order.kind);
      h.int(d.order.cursor);
      for (const wp of d.order.waypoints) {
        h.float(wp.x);
        h.float(wp.y);
      }
    } else {
      h.byte(0);
    }
  }

  // Battles are simulation state — two runs that agree on unit positions but
  // disagree on who is fighting whom have already diverged.
  h.int(world.nextBattleSerial);
  h.int(world.nextMobilizationSerial);
  for (const id of [...world.battles.keys()].sort()) {
    const battle = world.battles.get(id)!;
    h.text(id);
    h.int(battle.startedTick);
    h.float(battle.position.x);
    h.float(battle.position.y);
    h.float(battle.progress);
    for (const side of battle.sides) {
      h.text(side.alliance);
      h.byte(side.attacking ? 1 : 0);
      for (const d of side.divisions) h.text(d);
    }
  }

  for (const id of [...world.frontlineSegments.keys()].sort()) {
    const segment = world.frontlineSegments.get(id)!;
    h.text(id);
    h.text(segment.alliances[0]);
    h.text(segment.alliances[1]);
    h.float(segment.position.x);
    h.float(segment.position.y);
    h.float(segment.normal.x);
    h.float(segment.normal.y);
    h.float(segment.lengthKm);
    h.int(segment.updatedTick);
  }

  h.int(world.nextObjectiveSerial);
  h.int(world.objectiveRevision);
  for (const id of [...world.strategicObjectives.keys()].sort()) {
    const objective = world.strategicObjectives.get(id)!;
    h.text(id);
    h.text(objective.alliance);
    h.text(objective.kind);
    h.float(objective.position.x);
    h.float(objective.position.y);
    h.int(objective.createdTick);
  }

  for (const alliance of [...world.mobilizationProgress.keys()].sort()) {
    h.text(alliance);
    h.float(world.mobilizationProgress.get(alliance)!);
  }
  for (const alliance of [...world.mobilizationPolicies.keys()].sort()) {
    const policy = world.mobilizationPolicies.get(alliance)!;
    h.text(alliance);
    h.float(policy.daysPerDivision);
    h.float(policy.maxForceMultiplier);
    h.float(policy.divisionsPerFrontlineSegment);
  }
  for (const alliance of [...world.campaignPlans.keys()].sort()) {
    const plan = world.campaignPlans.get(alliance)!;
    h.text(alliance);
    if (plan.openingShock) {
      h.float(plan.openingShock.from ?? Number.NEGATIVE_INFINITY);
      h.float(plan.openingShock.until);
      h.float(plan.openingShock.combatMultiplier);
      h.float(plan.openingShock.recoveryMultiplier);
    } else h.byte(0);
    if (plan.fallback) {
      h.float(plan.fallback.until);
      h.float(plan.fallback.rearOffsetKm);
      h.float(plan.fallback.rearward.x);
      h.float(plan.fallback.rearward.y);
      h.float(plan.fallback.influenceKm);
      for (const point of plan.fallback.line) {
        h.float(point.x);
        h.float(point.y);
      }
    } else h.byte(0);
    if (plan.halt) {
      h.float(plan.halt.from);
      h.float(plan.halt.until);
      h.float(plan.halt.combatMultiplier);
      h.float(plan.halt.recoveryMultiplier);
    } else h.byte(0);
    if (plan.offensive) {
      h.float(plan.offensive.from);
      h.float(plan.offensive.target.x);
      h.float(plan.offensive.target.y);
      h.float(plan.offensive.influenceKm);
    } else h.byte(0);
  }

  for (const source of [...world.supplySources].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    h.text(source.name);
    h.text(source.alliance);
    h.byte((source.networkRoot ?? !source.capturable) ? 1 : 0);
  }

  // Liquid control ownership is simulation state: if two peers disagree on a
  // frontline cell, their supply sweeps and later advances will diverge.
  if (world.supply) {
    for (let i = 0; i < world.supply.control.length; i++) {
      h.byte(world.supply.control[i]!);
    }
  }

  return h.value;
}

/** Hex form, for logs and desync reports. */
export const hashWorldHex = (world: World): string =>
  hashWorld(world).toString(16).padStart(8, '0');
