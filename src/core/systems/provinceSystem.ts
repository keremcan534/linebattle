import { NO_PROVINCE } from '@core/province/province';
import type { ProvinceMap } from '@core/province/provinceMap';
import type { Division } from '@core/world/division';
import type { World } from '@core/world/world';
import type { System, TickContext } from './system';

/** Ticks between ownership recomputes. 4 = one game-hour, matching supply. */
const RECOMPUTE_INTERVAL = 4;

/** How much one side must outweigh the rest in a province to seize it. */
const DOMINANCE_RATIO = 1.4;
/** Presence below this counts as "nobody is really here". */
const PRESENCE_FLOOR = 0.08;
/** Supply a centroid must see for the logistics sweep to claim it. */
const SUPPLY_FLOOR = 0.05;

/**
 * Owns the political map: which alliance holds each province.
 *
 * This is what a fuzzy cell-by-cell control field could only approximate. A
 * province is held by exactly one side or nobody, so the front line — the
 * border between two owners — is a hard, crisp edge that can never smear.
 *
 * Two ways a province changes hands, both deliberate:
 *
 *  - **Seizure**: your divisions there clearly outweigh everyone else's. This
 *    is the front physically moving.
 *  - **Logistics sweep**: nobody stands there, but exactly one side's supply
 *    reaches it AND it touches ground that side already holds. This paints the
 *    rear behind an advance so territory fills in like the historical map
 *    animations, and it gets pockets right for free — supply cannot enter a
 *    Kessel, so a surrounded province keeps its defender's colour until the
 *    defenders die.
 *
 * Anything else keeps its owner. Territory does not flip because a patrol
 * drove through it, which is the whole reason gains feel like they stick.
 *
 * Runs after supply (so the sweep sees this hour's supply) and after combat
 * (so a province emptied by a rout is up for grabs this tick, not next).
 */
export class ProvinceSystem implements System {
  readonly name = 'province';

  update(ctx: TickContext): void {
    const { world } = ctx;
    const map = world.provinces;
    if (!map) return;
    if (world.clock.tick % RECOMPUTE_INTERVAL !== 0) return;

    const presence = this.presenceByProvince(world, map);
    this.applySeizures(map, presence);
    this.applySweep(world, map, presence);
  }

  /** presence[provinceId * A + allianceIndex] = summed military weight. */
  private presenceByProvince(world: World, map: ProvinceMap): Float32Array {
    const a = map.alliances.length;
    const out = new Float32Array(map.count * a);

    for (const d of world.divisions.values()) {
      if (d.stance === 'retreat') continue; // a routed mob holds nothing
      const alliance = world.getFaction(d.faction)?.alliance;
      if (!alliance) continue;
      const ai = map.allianceIndex(alliance);
      if (ai < 0) continue;
      const pid = map.provinceAt(d.position);
      if (pid === NO_PROVINCE) continue;
      out[pid * a + ai]! += this.weight(d);
    }
    return out;
  }

  private weight(d: Division): number {
    return (d.manpower / d.maxManpower) * (0.3 + 0.7 * (d.organisation / d.maxOrganisation));
  }

  private applySeizures(map: ProvinceMap, presence: Float32Array): void {
    const a = map.alliances.length;
    for (let pid = 0; pid < map.count; pid++) {
      let best = -1;
      let bestP = 0;
      let second = 0;
      for (let k = 0; k < a; k++) {
        const p = presence[pid * a + k]!;
        if (p > bestP) {
          second = bestP;
          bestP = p;
          best = k;
        } else if (p > second) {
          second = p;
        }
      }
      if (best >= 0 && bestP > PRESENCE_FLOOR && bestP > second * DOMINANCE_RATIO) {
        map.owner[pid] = best;
      }
    }
  }

  private applySweep(world: World, map: ProvinceMap, presence: Float32Array): void {
    const supply = world.supply;
    if (!supply) return;
    const a = map.alliances.length;

    for (let pid = 0; pid < map.count; pid++) {
      // Only undefended provinces are swept; contested ones are decided above.
      let held = 0;
      for (let k = 0; k < a; k++) held += presence[pid * a + k]!;
      if (held > PRESENCE_FLOOR) continue;

      const province = map.provinces[pid]!;
      const centre = { x: province.cx, y: province.cy };

      let claimant = -1;
      let claimants = 0;
      for (let k = 0; k < a; k++) {
        const alliance = map.alliances[k]!;
        const reaches = supply.supplyAt(alliance, centre) > SUPPLY_FLOOR;
        const touchesOwnGround = province.neighbours.some((nb) => map.owner[nb] === k);
        if (reaches && touchesOwnGround) {
          claimant = k;
          claimants++;
        }
      }
      if (claimants === 1 && map.owner[pid] !== claimant) map.owner[pid] = claimant;
    }
  }
}
