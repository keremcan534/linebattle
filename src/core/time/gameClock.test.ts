import { describe, expect, it } from 'vitest';
import {
  GameClock,
  MINUTES_PER_TICK,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
} from './gameClock';

describe('GameClock', () => {
  it('uses one canonical simulation tick per six game-hours', () => {
    expect(MINUTES_PER_TICK).toBe(360);
    expect(TICKS_PER_HOUR).toBe(1 / 6);
    expect(TICKS_PER_DAY).toBe(4);
  });

  it('keeps real-time pacing while advancing by quarter-days', () => {
    const clock = new GameClock(new Date('1941-06-22T03:15:00Z'));
    clock.setSpeed(1);
    for (let i = 0; i < 7; i++) expect(clock.advance(0.25)).toBe(0);
    expect(clock.advance(0.25)).toBe(1);
    clock.tick++;
    expect(clock.date.toISOString()).toBe('1941-06-22T09:15:00.000Z');
  });
});
