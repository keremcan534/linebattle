import { Container, Sprite, Texture } from 'pixi.js';
import { NEUTRAL, NO_PROVINCE } from '@core/province/province';
import type { World } from '@core/world/world';

/** Repaint cadence — ownership changes at most once a game-hour. */
const REPAINT_INTERVAL_TICKS = 4;

/**
 * The political map, HOI4-style: territory tinted by who owns it, drawn from
 * the province mesh.
 *
 * This is what the user asked for and what the fuzzy cell-control wash could
 * only gesture at. Because every cell belongs to exactly one province and every
 * province to exactly one owner, three things fall out for free:
 *
 *  - **The front line is the boundary between owners** — a hard edge, drawn
 *    bold and opaque. No separate line geometry, and it can never disagree
 *    with the game state, which hand-drawn borders by construction could.
 *  - **The province mosaic** — faint internal borders between provinces of the
 *    same owner give the familiar HOI4 texture.
 *  - **It cannot smear**, because ownership is discrete.
 *
 * Rasterised to one texture at terrain resolution and stretched over the
 * theatre — a single draw call. The per-cell owner lookup is a chain of typed
 * arrays (cell → province → owner → colour), so a repaint is a tight loop with
 * no allocation.
 */
export class ProvinceLayer {
  readonly container = new Container();

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly sprite: Sprite;
  private texture: Texture | null = null;
  private lastTick = -1;
  private readonly colours: [number, number, number][];

  constructor(private readonly world: World) {
    const map = world.provinces!;
    const terrain = world.terrain;

    this.colours = map.alliances.map((alliance) => {
      for (const faction of world.factions.values()) {
        if (faction.alliance === alliance) {
          return [(faction.color >> 16) & 0xff, (faction.color >> 8) & 0xff, faction.color & 0xff];
        }
      }
      return [140, 140, 140];
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = terrain.width;
    this.canvas.height = terrain.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the province layer');
    this.ctx = ctx;
    this.image = ctx.createImageData(terrain.width, terrain.height);

    this.sprite = new Sprite();
    this.sprite.position.set(terrain.origin.x, terrain.origin.y);
    this.sprite.width = terrain.width * terrain.cellSize;
    this.sprite.height = terrain.height * terrain.cellSize;
    this.sprite.alpha = 0.82;
    this.container.addChild(this.sprite);
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible;
    if (visible) this.lastTick = -1;
  }

  get visible(): boolean {
    return this.container.visible;
  }

  update(): void {
    if (!this.container.visible) return;
    const map = this.world.provinces;
    if (!map) return;

    const tick = this.world.clock.tick;
    if (tick === this.lastTick) return;
    if (this.lastTick !== -1 && tick % REPAINT_INTERVAL_TICKS !== 0) return;
    this.lastTick = tick;

    const { width, height } = this.world.terrain;
    const cellProvince = map.cellProvince;
    const owner = map.owner;
    const data = this.image.data;

    const ownerOf = (i: number): number => {
      const pid = cellProvince[i]!;
      return pid === NO_PROVINCE ? -2 : owner[pid]!; // -2 = sea, -1 = neutral
    };

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const pid = cellProvince[i]!;
        const o = i * 4;

        if (pid === NO_PROVINCE) {
          data[o + 3] = 0;
          continue;
        }

        const own = owner[pid]!;
        // Classify the cell against its four neighbours.
        let ownerEdge = false; // borders a DIFFERENT owner → front line
        let provinceEdge = false; // borders a different province, same owner
        for (const j of [
          x > 0 ? i - 1 : -1,
          x < width - 1 ? i + 1 : -1,
          y > 0 ? i - width : -1,
          y < height - 1 ? i + width : -1,
        ]) {
          if (j < 0) continue;
          const np = cellProvince[j]!;
          if (np === pid) continue;
          if (np === NO_PROVINCE) continue; // coast stays soft
          if (ownerOf(j) !== own) ownerEdge = true;
          else provinceEdge = true;
        }

        const [r, g, b] = own === NEUTRAL ? NEUTRAL_RGB : this.colours[own]!;

        if (ownerEdge) {
          // Front line: bold, darkened, near-opaque.
          data[o] = (r * 0.55) | 0;
          data[o + 1] = (g * 0.55) | 0;
          data[o + 2] = (b * 0.55) | 0;
          data[o + 3] = own === NEUTRAL ? 120 : 235;
        } else if (provinceEdge) {
          // Internal province seam: faint mosaic line.
          data[o] = (r * 0.72) | 0;
          data[o + 1] = (g * 0.72) | 0;
          data[o + 2] = (b * 0.72) | 0;
          data[o + 3] = own === NEUTRAL ? 34 : 120;
        } else {
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = own === NEUTRAL ? 22 : 78;
        }
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    this.sprite.texture = this.texture;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.container.destroy({ children: true });
  }
}

// A warm, desaturated tan so neutral ground reads as clearly unaligned rather
// than being mistaken for either the blue-grey Axis or the brick-red Allies.
const NEUTRAL_RGB: [number, number, number] = [126, 118, 96];
