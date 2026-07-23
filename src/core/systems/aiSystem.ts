import type { CommandQueue } from '@core/commands/commands';
import { distanceSq } from '@core/math/vec2';
import { organisationRatio, strengthRatio, type Division } from '@core/world/division';
import { directionForAlliance, type FrontlineSegment } from '@core/world/frontline';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { ticksForHours } from '@core/time/gameClock';
import { ENGAGEMENT_RANGE_KM } from './contactSystem';
import type { System, TickContext } from './system';
import {
  activeFallback,
  activeHalt,
  activeOffensive,
} from '@core/world/campaign';

/** One order review every three game-hours, independent of tick granularity. */
const AI_INTERVAL_TICKS = ticksForHours(3);
/** How far a division "sees" threats, in km. */
const PERCEPTION_KM = 200;
/** React by moving once an enemy is this close; further away, hold ground. */
const REACT_KM = 80;
/** Blockers stop this far short of the enemy, so the enemy walks into them. */
const STANDOFF_KM = 8;
/** How many defenders one enemy can attract before others pick a new threat. */
const CLAIM_LIMIT = 3;
/** Radius for judging local superiority before counterattacking. */
const LOCAL_KM = 45;
/** Position held just behind the liquid control boundary. */
const SECTOR_HOLD_DEPTH_KM = 7;
/** Limited penetration on superiority; combat advances the line beyond this. */
const SECTOR_ADVANCE_DEPTH_KM = 12;
/** Avoid path churn once a formation is effectively in its frontage slot. */
const SECTOR_TOLERANCE_KM = 5;
/** Local power ratio required before a segment is allowed to advance. */
const ADVANCE_POWER_RATIO = 1.3;
const OBJECTIVE_INFLUENCE_KM = 900;
const POCKET_CLEANUP_RADIUS_KM = 220;
const POCKET_CLEANERS_PER_TARGET = 2;
/** How far to look for an enemy that has worked around toward our rear. */
const ENVELOPMENT_SCAN_KM = 70;
/**
 * An enemy counts as "behind us" when its bearing is within ~70° of the
 * direction to our own supply network — i.e. it is closing the mouth of a
 * pocket rather than pressing the front.
 */
const REAR_THREAT_COS = 0.35;

/**
 * Deterministic operational headquarters for every managed alliance.
 *
 * A division with a frontline assignment treats that segment—not an enemy
 * counter—as its destination. Nearby combat power only decides whether it
 * holds behind the boundary or advances a limited distance through it. This
 * preserves sector ownership and prevents tactical targets from pulling units
 * out of line. The legacy threat response below remains only as a safe fallback
 * for synthetic worlds that have no liquid-control frontage.
 *
 * The system produces Commands and never mutates divisions directly. Sorted
 * traversal and zero randomness keep replays deterministic.
 */
export class AiSystem implements System {
  readonly name = 'ai';

  constructor(
    private readonly queue: CommandQueue,
    private readonly alliances: ReadonlySet<string>,
  ) {}

