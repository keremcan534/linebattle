import { Container, Sprite, Texture } from 'pixi.js';
import type { World } from '@core/world/world';

/**
 * Supply as a map mode.
 *
 * Supply is the most consequential system in the game and the only one with
 * no natural visual: a division that is about to starve looks exactly like
 * one that is not. Without this overlay the player discovers a broken
 * logistics situation only when formations start dissolving, which reads as
 * the game cheating.
 *
 * Drawn as a single texture rather than tens of thousands of rectangles. The
 * supply field is already a coarse grid, so it maps one-to-one onto pixels of
 * a small image that the GPU stretches over the theatre — one draw call, and
 * the cost of an update is a typed-array copy rather than a scene-graph
 * rebuild.
 */
export class SupplyOverlay {
  readonly container = new Container();

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly sprite: Sprite;
  private texture: Texture | null = null;
  private alliance = '';
  private lastTick = -1;

  constructor(private readonly world: World) {
    const field = world.supply!;
    this.canvas = document.createElement('canvas');
    this.canvas.width = field.width;
    this.canvas.height = field.height;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for the supply overlay');
    this.ctx = ctx;
    this.image = ctx.createImageData(field.width, field.height);

    this.sprite = new Sprite();
    this.sprite.position.set(field.origin.x, field.origin.y);
    this.sprite.width = field.width * field.cellSize;
    this.sprite.height = field.height * field.cellSize;
    this.sprite.alpha = 0.5;
    this.container.addChild(this.sprite);
    this.container.visible = false;
  }

  setAlliance(alliance: string): void {
    if (this.alliance === alliance) return;
    this.alliance = alliance;
    this.lastTick = -1;
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
    if (!field || !this.alliance) return;

    // The field itself only recomputes once a game-hour; repainting more
    // often would be pure waste.
    if (this.world.clock.tick === this.lastTick) return;
    this.lastTick = this.world.clock.tick;

    const supply = field.fieldFor(this.alliance);
    const data = this.image.data;

    for (let i = 0; i < supply.length; i++) {
      const value = supply[i]!;
      const o = i * 4;
      if (value <= 0.001) {
        // Unsupplied ground is left clear rather than painted black: the
        // interesting thing is where supply IS, and a black theatre would
        // hide the map underneath it.
        data[o + 3] = 0;
        continue;
      }
      // Red through amber to green: "about to starve" to "fully supplied".
      const t = Math.min(1, value);
      data[o] = Math.round(230 - 150 * t);
      data[o + 1] = Math.round(70 + 140 * t);
      data[o + 2] = Math.round(60 + 50 * t);
      data[o + 3] = Math.round(70 + 110 * t);
    }

    this.ctx.putImageData(this.image, 0, 0);
    this.texture?.destroy(true);
    this.texture = Texture.from(this.canvas);
    // Nearest-neighbour would show the 16 km grid as hard squares and imply a
    // precision the model does not have; smoothing reads as a gradient.
    this.sprite.texture = this.texture;
    this.sprite.width = field.width * field.cellSize;
    this.sprite.height = field.height * field.cellSize;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.container.destroy({ children: true });
  }
}
