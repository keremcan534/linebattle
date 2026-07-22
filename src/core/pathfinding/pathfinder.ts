import type { Vec2 } from '@core/math/vec2';
import type { TerrainGrid } from '@core/terrain/terrainGrid';
import { TERRAIN_PROFILES, type Terrain } from '@core/terrain/terrainTypes';

/**
 * A* over the terrain grid, with a line-of-sight fast path.
 *
 * Milestone 1 walked straight at the objective and abandoned the order after
 * two hours of no progress — correct behaviour, but it meant a division told
 * to go round a lake simply gave up. This produces the waypoints instead.
 *
 * `MovementSystem` is untouched by this, exactly as the architecture doc
 * promised: it already only knew how to walk a list of points, and this
 * changes who produces the list.
 *
 * Three decisions worth stating:
 *
 * 1. **Straight line first.** Most orders are unobstructed, and a
 *    line-of-sight walk is orders of magnitude cheaper than a grid search.
 *    A* only runs when the direct route is actually blocked, which is what
 *    makes it affordable to path a hundred divisions on one click.
 *
 * 2. **Scratch buffers are allocated once and reused** via a generation stamp,
 *    so a search costs no allocation and no clearing. On the Eastern Front the
 *    grid is 821k cells; allocating per call would be 10 MB of churn per
 *    division per order.
 *
 * 3. **Deterministic tie-breaking.** Equal-f nodes are ordered by cell index,
 *    never by insertion accident, so two runs of the same scenario produce
 *    byte-identical paths. Pathfinding feeds unit positions, which the world
 *    hash covers.
 */

/** Give up beyond this many expansions and let the caller fall back. */
const MAX_EXPANSIONS = 120_000;

export class Pathfinder {
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint8Array;
  private generation = 0;

  /** Binary heap of cell indices, ordered by fScore. */
  private heap: Int32Array;
  private heapSize = 0;

  constructor(private readonly terrain: TerrainGrid) {
    const n = terrain.width * terrain.height;
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint8Array(n);
    this.heap = new Int32Array(1024);
  }

  /**
   * Waypoints from `from` to `to`, excluding the start.
   *
   * Returns `[to]` when the way is clear, a smoothed route when it is not, and
   * `null` when no route exists at all (an island, or the search gave up).
   */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    if (this.hasLineOfSight(from, to)) return [{ ...to }];

    const startIndex = this.terrain.indexAt(from);
    const goalIndex = this.terrain.indexAt(to);
    if (startIndex < 0 || goalIndex < 0) return null;
    if (!this.passable(goalIndex)) return null;

    const cells = this.search(startIndex, goalIndex);
    if (!cells) return null;

