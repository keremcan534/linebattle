import type { Container } from 'pixi.js';
import { clamp, type Vec2 } from '@core/math/vec2';
import type { WorldBounds } from '@core/world/world';
import { ZOOM_MAX, ZOOM_MIN } from './theme';

/**
 * The only place that knows how world kilometres become screen pixels.
 *
 * All map layers draw their geometry ONCE, in world coordinates. The camera
 * then moves and scales a single root container. That means panning and
 * zooming cost one transform update per frame instead of re-tessellating
 * hundreds of coastline polygons — the difference between 60fps and 5fps at
 * theatre scale.
 */
export class Camera {
  /** World position at the centre of the viewport, in km. */
  center: Vec2 = { x: 0, y: 0 };
  /** Screen pixels per world kilometre. */
  zoom = 0.1;

  viewportWidth = 1;
  viewportHeight = 1;

  constructor(private readonly bounds: WorldBounds) {}

  /** Frames the entire theatre, with a little margin. */
  fitToBounds(padding = 0.94): void {
    const w = this.bounds.maxX - this.bounds.minX;
    const h = this.bounds.maxY - this.bounds.minY;
    this.zoom = Math.min(this.viewportWidth / w, this.viewportHeight / h) * padding;
    this.center = { x: (this.bounds.minX + this.bounds.maxX) / 2, y: (this.bounds.minY + this.bounds.maxY) / 2 };
    this.clampToBounds();
  }

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.center.x) * this.zoom + this.viewportWidth / 2,
      y: (p.y - this.center.y) * this.zoom + this.viewportHeight / 2,
    };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.viewportWidth / 2) / this.zoom + this.center.x,
      y: (sy - this.viewportHeight / 2) / this.zoom + this.center.y,
    };
  }

  panByScreen(dxPx: number, dyPx: number): void {
    this.center.x -= dxPx / this.zoom;
    this.center.y -= dyPx / this.zoom;
    this.clampToBounds();
  }

  /**
   * Zooms about a fixed screen point, so the world position under the cursor
   * stays under the cursor. Anything else feels broken to the hand.
   */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = clamp(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    const after = this.screenToWorld(screenX, screenY);
    this.center.x += before.x - after.x;
    this.center.y += before.y - after.y;
    this.clampToBounds();
  }

  centerOn(p: Vec2): void {
    this.center = { x: p.x, y: p.y };
    this.clampToBounds();
  }

  /**
   * Keeps the theatre on screen. When the viewport is wider than the world
   * (fully zoomed out) the axis is centred instead of clamped, otherwise the
   * map snaps to a corner and looks broken.
   */
  clampToBounds(): void {
    const halfW = this.viewportWidth / 2 / this.zoom;
    const halfH = this.viewportHeight / 2 / this.zoom;
    const { minX, minY, maxX, maxY } = this.bounds;

    this.center.x =
      maxX - minX <= halfW * 2 ? (minX + maxX) / 2 : clamp(this.center.x, minX + halfW, maxX - halfW);
    this.center.y =
      maxY - minY <= halfH * 2 ? (minY + maxY) / 2 : clamp(this.center.y, minY + halfH, maxY - halfH);
  }

  /** Pushes the current transform onto the world root container. */
  applyTo(root: Container): void {
    root.scale.set(this.zoom);
    root.position.set(
      this.viewportWidth / 2 - this.center.x * this.zoom,
      this.viewportHeight / 2 - this.center.y * this.zoom,
    );
  }

  /** Visible world rectangle, for culling. */
  visibleWorldRect(marginPx = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = (this.viewportWidth / 2 + marginPx) / this.zoom;
    const halfH = (this.viewportHeight / 2 + marginPx) / this.zoom;
    return {
      minX: this.center.x - halfW,
      minY: this.center.y - halfH,
      maxX: this.center.x + halfW,
      maxY: this.center.y + halfH,
    };
  }
}