  update(ctx: TickContext): void {
    if (this.alliances.size === 0) return;
    if (ctx.tick % AI_INTERVAL_TICKS !== 0) return;
    const { world } = ctx;

    const engaged = new Set<DivisionId>();
    for (const battle of world.battles.values()) {
      for (const side of battle.sides) for (const id of side.divisions) engaged.add(id);
    }

    const own: Division[] = [];
    for (const d of world.divisions.values()) {
      const alliance = world.getFaction(d.faction)?.alliance;
      if (alliance && this.alliances.has(alliance)) own.push(d);
    }
    // Sorted so two identical runs deal out identical claims.
    own.sort((a, b) => (a.id < b.id ? -1 : 1));

    const claims = new Map<DivisionId, number>();
    const cleanupClaims = new Map<DivisionId, number>();

    for (const d of own) {
      // Post-combat RETREAT and ADVANCE own their transitions; operational AI
      // must not overwrite either with a fresh strategic order mid-sequence.
      if (
        d.stance === 'retreat' ||
        d.stance === 'advance' ||
        d.state === 'RECOVERING'
      ) continue;

      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;

      // A pocketed formation tries to reopen contact with its capital-linked
      // supply network. Waiting in place made Soviet counters calmly watch the
      // ring close around them; a breakout is now an operational priority.
      if (d.encircled) {
        if (!this.withdrawToNetwork(d, alliance, world) && d.order) {
          this.queue.push({ type: 'stop', divisions: [d.id] });
        }
        continue;
      }

      // Slip back before the ring closes. Once an enemy has worked around to
      // the rear, holding the sector to the last man just donates a pocket;
      // the formation withdraws along its still-open corridor toward supply
      // and the line reforms behind it. This is what makes the front bend
      // like elastic under a breakthrough instead of shattering.
      if (this.envelopmentThreatened(d, alliance, world)) {
        if (this.withdrawToNetwork(d, alliance, world)) continue;
      }

      // Scenario-level operational phases sit above tactical contact. During
      // the Soviet withdrawal, a division disengages toward the prepared line
      // instead of waiting to be enveloped; during winter quarters an army
      // holds its assigned sector and does not begin fresh attacks.
      if (this.executeCampaignDirective(d, alliance, world)) continue;

      if (engaged.has(d.id)) {
        // Committed to a battle: fight it as a defender, not as an attacker
        // who happens to be standing still.
        if (d.order) this.queue.push({ type: 'stop', divisions: [d.id] });
        continue;
      }

      // Pocket contours are not part of the main frontage. At most two nearby
      // foot formations clean each trapped enemy; armour and motorised troops
      // remain available for exploitation on the living front.
      const pocket = this.claimPocketTarget(d, world, cleanupClaims);
      if (pocket) {
        this.orderToward(d, pocket.position);
        continue;
      }

      const segment = d.frontlineSegment
        ? world.frontlineSegments.get(d.frontlineSegment)
        : undefined;
      if (alliance && segment && segment.alliances.includes(alliance)) {
        this.operateAssignedSegment(d, alliance, segment, world);
        continue;
      }

      const threats = world
        .divisionsNear(d.position.x, d.position.y, PERCEPTION_KM)
        .filter(
          (o) =>
            !o.encircled &&
            o.stance !== 'retreat' &&
            world.hostile(d.faction, o.faction),
        )
        .sort(
          (a, b) =>
            distanceSq(d.position, a.position) - distanceSq(d.position, b.position) ||
            (a.id < b.id ? -1 : 1),
        );
      if (!threats.length) continue; // quiet sector: hold

      const target = threats.find((e) => (claims.get(e.id) ?? 0) < CLAIM_LIMIT) ?? threats[0]!;
      const dist = Math.sqrt(distanceSq(d.position, target.position));

      if (dist <= ENGAGEMENT_RANGE_KM * 1.1) {
        if (d.order) this.queue.push({ type: 'stop', divisions: [d.id] });
        continue;
      }
      if (dist > REACT_KM) continue; // watch, don't wander

      claims.set(target.id, (claims.get(target.id) ?? 0) + 1);

      // Counterattack only from clear local superiority; otherwise block and
      // make the enemy pay the attacker's toll.
      const near = world.divisionsNear(d.position.x, d.position.y, LOCAL_KM);
      const foes = near.filter((o) => o.stance !== 'retreat' && world.hostile(d.faction, o.faction)).length;
      const friends = near.length - foes;
      const attack = foes > 0 && friends >= foes * 2;

      const scale = attack ? 0 : STANDOFF_KM / Math.max(dist, 1e-6);
      const destination = {
        x: target.position.x + (d.position.x - target.position.x) * scale,
        y: target.position.y + (d.position.y - target.position.y) * scale,
      };

      // Don't churn the pathfinder re-issuing the order it already has.
      const last = d.order?.waypoints[d.order.waypoints.length - 1];
      if (last && distanceSq(last, destination) < 10 * 10) continue;

      this.queue.push({
        type: 'move',
        divisions: [d.id],
        destination,
        append: false,
        issuer: 'operational-ai',
      });
    }
  }

