import type { CommandQueue } from '@core/commands/commands';
import { distanceSq } from '@core/math/vec2';
import type { Division } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import { ENGAGEMENT_RANGE_KM } from './contactSystem';
import type { System, TickContext } from './system';

/** Ticks between AI decisions. 12 = one order review every three game-hours. */
const AI_INTERVAL_TICKS = 12;
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

/**
 * The opposing side's brain.
 *
 * It is deliberately nothing more than another producer of Commands into the
 * same queue the player uses — the payoff of the command-pattern decision made
 * in Milestone 1. It never mutates the world, never touches a division
 * directly, and a replay of the command stream doesn't even need to record it,
 * because it is a pure, deterministic function of world state: divisions are
 * visited in sorted id order and no randomness is consumed.
 *
 * The doctrine is minimal and defensive, which fits every shipped scenario
 * (the player holds the historical initiative in all three):
 *
 *  - enemy adjacent        → stand. Drop any move order, because a side with
 *                            orders counts as ATTACKING and forfeits the
 *                            terrain bonus. Standing still is the AI fighting
 *                            well, not the AI doing nothing.
 *  - enemy within reach    → move to a blocking position just short of it —
 *                            or onto it, when friends clearly outnumber the
 *                            local enemy (the counterattack).
 *  - nobody in perception  → hold. An AI that repositions idle divisions
 *                            turns the rear into a washing machine.
 *
 * The claim limit is what makes a *front* emerge instead of a dogpile: each
 * enemy spearhead can only attract so many defenders, so the rest spread to
 * the next threat along the line.
 *
 * What it is not, yet: it mounts no offensives of its own and guards no
 * specific objectives. That is the Milestone 4 operational layer, and it will
 * be built on formations, not divisions.
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

    for (const d of own) {
      if (d.stance === 'retreat') continue;

      if (engaged.has(d.id)) {
        // Committed to a battle: fight it as a defender, not as an attacker
        // who happens to be standing still.
        if (d.order) this.queue.push({ type: 'stop', divisions: [d.id] });
        continue;
      }

      const threats = world
        .divisionsNear(d.position.x, d.position.y, PERCEPTION_KM)
        .filter((o) => o.stance !== 'retreat' && world.hostile(d.faction, o.faction))
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

      this.queue.push({ type: 'move', divisions: [d.id], destination, append: false });
    }
  }
}
