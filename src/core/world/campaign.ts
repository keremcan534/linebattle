import type { Vec2 } from '@core/math/vec2';

/** Continuous formation-production policy for one alliance. */
export interface MobilizationPolicy {
  alliance: string;
  /** Organisation time for one new field division. */
  daysPerDivision: number;
  /** Long-term ceiling relative to the opening order of battle. */
  maxForceMultiplier: number;
  /** A growing frontage may raise the ceiling beyond the force multiplier. */
  divisionsPerFrontlineSegment: number;
}

export interface TimedCampaignModifier {
  from?: number;
  until: number;
  combatMultiplier: number;
  recoveryMultiplier: number;
}

/** A prepared line that an army withdraws to without turning into a rout. */
export interface FallbackPlan {
  until: number;
  line: Vec2[];
  /** Positions the defenders just behind the geometric line. */
  rearOffsetKm: number;
  /** Unit vector pointing toward the friendly rear area. */
  rearward: Vec2;
  /** Formations farther from the line are left to their normal sector AI. */
  influenceKm: number;
}

/** A theatre-wide operational pause, normally winter quarters. */
export interface OperationalHalt {
  from: number;
  until: number;
  combatMultiplier: number;
  recoveryMultiplier: number;
}

/** One post-pause Schwerpunkt rather than attacks along the whole frontage. */
export interface GrandOffensive {
  from: number;
  target: Vec2;
  influenceKm: number;
}

export interface AllianceCampaignPlan {
  alliance: string;
  openingShock?: TimedCampaignModifier;
  fallback?: FallbackPlan;
  halt?: OperationalHalt;
  offensive?: GrandOffensive;
  /** Mobilisation and resolve as initially held homeland is occupied. */
  nationalResolve?: {
    maximumAtTerritoryLoss: number;
    combatMultiplier: number;
    recoveryMultiplier: number;
    mobilizationMultiplier: number;
  };
}

export interface CampaignModifiers {
  combat: number;
  recovery: number;
  mobilization: number;
}

/** Date-derived campaign modifiers; no mutable phase flag can drift or desync. */
export function campaignModifiers(
  plan: AllianceCampaignPlan | undefined,
  date: Date,
  territoryLossRatio = 0,
): CampaignModifiers {
  if (!plan) return { combat: 1, recovery: 1, mobilization: 1 };
  const now = date.getTime();
  let combat = 1;
  let recovery = 1;
  let mobilization = 1;

  const shock = plan.openingShock;
  if (
    shock &&
    now >= (shock.from ?? Number.NEGATIVE_INFINITY) &&
    now < shock.until
  ) {
    combat *= shock.combatMultiplier;
    recovery *= shock.recoveryMultiplier;
  }

  const halt = plan.halt;
  if (halt && now >= halt.from && now < halt.until) {
    combat *= halt.combatMultiplier;
    recovery *= halt.recoveryMultiplier;
  }

  const resolve = plan.nationalResolve;
  if (resolve) {
    const progress = Math.max(
      0,
      Math.min(1, territoryLossRatio / resolve.maximumAtTerritoryLoss),
    );
    combat *= 1 + (resolve.combatMultiplier - 1) * progress;
    recovery *= 1 + (resolve.recoveryMultiplier - 1) * progress;
    mobilization *=
      1 + (resolve.mobilizationMultiplier - 1) * progress;
  }

  return { combat, recovery, mobilization };
}

export function activeFallback(
  plan: AllianceCampaignPlan | undefined,
  date: Date,
): FallbackPlan | null {
  const fallback = plan?.fallback;
  return fallback && date.getTime() < fallback.until ? fallback : null;
}

export function activeHalt(
  plan: AllianceCampaignPlan | undefined,
  date: Date,
): OperationalHalt | null {
  const halt = plan?.halt;
  const now = date.getTime();
  return halt && now >= halt.from && now < halt.until ? halt : null;
}

export function activeOffensive(
  plan: AllianceCampaignPlan | undefined,
  date: Date,
): GrandOffensive | null {
  const offensive = plan?.offensive;
  return offensive && date.getTime() >= offensive.from ? offensive : null;
}

/**
 * A scripted historical front.
 *
 * The front is a function x(latitude, time): at each latitude band the line's
 * world-x follows a dated schedule, so it advances east exactly like the real
 * 1941 maps. Both armies are guided onto it — one just east, one just west —
 * and `looseness` widens the tolerance band inside which local combat is left
 * to the emergent AI. At looseness 0 the front is history to the kilometre; at
 * 1 the script is ignored entirely.
 */
export interface ScriptedFront {
  looseness: number;
  /** Alliance that holds the eastern (higher world-x) side of the line. */
  eastAlliance: string;
  /** One entry per latitude band: the band's world-y and its x(time) schedule. */
  bands: { y: number; frames: { time: number; x: number }[] }[];
}

/** World-x of the scripted front at a world-y and date, or null if undefined. */
export function scriptedFrontX(
  front: ScriptedFront,
  y: number,
  date: Date,
): number | null {
  let band: ScriptedFront['bands'][number] | null = null;
  let best = Infinity;
  for (const candidate of front.bands) {
    const d = Math.abs(candidate.y - y);
    if (d < best) {
      best = d;
      band = candidate;
    }
  }
  if (!band || !band.frames.length) return null;

  const t = date.getTime();
  const frames = band.frames;
  if (t <= frames[0]!.time) return frames[0]!.x;
  const last = frames[frames.length - 1]!;
  if (t >= last.time) return last.x;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    if (t <= b.time) {
      const f = (t - a.time) / (b.time - a.time);
      return a.x + (b.x - a.x) * f;
    }
  }
  return last.x;
}