  private claimPocketTarget(
    d: Division,
    world: World,
    claims: Map<DivisionId, number>,
  ): Division | null {
    if (
      d.branch === 'armoured' ||
      d.branch === 'mechanised' ||
      d.branch === 'motorised' ||
      organisationRatio(d) < 0.4 ||
      d.supply < 0.3
    ) {
      return null;
    }

    const targets = [...world.divisions.values()]
      .filter(
        (enemy) =>
          enemy.encircled &&
          world.hostile(d.faction, enemy.faction) &&
          (claims.get(enemy.id) ?? 0) < POCKET_CLEANERS_PER_TARGET &&
          distanceSq(d.position, enemy.position) <= POCKET_CLEANUP_RADIUS_KM ** 2,
      )
      .sort(
        (a, b) =>
          distanceSq(d.position, a.position) - distanceSq(d.position, b.position) ||
          (a.id < b.id ? -1 : 1),
      );
    const target = targets[0];
    if (!target) return null;
    claims.set(target.id, (claims.get(target.id) ?? 0) + 1);
    return target;
  }

  /**
   * True when a hostile formation sits between this division and the nearest
   * point of its own supply network — the signature of a closing pocket. The
   * division is not encircled yet, which is exactly when withdrawal is still
   * cheap and still possible.
   */
  private envelopmentThreatened(
    d: Division,
    alliance: string,
    world: World,
  ): boolean {
    const rear = world.supply?.nearestNetworkPoint(alliance, d.position);
    if (!rear) return false;
    const rx = rear.x - d.position.x;
    const ry = rear.y - d.position.y;
    const rearLength = Math.hypot(rx, ry);
    if (rearLength < 1e-3) return false; // already sitting on the network
    const rearX = rx / rearLength;
    const rearY = ry / rearLength;

    const hostiles = world.divisionsNear(
      d.position.x,
      d.position.y,
      ENVELOPMENT_SCAN_KM,
    );
    for (const enemy of hostiles) {
      if (enemy.stance === 'retreat' || !world.hostile(d.faction, enemy.faction)) {
        continue;
      }
      const ex = enemy.position.x - d.position.x;
      const ey = enemy.position.y - d.position.y;
      const enemyLength = Math.hypot(ex, ey);
      if (enemyLength < 1e-3) continue;
      if ((ex * rearX + ey * rearY) / enemyLength > REAR_THREAT_COS) return true;
    }
    return false;
  }

  private withdrawToNetwork(
    d: Division,
    alliance: string,
    world: World,
  ): boolean {
    const destination = world.supply?.nearestNetworkPoint(alliance, d.position);
    if (!destination || distanceSq(d.position, destination) < SECTOR_TOLERANCE_KM ** 2) {
      return false;
    }
    this.orderToward(d, destination);
    return true;
  }

  private orderToward(d: Division, destination: { x: number; y: number }): void {
    const last = d.order?.waypoints[d.order.waypoints.length - 1];
    if (last && distanceSq(last, destination) < SECTOR_TOLERANCE_KM ** 2) return;
    this.queue.push({
      type: 'move',
      divisions: [d.id],
      destination,
      append: false,
      issuer: 'operational-ai',
    });
  }

  private executeCampaignDirective(
    d: Division,
    alliance: string,
    world: World,
  ): boolean {
    const plan = world.campaignPlans.get(alliance);
    if (
      activeFallback(plan, world.clock.date) ||
      activeHalt(plan, world.clock.date)
    ) {
      const segment = d.frontlineSegment
        ? world.frontlineSegments.get(d.frontlineSegment)
        : undefined;
      if (segment?.alliances.includes(alliance)) {
        this.operateAssignedSegment(d, alliance, segment, world, 'defense');
      } else if (d.order) {
        this.queue.push({ type: 'stop', divisions: [d.id] });
      }
      return true;
    }

    return false;
  }

