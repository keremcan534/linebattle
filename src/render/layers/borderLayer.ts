import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { BorderProperties, FeatureCollection, Position } from '@core/geo/geojson';
import type { Projection } from '@core/geo/projection';
import { theme } from '../theme';

/**
 * Political boundaries as of 22 June 1941, plus country names.
 *
 * Deliberately NOT provinces. These lines are drawn and labelled; they carry no
 * gameplay meaning and nothing in `core/` knows they exist. Movement stays
 * continuous and a division crossing the Bug notices only the river. When
 * territory ownership starts to matter — supply sources, victory conditions —
 * that will be polygon data in the scenario, and it will still not constrain
 * movement.
 *
 * Kept apart from MapLayer because borders are political and mutable (they
 * move as the war does) while coastlines are geographic and fixed.
 */
export class BorderLayer {
  readonly container = new Container();

  private readonly lineGfx = new Graphics();
  private readonly labelContainer = new Container();
  private readonly labels: { node: Text; rank: number }[] = [];
  private readonly borders: { points: Position[]; rank: number }[] = [];
  private strokeZoom = 0;

  constructor(
    data: FeatureCollection<BorderProperties>,
    private readonly projection: Projection,
  ) {
    this.container.addChild(this.lineGfx, this.labelContainer);

    for (const f of data.features) {
      const rank = f.properties.rank ?? 3;
      if (f.properties.kind === 'label' && f.geometry.type === 'Point') {
        this.addLabel(f.properties.name ?? '', f.geometry.coordinates, rank);
      } else if (f.geometry.type === 'LineString') {
        this.borders.push({ points: f.geometry.coordinates, rank });
      } else if (f.geometry.type === 'MultiLineString') {
        for (const line of f.geometry.coordinates) this.borders.push({ points: line, rank });
      }
    }
  }

  update(zoom: number): void {
    // Same hysteresis as the map: the dash pattern is authored in screen
    // pixels, so it has to be rebuilt in world units when the scale changes,
    // but nowhere near every frame.
    if (Math.abs(Math.log(zoom / this.strokeZoom)) > 0.12) {
      this.strokeZoom = zoom;
      this.draw(zoom);
    }
    this.updateLabelLOD(zoom);
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible;
  }

  get visible(): boolean {
    return this.container.visible;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  // --------------------------------------------------------------- drawing --

  private draw(zoom: number): void {
    const g = this.lineGfx;
    g.clear();
    const px = 1 / zoom;

    for (const rank of [3, 2, 1] as const) {
      const group = this.borders.filter((b) => b.rank === rank);
      if (!group.length) continue;
      // Minor boundaries would be visual noise at theatre scale.
      if (rank === 3 && zoom < 0.09) continue;
      if (rank === 2 && zoom < 0.05) continue;

      // A soft dark casing under the dashes keeps the line legible over both
      // pale plains and dark forest without shouting.
      for (const pass of ['casing', 'dash'] as const) {
        for (const border of group) {
          this.dashedPath(
            g,
            border.points,
            (pass === 'casing' ? 22 : 11) * px,
            (pass === 'casing' ? 0 : 7) * px,
          );
        }
        g.stroke(
          pass === 'casing'
            ? { width: (rank === 1 ? 4.2 : 3.2) * px, color: theme.border.casing, alpha: 0.5 }
            : {
                width: (rank === 1 ? 1.9 : 1.3) * px,
                color: rank === 1 ? theme.border.major : theme.border.minor,
                alpha: rank === 1 ? 0.95 : 0.7,
              },
        );
      }
    }
  }

  /**
   * Emits a dashed polyline. PixiJS has no dash support, and a border that is
   * a solid line reads as a river or a road — the dash is what makes it read
   * as political.
   *
   * `gap` of 0 produces a continuous line, used for the casing pass.
   */
  private dashedPath(g: Graphics, points: Position[], dash: number, gap: number): void {
    if (points.length < 2) return;

    if (gap <= 0) {
      const start = this.projection.project(points[0]![0], points[0]![1]);
      g.moveTo(start.x, start.y);
      for (let i = 1; i < points.length; i++) {
        const p = this.projection.project(points[i]![0], points[i]![1]);
        g.lineTo(p.x, p.y);
      }
      return;
    }

    const period = dash + gap;
    let carried = 0; // distance already consumed of the current dash/gap cycle
    let drawing = true;

    for (let i = 1; i < points.length; i++) {
      const a = this.projection.project(points[i - 1]![0], points[i - 1]![1]);
      const b = this.projection.project(points[i]![0], points[i]![1]);
      const segLength = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLength < 1e-6) continue;

      const dx = (b.x - a.x) / segLength;
      const dy = (b.y - a.y) / segLength;
      let travelled = 0;

      while (travelled < segLength) {
        const target = drawing ? dash - carried : gap - carried;
        const step = Math.min(target, segLength - travelled);

        if (drawing) {
          g.moveTo(a.x + dx * travelled, a.y + dy * travelled);
          g.lineTo(a.x + dx * (travelled + step), a.y + dy * (travelled + step));
        }

        travelled += step;
        carried += step;

        if (carried >= target - 1e-9) {
          drawing = !drawing;
          carried = 0;
        }
      }
      // Keep the phase continuous across vertices, so corners do not reset.
      carried %= period;
    }
  }

  // ---------------------------------------------------------------- labels --

  private addLabel(name: string, coordinates: Position, rank: number): void {
    const world = this.projection.project(coordinates[0], coordinates[1]);
    const style = new TextStyle({
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: rank === 1 ? 15 : rank === 2 ? 12 : 10,
      fontWeight: rank === 1 ? '600' : '400',
      // Wide tracking is what makes a name read as *territory* rather than as
      // a place — the convention every printed staff map uses.
      letterSpacing: rank === 1 ? 6 : 3,
      fill: theme.border.label,
      stroke: { color: 0x0a0e14, width: 4 },
    });

    const node = new Text({ text: name, style });
    node.anchor.set(0.5);
    node.position.set(world.x, world.y);
    node.alpha = rank === 1 ? 0.72 : 0.55;
    node.resolution = 2;

    this.labelContainer.addChild(node);
    this.labels.push({ node, rank });
  }

  private updateLabelLOD(zoom: number): void {
    // Country names are orientation, not detail: they matter most when zoomed
    // out and get in the way once the player is reading counters.
    const inverse = 1 / zoom;
    for (const { node, rank } of this.labels) {
      const visible = zoom < 0.55 && (rank === 1 || zoom > 0.045 * rank);
      node.visible = visible;
      if (visible) node.scale.set(inverse);
    }
  }
}
