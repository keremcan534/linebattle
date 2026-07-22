import type { FactionId } from './ids';

export interface Faction {
  readonly id: FactionId;
  name: string;
  /** Nations sharing an alliance fight as one side. */
  alliance: string;
  /** Counter fill, 0xRRGGBB. */
  color: number;
  /** Counter outline / text colour. */
  accentColor: number;
}

export const areHostile = (a: Faction, b: Faction): boolean => a.alliance !== b.alliance;
