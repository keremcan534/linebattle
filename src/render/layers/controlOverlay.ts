import { Container, Sprite, Texture } from 'pixi.js';
import type { World } from '@core/world/world';

/** Ticks between repaints — matches the supply recompute cadence. */
const REPAINT_INTERVAL_TICKS = 4;

/**
 * The political map: territory tinted by who holds it, HOI4-style.
 *
 * The boundary between the two washes IS the front line — no separate line
 * geometry needed, and it can never disagree with the state it draws, which
 * hand-authored border lines by construction could (and did). Cells on the
 * boundary are painted darker and more opaque, so the front reads as a bold
 * contour while the interiors stay a quiet tint the terrain shows through.
 *
 * One small texture stretched over the theatre, same technique as the supply
 * overlay: a 250×207 image beats fifty thousand rectangles.
 */
export class ControlOverlay {
  readonly container = new Container();

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly sprite: Sprite;
  private texture: Texture | null = null;
  private lastTick = -1;
  /** RGB per alliance index, from each alliance's first declared faction. */
  private readonly colours: [number, number, number][];

  constructor(private readonly world: World) {
    const field = world.supply!;

    this.colours = field.controlAlliances.map((alliance) => {
      for (const faction of world.factions.values()) {
        if (faction.alliance === alliance) {
          return [(faction.color >> 16) & 0xff, (faction.color >> 8) & 0xff, faction.color & 0xff];
        }
      }
      return [128, 128, 128];
    });

    this.canvas = document.createElement('canvas');
    this.canvas.width = field.width;
    this.canvas.height = field.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the control overlay');
    this.ctx = ctx;
    this.image = ctx.createImageData(field.width, field.height);

    this.sprite = new Sprite();
    this.sprite.position.set(field.origin.x, field.origin.y);
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
    const field = this.world.supply;
    if (!field) return;

    const tick = this.world.clock.tick;
    if (tick === this.lastTick) return;
    if (this.lastTick !== -1 && tick % REPAINT_INTERVAL_TICKS !== 0) return;
    this.lastTick = tick;

    const { control, width, height } = field;
    const data = this.image.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const o = i * 4;
        const c = control[i]!;
        if (c === 0) {
          data[o + 3] = 0;
          continue;
        }

        // Frontier test: any 4-neighbour held by a DIFFERENT owner. Edges
        // against neutral or sea stay soft — only contact between sides is a
        // front.
        const up = y > 0 ? control[i - width]! : c;
        const down = y < height - 1 ? control[i + width]! : c;
        const left = x > 0 ? control[i - 1]! : c;
        const right = x < width - 1 ? control[i + 1]! : c;
        const frontier =
          (up !== 0 && up !== c) ||
          (down !== 0 && down !== c) ||
          (left !== 0 && left !== c) ||
          (right !== 0 && right !== c);

        const [r, g, b] = this.colours[c - 1]!;
        if (frontier) {
          data[o] = Math.round(r * 0.62);
          data[o + 1] = Math.round(g * 0.62);
          data[o + 2] = Math.round(b * 0.62);
          data[o + 3] = 215;
        } else {
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = 58;
        }
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    this.sprite.texture = this.texture;
    this.sprite.width = field.width * field.cellSize;
    this.sprite.height = field.height * field.cellSize;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.container.destroy({ children: true });
  }
}
