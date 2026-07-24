import { distanceSq } from '@core/math/vec2';
import { directionForAlliance, type FrontlineSegment } from '@core/world/frontline';
import { divisionId } from '@core/world/ids';
import type { SupplySource, World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Conservative defaults for scenarios without an explicit campaign policy. */
const DEFAULT_DAYS_PER_NEW_DIVISION = 14;
const DEFAULT_FORCE_MULTIPLIER = 1;
const DEFAULT_DIVISIONS_PER_FRONTLINE_SEGMENT = 0.75;

/**
 * Raises new formations for both sides from their capital-linked rear area.
 *
 * Field replacements restore existing manpower; this system is different:
 * it creates a new division only when losses or a longer front leave an
 * alliance below its operational requirement. Production is deliberately
 * slow, symmetric and deterministic.
 */
export class MobilizationSystem implements System {
  readonly name = 'mobilization';

  update(ctx: TickContext): void {
    const { world } = ctx;
    if (!world.supply) return;
    const days = ctx.dtSeconds / 86_400;

    for (const alliance of world.alliances) {
      const policy = world.mobilizationPolicies.get(alliance);
      const daysPerDivision =
        policy?.daysPerDivision ?? DEFAULT_DAYS_PER_NEW_DIVISION;
      const forceMultiplier =
        policy?.maxForceMultiplier ?? DEFAULT_FORCE_MULTIPLIER;
      const frontageDensity =
        policy?.divisionsPerFrontlineSegment ??
        DEFAULT_DIVISIONS_PER_FRONTLINE_SEGMENT;
      const current = [...world.divisions.values()].filter(
        (d) => world.getFaction(d.faction)?.alliance === alliance,
      ).length;
      const frontage = [...world.frontlineSegments.values()].filter((segment) =>
        segment.alliances.includes(alliance),
      ).length;
      const initial = world.initialDivisionCounts.get(alliance) ?? current;
      const required = Math.max(
        Math.ceil(initial * forceMultiplier),
        Math.ceil(frontage * frontageDensity),
      );
      const frontlineReady = [...world.divisions.values()].filter(
        (d) =>
          world.getFaction(d.faction)?.alliance === alliance &&
          d.frontlineSegment !== null &&
          d.stance !== 'retreat' &&
          !d.encircled,
      ).length;
      const desiredCoverage = Math.max(1, frontageDensity);
      const coverage =
        frontage > 0
          ? frontlineReady / (frontage * desiredCoverage)
          : 1;
      // Empty sectors trigger emergency drafting and rail deployment. This is
      // continuous operational pressure, not a scripted spawn wave. The surge
      // is deliberately modest: at ×2 a single breakthrough summoned a flood
      // that reversed the attacker before winter, killing the historical arc.
      const coverageSurge =
        coverage < 1 ? 1 + (1 - coverage) * 1.2 : 1;
      const nationalMobilization =
        world.campaignModifiers(alliance).mobilization;
      const emergencyGap = Math.max(
        0,
        Math.ceil(frontage * desiredCoverage - frontlineReady),
      );
      const emergencyCeiling =
        required + Math.ceil(frontage * 0.2);
      const operationalRequired = Math.max(
        required,
        Math.min(emergencyCeiling, current + emergencyGap),
      );

      let progress = world.mobilizationProgress.get(alliance) ?? 0;
      if (current >= operationalRequired) {
        world.mobilizationProgress.set(alliance, Math.min(progress, 0.95));
        continue;
      }

      progress +=
        (days / daysPerDivision) *
        nationalMobilization *
        coverageSurge;
      if (progress < 1) {
        world.mobilizationProgress.set(alliance, progress);
        continue;
      }

      // A twelve-hour strategic tick can contain several emergency formations.
      // Keep fractional production while bounding the work of one tick.
      let raised = 0;
      while (
        progress >= 1 &&
        current + raised < operationalRequired &&
        raised < 8
      ) {
        if (!this.raiseDivision(world, alliance, ctx)) break;
        progress -= 1;
        raised++;
      }
      world.mobilizationProgress.set(alliance, progress);
    }
  }

  private raiseDivision(world: World, alliance: string, ctx: TickContext): boolean {
    const cadre = world.mobilizationCadres.get(alliance);
    if (!cadre) return false;
    const source = this.chooseRoot(world, alliance);
    const deployment = this.chooseFrontlineDeployment(world, alliance);
    if (!source && !deployment) return false;

    const serial = world.nextMobilizationSerial++;
    const angle = serial * 2.399963229728653;
    const fallback = source
      ? {
          x: source.position.x + Math.cos(angle) * 12,
          y: source.position.y + Math.sin(angle) * 12,
        }
      : null;
    const position = deployment?.position ??
      (fallback
        ? world.terrain.nearestPassable(fallback, 40) ??
          world.terrain.nearestPassable(source!.position, 40)
        : null);
    if (!position) return false;

    const id = divisionId(`raised-${alliance.replace(/[^a-z0-9]+/gi, '-')}-${serial}`);
    world.addDivision({
      id,
      faction: cadre.faction,
      name: `${source?.name ?? 'Front'} Reinforcement Division ${serial}`,
      shortName: `R.${serial}`,
      formation: deployment ? 'Rapid Deployment' : 'Strategic Reserve',
      branch: cadre.branch,
      position,
      prevPosition: { ...position },
      heading: 0,
      order: null,
      stance: 'hold',
      advance: null,
      frontlineSegment: deployment?.segment.id ?? null,
      manpower: cadre.maxManpower * 0.75,
      maxManpower: cadre.maxManpower,
      // Rapidly deployed emergency formations fill frontage immediately but
      // need time behind/at the line before they fight at full cohesion.
      organisation: cadre.maxOrganisation * 0.5,
      maxOrganisation: cadre.maxOrganisation,
      morale: Math.max(0.6, cadre.morale * 0.9),
      supply: 1,
      encircled: false,
      encircledTicks: 0,
      experience: Math.max(0.1, cadre.experience * 0.6),
      speedKmh: cadre.speedKmh,
      softAttack: cadre.softAttack,
      hardAttack: cadre.hardAttack,
      defence: cadre.defence,
      hardness: cadre.hardness,
    });
    ctx.events.emit({ type: 'divisionRaised', division: id, position: { ...position } });
    return true;
  }

  /**
   * Strategic rail deployment: a raised formation appears behind the least
   * occupied capital-connected frontage instead of spending months walking
   * from Moscow and joining the same queue as every earlier recruit.
   */
  private chooseFrontlineDeployment(
    world: World,
    alliance: string,
  ): { position: { x: number; y: number }; segment: FrontlineSegment } | null {
    const field = world.supply;
    if (!field) return null;

    const loads = new Map<string, number>();
    for (const division of world.divisions.values()) {
      if (
        world.getFaction(division.faction)?.alliance !== alliance ||
        !division.frontlineSegment
      ) {
        continue;
      }
      loads.set(
        division.frontlineSegment,
        (loads.get(division.frontlineSegment) ?? 0) + 1,
      );
    }

    const segments = [...world.frontlineSegments.values()]
      .filter((segment) => segment.alliances.includes(alliance))
      .sort(
        (a, b) =>
          (loads.get(a.id) ?? 0) - (loads.get(b.id) ?? 0) ||
          (a.id < b.id ? -1 : 1),
      );

    for (const segment of segments) {
      const direction = directionForAlliance(segment, alliance);
      if (direction === null) continue;
      // Deploy well behind the encirclement-scan depth (ZOC x3 = 66 km), so a
      // fresh, half-organised formation forms up in the rear and rails forward
      // to its sector rather than spawning under the enemy's guns and being
      // destroyed before it can dig in.
      const REAR_DEPLOY_KM = 90;
      const rear = {
        x: segment.position.x - segment.normal.x * direction * REAR_DEPLOY_KM,
        y: segment.position.y - segment.normal.y * direction * REAR_DEPLOY_KM,
      };
      const connected = field.nearestNetworkPoint(alliance, rear);
      if (
        !connected ||
        distanceSq(connected, rear) > 140 * 140
      ) {
        continue;
      }
      const position =
        world.terrain.nearestPassable(connected, 24) ?? connected;
      return { position, segment };
    }
    return null;
  }

  private chooseRoot(world: World, alliance: string): SupplySource | null {
    const roots = world.supplySources
      .filter(
        (source) =>
          source.alliance === alliance &&
          (source.networkRoot ?? !source.capturable) &&
          world.supply!.networkAt(alliance, source.position),
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!roots.length) return null;

    const segments = [...world.frontlineSegments.values()].filter((segment) =>
      segment.alliances.includes(alliance),
    );
    if (!segments.length) return roots[0]!;
    const centre = segments.reduce(
      (sum, segment) => ({
        x: sum.x + segment.position.x / segments.length,
        y: sum.y + segment.position.y / segments.length,
      }),
      { x: 0, y: 0 },
    );
    return roots.sort(
      (a, b) =>
        distanceSq(a.position, centre) - distanceSq(b.position, centre) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )[0]!;
  }
}
