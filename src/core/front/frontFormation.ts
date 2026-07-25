import type { Division } from '@core/world/division';
import { sectorPosition, sideOf, type FrontState } from './frontSector';

/** First rank sits this far behind its own side of the line, in km. */
export const FRONT_STANDOFF_KM = 26;
/** Each further rank stacks this much deeper into the rear. */
export const RANK_DEPTH_KM = 34;
/** Counters abreast within one sector before a new rank is started. */
export const RANK_CAPACITY = 3;
/** A division in transit is drawn deeper still, on its way to the new sector. */
export const TRANSFER_DEPTH_KM = 78;

/**
 * Derives every counter position from the frontline.
 *
 * Slots are assigned deterministically, so two identical simulations draw
 * identical formations. Because a slot is a fixed side offset, depth offset and
 * lateral stack offset relative to its own side of its own sector, three
 * properties hold by construction rather than by simulation:
 *
 *  - counters never overlap (distinct slots are never the same point),
 *  - counters never cross the line into the enemy's half,
 *  - a sector's formations stay behind that sector's stretch of the front.
 *
 * Positions are presentation derived from simulation state. `prevPosition` is
 * kept so the renderer can interpolate smoothly, but the animation never feeds
 * back into the model.
 */
export function deriveFrontPositions(
  front: FrontState,
  divisions: Iterable<Division>,
  allianceOf: (division: Division) => string | undefined,
): void {
  const bySlot = new Map<string, Division[]>();

  for (const division of divisions) {
    if (division.sector === null) continue;
    const sector = front.sectors[division.sector];
    if (!sector) continue;
    const alliance = allianceOf(division);
    if (!alliance) continue;
    const side = sideOf(front, alliance);
    if (side === 0) continue;

    const key = `${division.sector}|${side}`;
    const list = bySlot.get(key);
    if (list) list.push(division);
    else bySlot.set(key, [division]);
  }

  for (const [key, list] of bySlot) {
    // Deterministic slot order: the same divisions always occupy the same slots,
    // so counters do not shuffle between frames.
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const side = key.endsWith('|1') ? 1 : -1;
    const sector = front.sectors[list[0]!.sector!]!;
    const centre = sectorPosition(sector);
    const lateralStep = sector.widthKm / (RANK_CAPACITY + 1);

    list.forEach((division, i) => {
      const rank = Math.floor(i / RANK_CAPACITY);
      const column = i % RANK_CAPACITY;
      const lateral = (column + 1) * lateralStep - sector.widthKm / 2;
      const depth =
        division.deployment === 'transferring'
          ? TRANSFER_DEPTH_KM
          : FRONT_STANDOFF_KM + rank * RANK_DEPTH_KM;

      division.prevPosition = { ...division.position };
      division.position = {
        x: centre.x + sector.tangent.x * lateral + sector.normal.x * side * depth,
        y: centre.y + sector.tangent.y * lateral + sector.normal.y * side * depth,
      };
      // Face the enemy: heading is derived too, so arrows and symbols agree.
      division.heading = Math.atan2(-sector.normal.y * side, -sector.normal.x * side);
    });
  }
}
