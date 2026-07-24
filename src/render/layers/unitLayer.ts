import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { lerp } from '@core/math/vec2';
import { organisationRatio, strengthRatio, type Division } from '@core/world/division';
import type { DivisionId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { FORMED_ENEMY_MIN_SEPARATION_KM } from '@core/systems/movementSystem';
import { drawEchelon, drawUnitCounter } from '../symbols/natoSymbol';
import { theme } from '../theme';

interface UnitView {
  node: Container;
  counter: Graphics;
  bars: Graphics;
  selection: Graphics;
  /** World-scale zone-of-control ring, shown only while the unit is selected. */
  zoc: Graphics;
  label: Text;
  /** Cached so we only redraw the bars when the numbers actually move. */
  lastStrength: number;
  lastOrg: number;
  lastSelected: boolean;
  lastHovered: boolean;
}

/**
 * Draws one counter per division.
 *
 * Views are pooled by division id and mutated in place — creating Pixi objects
 * every frame is the classic way to make a strategy game stutter. The layer is
 * strictly a projection of world state: it never writes back, which is why
 * selection is passed in from the view store rather than stored on the unit.
 */
export class UnitLayer {
  readonly container = new Container();
  /** Sits behind the counters so ZOC rings never obscure the symbols. */
  private readonly zocLayer = new Container();
  private readonly views = new Map<DivisionId, UnitView>();
  private readonly labelStyle: TextStyle;

  constructor(private readonly world: World) {
    this.container.addChild(this.zocLayer);
    this.labelStyle = new TextStyle({
      fontFamily: 'Consolas, "SF Mono", monospace',
      fontSize: 10,
      fill: 0xe8e2d0,
      stroke: { color: 0x0a0e14, width: 3 },
    });
  }

  /**
   * @param alpha  interpolation factor between the previous and current tick,
   *               so units glide smoothly at 60fps even though the simulation
   *               only steps four times a game-hour.
   */
  update(zoom: number, alpha: number, selected: ReadonlySet<DivisionId>, hovered: DivisionId | null): void {
    const inverse = 1 / zoom;
    const showLabels = zoom > 0.12;

    for (const division of this.world.divisions.values()) {
      const view = this.views.get(division.id) ?? this.createView(division);
      const p = lerp(division.prevPosition, division.position, alpha);

      view.node.position.set(p.x, p.y);
      view.node.scale.set(inverse);
      view.zoc.position.set(p.x, p.y);
      view.label.visible = showLabels;

      const isSelected = selected.has(division.id);
      const isHovered = hovered === division.id;
      if (isSelected !== view.lastSelected || isHovered !== view.lastHovered) {
        view.lastSelected = isSelected;
        view.lastHovered = isHovered;
        view.zoc.visible = isSelected;
        this.drawSelection(view, isSelected, isHovered);
      }

      const strength = strengthRatio(division);
      const org = organisationRatio(division);
      if (Math.abs(strength - view.lastStrength) > 0.005 || Math.abs(org - view.lastOrg) > 0.005) {
        view.lastStrength = strength;
        view.lastOrg = org;
        this.drawBars(view, strength, org);
      }
    }

    // Divisions destroyed by the simulation lose their view here.
    for (const [id, view] of this.views) {
      if (!this.world.divisions.has(id)) {
        view.node.destroy({ children: true });
        view.zoc.destroy();
        this.views.delete(id);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.views.clear();
  }

  // --------------------------------------------------------------- private --

  private createView(division: Division): UnitView {
    const faction = this.world.getFaction(division.faction);
    const fill = faction?.color ?? 0x888888;
    const ink = faction?.accentColor ?? 0xffffff;

    const node = new Container();

    // World-scale so it grows with the map: the ring is the real separation an
    // enemy formation cannot cross, in kilometres, not a fixed screen circle.
    const zoc = new Graphics();
    zoc
      .circle(0, 0, FORMED_ENEMY_MIN_SEPARATION_KM)
      .fill({ color: theme.unit.selectedOutline, alpha: 0.07 })
      .stroke({ width: 0.5, color: theme.unit.selectedOutline, alpha: 0.55 });
    zoc.visible = false;
    this.zocLayer.addChild(zoc);

    const selection = new Graphics();
    const counter = new Graphics();
    drawUnitCounter(counter, division.branch, theme.unit.widthPx, theme.unit.heightPx, fill, ink);
    drawEchelon(counter, theme.unit.heightPx, ink);

    const bars = new Graphics();

    const label = new Text({ text: division.shortName, style: this.labelStyle });
    label.anchor.set(0.5, 0);
    label.position.set(0, theme.unit.heightPx / 2 + 6);
    label.resolution = 2;

    node.addChild(selection, counter, bars, label);
    this.container.addChild(node);

    const view: UnitView = {
      node,
      counter,
      bars,
      selection,
      zoc,
      label,
      lastStrength: -1,
      lastOrg: -1,
      lastSelected: false,
      lastHovered: false,
    };
    this.drawBars(view, strengthRatio(division), organisationRatio(division));
    this.views.set(division.id, view);
    return view;
  }

  private drawBars(view: UnitView, strength: number, org: number): void {
    const w = theme.unit.widthPx;
    const h = theme.unit.heightPx;
    const barW = w;
    const barH = 2.5;
    const y = h / 2 + 1;

    view.bars.clear();
    view.bars.rect(-barW / 2, y, barW, barH * 2 + 1).fill({ color: theme.unit.strengthBarBg, alpha: 0.55 });
    view.bars.rect(-barW / 2, y, barW * strength, barH).fill(theme.unit.strengthBar);
    view.bars.rect(-barW / 2, y + barH + 1, barW * org, barH).fill(theme.unit.orgBar);
  }

  private drawSelection(view: UnitView, selected: boolean, hovered: boolean): void {
    view.selection.clear();
    if (!selected && !hovered) return;
    const w = theme.unit.widthPx + 8;
    const h = theme.unit.heightPx + 8;
    view.selection
      .rect(-w / 2, -h / 2, w, h)
      .stroke({
        width: selected ? 2 : 1.25,
        color: selected ? theme.unit.selectedOutline : theme.unit.hoverOutline,
        alpha: selected ? 1 : 0.6,
      });
  }
}
