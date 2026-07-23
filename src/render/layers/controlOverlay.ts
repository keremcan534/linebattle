import { Container, Sprite, Texture } from 'pixi.js';
import { ticksForHours } from '@core/time/gameClock';
import type { World } from '@core/world/world';

/** The control field changes once per strategic tick. */
const REPAINT_INTERVAL_TICKS = ticksForHours(1);

/**
 * Liquid territorial control and its frontline.
 *
 * The boundary between two coloured washes is the line: no province polygons,
 * capture animation or second geometry can disagree with the physical state.
 * Interior cells stay translucent so terrain remains readable; cells touching
 * a hostile owner become the dark, continuous frontline contour.
 */
export class ControlOverlay {
  readonly container = new Container();

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly sprite: Sprite;
  private texture: Texture | null = null;
  private lastTick = -1;
  private readonly colours: [number, number, number][];

  constructor(private readonly world: World) {
    const field = world.supply!;

    this.colours = field.controlAlliances.map((alliance) => {
      for (const faction of world.factions.values()) {
        if (faction.alliance === alliance) {
          return [
            (faction.color >> 16) & 0xff,
            (faction.color >> 8) & 0xff,
            faction.color & 0xff,
          ];
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
        const offset = i * 4;
        const owner = control[i]!;

        if (owner === 0) {
          data[offset + 3] = 0;
          continue;
        }

        const up = y > 0 ? control[i - width]! : owner;
        const down = y < height - 1 ? control[i + width]! : owner;
        const left = x > 0 ? control[i - 1]! : owner;
        const right = x < width - 1 ? control[i + 1]! : owner;
        const frontline =
          (up !== 0 && up !== owner) ||
          (down !== 0 && down !== owner) ||
          (left !== 0 && left !== owner) ||
          (right !== 0 && right !== owner);

        const [r, g, b] = this.colours[owner - 1]!;
        if (frontline) {
          data[offset] = Math.round(r * 0.62);
          data[offset + 1] = Math.round(g * 0.62);
          data[offset + 2] = Math.round(b * 0.62);
          data[offset + 3] = 215;
        } else {
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = 58;
        }
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    this.sprite.texture = this.texture;
    this.sprite.width = width * field.cellSize;
    this.sprite.height = height * field.cellSize;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.container.destroy({ children: true });
  }
}
