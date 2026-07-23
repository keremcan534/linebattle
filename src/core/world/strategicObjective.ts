import type { Vec2 } from '@core/math/vec2';

export type StrategicObjectiveKind = 'attack' | 'defense';
export type StrategicObjectiveId = string & {
  readonly __strategicObjective: unique symbol;
};

export interface StrategicObjective {
  id: StrategicObjectiveId;
  alliance: string;
  kind: StrategicObjectiveKind;
  position: Vec2;
  createdTick: number;
}

export const MAX_OBJECTIVES_PER_KIND = 3;

export const strategicObjectiveId = (value: string): StrategicObjectiveId =>
  value as StrategicObjectiveId;