  /**
   * Executes one frontage assignment without selecting an enemy formation as
   * a destination. Local enemies affect the advance/hold decision only.
   */
  private operateAssignedSegment(
    d: Division,
    alliance: string,
    segment: FrontlineSegment,
    world: World,
    forcedDoctrine?: 'defense',
  ): void {
    const direction = directionForAlliance(segment, alliance);
    if (direction === null) return;

    const nearby = world.divisionsNear(segment.position.x, segment.position.y, LOCAL_KM);
    let ownPower = 0;
    let enemyPower = 0;
    for (const other of nearby) {
      if (other.stance === 'retreat') continue;
      const power = this.operationalPower(other, world);
      const otherAlliance = world.getFaction(other.faction)?.alliance;
      if (otherAlliance === alliance) ownPower += power;
      else if (otherAlliance && segment.alliances.includes(otherAlliance)) enemyPower += power;
    }

    const doctrine = forcedDoctrine
      ? { kind: forcedDoctrine, influence: 1 } as const
      : this.segmentDoctrine(world, alliance, segment);
    const fallback = activeFallback(
      world.campaignPlans.get(alliance),
      world.clock.date,
    );
    // Strategic withdrawal is a bias, never a scripted destination. Soviet
    // sectors still exploit overwhelming local superiority and never abandon
    // their assigned frontage to march toward one shared map point.
    const fallbackCaution =
      fallback && doctrine.kind === 'balanced' ? 0.28 : 0;
    const requiredRatio = doctrine.kind === 'attack'
      ? ADVANCE_POWER_RATIO - doctrine.influence * 0.22
      : ADVANCE_POWER_RATIO + doctrine.influence * 0.7 + fallbackCaution;
    const unopposedAttack = doctrine.kind === 'attack' && doctrine.influence > 0.15 && enemyPower === 0;
    const advancing =
      doctrine.kind !== 'defense' &&
      (unopposedAttack || (enemyPower > 0 && ownPower >= enemyPower * requiredRatio));
    const advanceDepth =
      (fallback ? SECTOR_ADVANCE_DEPTH_KM * 0.7 : SECTOR_ADVANCE_DEPTH_KM) +
      (doctrine.kind === 'attack' ? doctrine.influence * 10 : 0);
    const holdDepth =
      doctrine.kind === 'defense'
        ? Math.max(3, SECTOR_HOLD_DEPTH_KM - doctrine.influence * 4)
        : SECTOR_HOLD_DEPTH_KM;
    const depth = advancing ? advanceDepth : -holdDepth;
    const destination = {
      x: segment.position.x + segment.normal.x * direction * depth,
      y: segment.position.y + segment.normal.y * direction * depth,
    };

    if (distanceSq(d.position, destination) <= SECTOR_TOLERANCE_KM ** 2) {
      if (d.order) this.queue.push({ type: 'stop', divisions: [d.id] });
      return;
    }

    const last = d.order?.waypoints[d.order.waypoints.length - 1];
    if (last && distanceSq(last, destination) < SECTOR_TOLERANCE_KM ** 2) return;

    this.queue.push({
      type: 'move',
      divisions: [d.id],
      destination,
      append: false,
      issuer: 'operational-ai',
    });
  }

  private operationalPower(d: Division, world: World): number {
    const attack = d.softAttack * (1 - d.hardness) + d.hardAttack * d.hardness;
    const alliance = world.getFaction(d.faction)?.alliance;
    const campaign = alliance
      ? world.campaignModifiers(alliance).combat
      : 1;
    return (
      attack *
      strengthRatio(d) *
      organisationRatio(d) *
      (0.4 + 0.6 * d.supply) *
      campaign
    );
  }

  private segmentDoctrine(
    world: World,
    alliance: string,
    segment: FrontlineSegment,
  ): { kind: 'attack' | 'defense' | 'balanced'; influence: number } {
    const offensive = activeOffensive(
      world.campaignPlans.get(alliance),
      world.clock.date,
    );
    if (offensive) {
      const dist = Math.sqrt(distanceSq(segment.position, offensive.target));
      if (dist >= offensive.influenceKm) {
        return { kind: 'defense', influence: 1 };
      }
      return {
        kind: 'attack',
        influence: Math.max(0.2, 1 - dist / offensive.influenceKm),
      };
    }

    let attack = 0;
    let defense = 0;
    for (const objective of world.strategicObjectives.values()) {
      if (objective.alliance !== alliance) continue;
      const dist = Math.sqrt(distanceSq(segment.position, objective.position));
      if (dist >= OBJECTIVE_INFLUENCE_KM) continue;
      const influence = 1 - dist / OBJECTIVE_INFLUENCE_KM;
      if (objective.kind === 'attack') attack = Math.max(attack, influence);
      else defense = Math.max(defense, influence);
    }

    if (defense > attack) return { kind: 'defense', influence: defense };
    if (attack > 0) return { kind: 'attack', influence: attack };
    return { kind: 'balanced', influence: 0 };
  }
}
