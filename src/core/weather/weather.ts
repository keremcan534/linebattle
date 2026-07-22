/**
 * Season and weather.
 *
 * Barbarossa without the rasputitsa and the winter is a different war: the
 * mud of October 1941 stopped Army Group Centre more effectively than the Red
 * Army did, and the December frost cost the Wehrmacht more men to frostbite
 * than to enemy action in some sectors. A game that models supply and terrain
 * but treats June and December alike is telling a lie about its own subject.
 *
 * Climate is declared per scenario, because the same month means opposite
 * things in Smolensk and in the Western Desert.
 */

export type Climate = 'continental' | 'temperate' | 'desert';

export interface Weather {
  /** Display name: "Rasputitsa", "Deep winter", "Summer". */
  season: string;
  /** Multiplier on movement speed. */
  movement: number;
  /** Multiplier on terrain attrition. */
  attrition: number;
  /** Multiplier on combat power for everyone. */
  combat: number;
  /** Multiplier on organisation recovery — cold camps rest badly. */
  recovery: number;
}

const CLEAR: Weather = { season: 'Clear', movement: 1, attrition: 1, combat: 1, recovery: 1 };

/**
 * Weather for a date, derived rather than stored.
 *
 * Deterministic by construction: no RNG, so two runs of the same scenario see
 * the same weather on the same day. Random weather would be a legitimate
 * design choice later, but it must then come from `world.rng`, never `Math`.
 */
export function computeWeather(date: Date, climate: Climate): Weather {
  const month = date.getUTCMonth(); // 0 = January

  switch (climate) {
    case 'continental':
      // Eastern Europe: two mud seasons bracketing a hard winter.
      if (month === 11 || month === 0 || month === 1) {
        return { season: 'Deep winter', movement: 0.62, attrition: 3.2, combat: 0.88, recovery: 0.65 };
      }
      if (month === 2 || month === 3) {
        return { season: 'Spring rasputitsa', movement: 0.5, attrition: 1.6, combat: 0.92, recovery: 0.85 };
      }
      if (month === 9 || month === 10) {
        return { season: 'Autumn rasputitsa', movement: 0.45, attrition: 1.8, combat: 0.9, recovery: 0.8 };
      }
      return { season: 'Summer', movement: 1, attrition: 1, combat: 1, recovery: 1 };

    case 'desert':
      // No mud and no frost; heat and water are the enemy.
      if (month >= 5 && month <= 8) {
        return { season: 'Desert summer', movement: 0.95, attrition: 1.5, combat: 0.97, recovery: 0.9 };
      }
      return { season: 'Desert winter', movement: 1, attrition: 1, combat: 1, recovery: 1 };

    case 'temperate':
      // North-west Europe: wet, rarely impassable.
      if (month === 11 || month === 0 || month === 1) {
        return { season: 'Winter', movement: 0.82, attrition: 1.4, combat: 0.95, recovery: 0.9 };
      }
      if (month === 9 || month === 10 || month === 2) {
        return { season: 'Wet season', movement: 0.85, attrition: 1.2, combat: 0.97, recovery: 0.95 };
      }
      return { season: 'Summer', movement: 1, attrition: 1, combat: 1, recovery: 1 };

    default:
      return CLEAR;
  }
}
