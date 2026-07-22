/**
 * Branded id types.
 *
 * These are plain strings at runtime but distinct to the compiler, so a
 * FactionId can never be passed where a DivisionId is expected. Free safety,
 * zero cost — and it matters as soon as we add corps/armies/air wings.
 */
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type DivisionId = Brand<string, 'DivisionId'>;
export type FactionId = Brand<string, 'FactionId'>;
export type BattleId = Brand<string, 'BattleId'>;

export const divisionId = (s: string): DivisionId => s as DivisionId;
export const factionId = (s: string): FactionId => s as FactionId;
export const battleId = (s: string): BattleId => s as BattleId;
