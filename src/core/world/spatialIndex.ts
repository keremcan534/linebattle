import type { Division } from './division';
import type { DivisionId } from './ids';

/**
 * Uniform-grid spatial hash over division positions.
 *
 * Milestone 1 answered "who is near this point?" with a linear scan, which was
 * honest at the time: it ran only on player clicks. Contact detection changes
 * that — it asks the same question for every division, every tick. At 400
 * divisions and 24 ticks a day, a linear scan is 3.8 million distance tests per
 * simulated day, and it grows quadratically with the order of battle.
 *
 * Rebuilt from scratch each tick rather than maintained incrementally. With a
 * few hundred moving entities the rebuild is a few microseconds and it cannot
 * drift out of sync with the world, which an incremental index eventually
 * does. Revisit only if the entity count grows by an order of magnitude.
 *
 * Iteration order follows insertion order, so query results are deterministic.
 */
export class SpatialIndex {
  private readonly buckets = new Map<number, Division[]>();

  constructor(readonly cellSize: number) {}

  rebuild(divisions: Iterable<Division>): void {
    this.buckets.clear();
    for (const d of divisions) {
      const key = this.key(d.position.x, d.position.y);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(d);
      else this.buckets.set(key, [d]);
    }
  }

  /**
   * Divisions whose centre lies within `radius` km of the point.
   * `exclude` skips the querying division itself.
   */
  query(x: number, y: number, radius: number, exclude?: DivisionId): Division[] {
    const out: Division[] = [];
    const r2 = radius * radius;
    const span = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);

    for (let gy = cy - span; gy <= cy + span; gy++) {
      for (let gx = cx - span; gx <= cx + span; gx++) {
        const bucket = this.buckets.get(gx * PRIME + gy);
        if (!bucket) continue;
        for (const d of bucket) {
          if (d.id === exclude) continue;
          const dx = d.position.x - x;
          const dy = d.position.y - y;
          if (dx * dx + dy * dy <= r2) out.push(d);
        }
      }
    }
    return out;
  }

  private key(x: number, y: number): number {
    return Math.floor(x / this.cellSize) * PRIME + Math.floor(y / this.cellSize);
  }
}

/**
 * Spreads (gx, gy) across the number line so two different cells cannot share
 * a key. World coordinates are bounded well inside this, so no collisions.
 */
const PRIME = 73_856_093;
