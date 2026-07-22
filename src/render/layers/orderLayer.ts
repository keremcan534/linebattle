import { Container, Graphics } from 'pixi.js';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { theme } from '../theme';

/**
 * Movement orders and the drag-selection rectangle.
 *
 * Redrawn every frame into a single Graphics: only selected units show their
 * route, so this is a handful of polylines and cheaper to rebuild than to
 * diff. Kept apart from UnitLayer because it is transient *intent*, not state.
 */
export class OrderLayer {
  readonly container = new Container();
  private readonly gfx = new Graphics();
  private readonly boxGfx = new Graphics();

  constructor(private readonly world: World) {
    this.container.addChild(this.gfx, this.boxGfx);
  }

  update(
    zoom: number,
    selected: ReadonlySet<DivisionId>,
    dragBox: { x0: number; y0: number; x1: number; y1: number } | null,
  ): void {
    const g = this.gfx;
    g.clear();

    const px = 1 / zoom;
    let drew = false;

    for (const id of selected) {
      const d = this.world.getDivision(id);
      if (!d?.order || d.order.kind !== 'move') continue;

      g.moveTo(d.position.x, d.position.y);
      for (let i = d.order.cursor; i < d.order.waypoints.length; i++) {
        const wp = d.order.waypoints[i]!;
        g.lineTo(wp.x, wp.y);
      }
      drew = true;
    }
    if (drew) {
      g.stroke({ width: theme.order.widthPx * px, color: theme.order.line, alpha: theme.order.lineAlpha });
    }

    for (const id of selected) {
      const d = this.world.getDivision(id);
      if (!d?.order || d.order.kind !== 'move') continue;
      for (let i = d.order.cursor; i < d.order.waypoints.length; i++) {
        const wp = d.order.waypoints[i]!;
        g.circle(wp.x, wp.y, theme.order.waypointRadiusPx * px);
      }
    }
    g.fill({ color: theme.order.line, alpha: 0.9 });

    this.drawDragBox(px, dragBox);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private drawDragBox(px: number, box: { x0: number; y0: number; x1: number; y1: number } | null): void {
    this.boxGfx.clear();
    if (!box) return;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    this.boxGfx
      .rect(x, y, w, h)
      .fill({ color: theme.selectionBox.fill, alpha: theme.selectionBox.fillAlpha })
      .stroke({ width: 1.2 * px, color: theme.selectionBox.stroke, alpha: 0.9 });
  }
}
