/**
 * Terrain classification.
 *
 * Numeric so the whole theatre fits in a Uint8Array. The order is stable and
 * persisted in saved games — append new kinds, never renumber existing ones.
 */
export enum Terrain {
  Water = 0,
  Plains = 1,
  Forest = 2,
  Marsh = 3,
  Hills = 4,
  Mountains = 5,
  Urban = 6,
  /** Open desert. North Africa is unplayable without it. */
  Desert = 7,
  /**
   * Norman bocage: sunken lanes between earth banks topped with hedge, each
   * field a walled compartment. Historically the worst ground in the west —
   * an infantry division could spend a day taking a few hundred metres.
   */
  Bocage = 8,
}

export const TERRAIN_COUNT = 9;

export interface TerrainProfile {
  readonly name: string;
  /** Multiplier applied to a division's base speed. 0 = impassable to ground units. */
  readonly moveMultiplier: number;
  /** Multiplier on the defender's combat strength. Reserved for Milestone 2. */
  readonly defenceBonus: number;
  /** Attrition per day spent in this terrain, as a fraction of strength. Milestone 3. */
  readonly attritionPerDay: number;
  /** Map fill colour, used by the renderer. */
  readonly color: number;
}

export const TERRAIN_PROFILES: Readonly<Record<Terrain, TerrainProfile>> = {
  [Terrain.Water]: { name: 'Water', moveMultiplier: 0, defenceBonus: 1, attritionPerDay: 0, color: 0x1b2a3a },
  [Terrain.Plains]: { name: 'Plains', moveMultiplier: 1.0, defenceBonus: 1.0, attritionPerDay: 0.0, color: 0x3f4a35 },
  [Terrain.Forest]: { name: 'Forest', moveMultiplier: 0.6, defenceBonus: 1.3, attritionPerDay: 0.002, color: 0x2f3d29 },
  [Terrain.Marsh]: { name: 'Marsh', moveMultiplier: 0.35, defenceBonus: 1.2, attritionPerDay: 0.006, color: 0x33402f },
  [Terrain.Hills]: { name: 'Hills', moveMultiplier: 0.7, defenceBonus: 1.4, attritionPerDay: 0.002, color: 0x4a4a33 },
  [Terrain.Mountains]: { name: 'Mountains', moveMultiplier: 0.4, defenceBonus: 1.8, attritionPerDay: 0.008, color: 0x55503c },
  [Terrain.Urban]: { name: 'Urban', moveMultiplier: 0.8, defenceBonus: 1.6, attritionPerDay: 0.0, color: 0x5a5347 },
  // Fast going and no cover: the desert rewards armour and punishes anyone
  // who stops. Attrition is water and heat, not enemy action.
  [Terrain.Desert]: { name: 'Desert', moveMultiplier: 0.9, defenceBonus: 0.85, attritionPerDay: 0.01, color: 0x7a6a45 },
  [Terrain.Bocage]: { name: 'Bocage', moveMultiplier: 0.3, defenceBonus: 2.0, attritionPerDay: 0.004, color: 0x35442c },
};

export const isPassable = (t: Terrain): boolean => TERRAIN_PROFILES[t].moveMultiplier > 0;
