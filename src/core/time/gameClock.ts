/**
 * Simulation clock.
 *
 * The tick is FIXED at {@link MINUTES_PER_TICK} game-minutes. Speed controls
 * change how many ticks are executed per real second, never the size of a
 * tick. That is the single most important rule in the codebase: a variable
 * timestep would make results depend on the player's frame rate, which kills
 * replays, saves, deterministic AI and any future multiplayer.
 */
export const MINUTES_PER_TICK = 15;
export const TICKS_PER_HOUR = 60 / MINUTES_PER_TICK;
export const TICKS_PER_DAY = 24 * TICKS_PER_HOUR;

/** Real seconds per tick at each speed setting. Index = speed level. */
export const SPEED_TABLE: readonly number[] = [
  Infinity, // 0 — paused
  1.0, //     1 — 15 game-min per second
  0.5,
  0.25,
  0.1,
  0.04, //    5 — roughly a game-day every 4 seconds
];

export const MAX_SPEED = SPEED_TABLE.length - 1;

export class GameClock {
  /** Whole ticks elapsed since scenario start. The canonical time value. */
  tick = 0;
  /** Real-time accumulator, in seconds. Never part of the simulation state. */
  private accumulator = 0;
  speed = 0;

  constructor(readonly startDate: Date) {}

  get paused(): boolean {
    return this.speed <= 0;
  }

  /** Current in-game date, derived — never stored, so it can never drift. */
  get date(): Date {
    return new Date(this.startDate.getTime() + this.tick * MINUTES_PER_TICK * 60_000);
  }

  /** Fraction of the way through the current tick, for render interpolation. */
  get subTickAlpha(): number {
    const step = SPEED_TABLE[this.speed]!;
    return Number.isFinite(step) ? Math.min(1, this.accumulator / step) : 1;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, Math.min(MAX_SPEED, speed));
    if (this.speed === 0) this.accumulator = 0;
  }

  togglePause(): void {
    this.setSpeed(this.paused ? 3 : 0);
  }

  /**
   * Advances real time and returns how many simulation ticks are due.
   *
   * Capped at `maxTicks` so that a browser tab returning from the background
   * does not try to simulate an hour of game time in one frame ("spiral of
   * death"); the excess is discarded rather than queued.
   */
  advance(deltaSeconds: number, maxTicks = 8): number {
    if (this.paused) return 0;
    const step = SPEED_TABLE[this.speed]!;
    this.accumulator += Math.min(deltaSeconds, 0.25);

    let ticks = 0;
    while (this.accumulator >= step && ticks < maxTicks) {
      this.accumulator -= step;
      ticks++;
    }
    if (ticks === maxTicks) this.accumulator = 0;
    return ticks;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "22 Jun 1941  04:15" — the caption style of the map animations this game imitates. */
export function formatGameDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}  ${hh}:${mm}`;
}