    return this.smooth(from, cells, to);
  }

  /**
   * True when a straight march from `a` to `b` crosses only passable ground.
   * Sampled at half a cell, which cannot skip over a cell-wide barrier.
   */
  hasLineOfSight(a: Vec2, b: Vec2): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return this.terrain.isPassableAt(a);

    const step = this.terrain.cellSize * 0.5;
    const steps = Math.ceil(length / step);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.terrain.isPassableAt({ x: a.x + dx * t, y: a.y + dy * t })) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ A* --

  private search(start: number, goal: number): number[] | null {
    const { width, height, cellSize } = this.terrain;
    const generation = ++this.generation;
    this.heapSize = 0;

    const goalX = goal % width;
    const goalY = (goal / width) | 0;

    this.stamp[start] = generation;
    this.closed[start] = 0;
    this.gScore[start] = 0;
    this.fScore[start] = this.heuristic(start % width, (start / width) | 0, goalX, goalY);
    this.cameFrom[start] = -1;
    this.heapPush(start);

    let expansions = 0;

    while (this.heapSize > 0) {
      const current = this.heapPop();
      if (current === goal) return this.reconstruct(current);
      if (this.closed[current]) continue;
      this.closed[current] = 1;

      if (++expansions > MAX_EXPANSIONS) return null;

      const cx = current % width;
      const cy = (current / width) | 0;
      const g = this.gScore[current]!;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const neighbour = ny * width + nx;
          if (!this.passable(neighbour)) continue;

          // No cutting a diagonal past the corner of an impassable cell:
          // a division cannot slip between two lakes that touch at a point.
          if (dx !== 0 && dy !== 0) {
            if (!this.passable(cy * width + nx) || !this.passable(ny * width + cx)) continue;
          }

          const distance = dx !== 0 && dy !== 0 ? cellSize * Math.SQRT2 : cellSize;
          // Cost is TIME, not distance: crossing marsh is short and slow.
          const tentative = g + distance / this.speedAt(neighbour);

          if (this.stamp[neighbour] !== generation) {
            this.stamp[neighbour] = generation;
            this.closed[neighbour] = 0;
            this.gScore[neighbour] = Infinity;
          }
          if (tentative >= this.gScore[neighbour]!) continue;

          this.gScore[neighbour] = tentative;
          this.cameFrom[neighbour] = current;
          this.fScore[neighbour] = tentative + this.heuristic(nx, ny, goalX, goalY);
          this.heapPush(neighbour);
        }
      }
    }
    return null;
  }

  /** Octile distance at best-case speed — admissible, so paths stay optimal. */
  private heuristic(x: number, y: number, goalX: number, goalY: number): number {
    const dx = Math.abs(x - goalX);
    const dy = Math.abs(y - goalY);
    const octile = (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    return octile * this.terrain.cellSize;
  }

  private passable(index: number): boolean {
    return TERRAIN_PROFILES[this.terrain.cells[index] as Terrain].moveMultiplier > 0;
  }

  private speedAt(index: number): number {
    return TERRAIN_PROFILES[this.terrain.cells[index] as Terrain].moveMultiplier;
  }

  private reconstruct(goal: number): number[] {
    const out: number[] = [];
    for (let node = goal; node !== -1; node = this.cameFrom[node]!) out.push(node);
    return out.reverse();
  }

  /**
   * String-pulling: keep only the waypoints the terrain actually forces.
   *
   * A raw grid path is a staircase of hundreds of cells. Marching it directly
   * would look robotic and bloat every saved order, so we walk forward taking
   * the furthest point still in line of sight. Typical output is a handful of
   * corners around the obstacle.
   */
  private smooth(from: Vec2, cells: number[], goal: Vec2): Vec2[] {
    const points: Vec2[] = cells.map((index) => this.centreOf(index));
    points.push({ ...goal });

    const out: Vec2[] = [];
    let anchor = from;
    let i = 0;

    while (i < points.length) {
      let furthest = i;
      for (let j = i; j < points.length; j++) {
        if (!this.hasLineOfSight(anchor, points[j]!)) break;
        furthest = j;
      }
      // If even the next point is not visible, take it anyway — it is one cell
      // away and the grid says it is reachable.
      const next = points[Math.max(furthest, i)]!;
      out.push(next);
      anchor = next;
      i = Math.max(furthest, i) + 1;
    }
    return out;
  }

  private centreOf(index: number): Vec2 {
    const x = index % this.terrain.width;
    const y = (index / this.terrain.width) | 0;
    return {
      x: this.terrain.origin.x + (x + 0.5) * this.terrain.cellSize,
      y: this.terrain.origin.y + (y + 0.5) * this.terrain.cellSize,
    };
  }

  // ---------------------------------------------------------------- heap --

  private heapPush(node: number): void {
    if (this.heapSize === this.heap.length) {
      const grown = new Int32Array(this.heap.length * 2);
      grown.set(this.heap);
      this.heap = grown;
    }
    let i = this.heapSize++;
    this.heap[i] = node;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(this.heap[i]!, this.heap[parent]!)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  private heapPop(): number {
    const top = this.heap[0]!;
    this.heap[0] = this.heap[--this.heapSize]!;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.heapSize && this.less(this.heap[left]!, this.heap[best]!)) best = left;
      if (right < this.heapSize && this.less(this.heap[right]!, this.heap[best]!)) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return top;
  }

  /** Cell index breaks f-score ties, so ordering never depends on history. */
  private less(a: number, b: number): boolean {
    const fa = this.fScore[a]!;
    const fb = this.fScore[b]!;
    return fa === fb ? a < b : fa < fb;
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i]!;
    this.heap[i] = this.heap[j]!;
    this.heap[j] = tmp;
  }
}
