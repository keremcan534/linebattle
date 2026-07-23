import { Container, Graphics } from 'pixi.js';
import type { World } from '@core/world/world';
import { theme } from '../theme';

/** Persistent operational intent markers, rendered at a fixed screen size. */
export class ObjectiveLayer {
  readonly container = new Container();
  private readonly gfx = new Graphics();

  constructor(private readonly world: World) {
    this.container.addChild(this.gfx);
  }

  update(zoom: number): void {
    const g = this.gfx;
    g.clear();
    const px = 1 / zoom;
    const radius = theme.objective.radiusPx * px;

    for (const objective of this.world.strategicObjectives.values()) {
      const { x, y } = objective.position;
      const color =
        objective.kind === 'attack'
          ? theme.objective.attack
          : theme.objective.defense;

      if (objective.kind === 'attack') {
        g.circle(x, y, radius)
          .moveTo(x - radius * 0.65, y - radius * 0.65)
          .lineTo(x + radius * 0.65, y + radius * 0.65)
          .moveTo(x + radius * 0.65, y - radius * 0.65)
          .lineTo(x - radius * 0.65, y + radius * 0.65);
      } else {
        g.rect(x - radius * 0.72, y - radius * 0.72, radius * 1.44, radius * 1.44)
          .circle(x, y, radius * 0.35);
      }
      g.stroke({
        width: theme.objective.widthPx * px,
        color,
        alpha: 0.95,
      });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
