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
    h.float(d.experience);
    h.text(d.stance);

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

  return h.value;
}

/** Hex form, for logs and desync reports. */
export const hashWorldHex = (world: World): string =>
  hashWorld(world).toString(16).padStart(8, '0');
