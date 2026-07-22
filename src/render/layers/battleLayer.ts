import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Battle } from '@core/world/battle';
import type { BattleId } from '@core/world/ids';
import type { World } from '@core/world/world';
import { theme } from '../theme';

interface BubbleView {
  node: Container;
  dial: Graphics;
  label: Text;
  lastProgress: number;
}

/**
 * The combat bubble — a dial at each engagement showing who is winning.
 *
 * This is the one piece of UI the whole project is aimed at: the map
 * animations this game imitates are readable precisely because a fight is a
 * mark on the map with a direction to it, not a table of numbers. The arc
 * fills from the centre towards whichever side is ahead, so a player scanning
 * a 2000 km front can see where they are losing without clicking anything.
 *
 * Views are pooled by battle id and mutated in place, and the whole node is
 * counter-scaled so the bubble stays legible at every zoom.
 */
export class BattleLayer {
  readonly container = new Container();
  private readonly views = new Map<BattleId, BubbleView>();
  private readonly labelStyle: TextStyle;
  /** Drives the pulse, so a live battle reads as live. */
  private phase = 0;

  constructor(private readonly world: World) {
    this.labelStyle = new TextStyle({
      fontFamily: 'Consolas, "SF Mono", monospace',
      fontSize: 9,
      fill: 0xf0e6cc,
      stroke: { color: 0x0a0e14, width: 3 },
    });
  }

  update(zoom: number, deltaMS: number): void {
    this.phase = (this.phase + deltaMS / 900) % (Math.PI * 2);
    const inverse = 1 / zoom;
    const pulse = 1 + Math.sin(this.phase) * 0.06;

    for (const battle of this.world.battles.values()) {
      const view = this.views.get(battle.id) ?? this.createView(battle);

      view.node.position.set(battle.position.x, battle.position.y);
      view.node.scale.set(inverse * pulse);

      if (Math.abs(battle.progress - view.lastProgress) > 0.004) {
        view.lastProgress = battle.progress;
        this.drawDial(view, battle);
      }
      view.label.text = this.strengthLabel(battle);
      view.label.visible = zoom > 0.1;
    }

    for (const [id, view] of this.views) {
      if (!this.world.battles.has(id)) {
        view.node.destroy({ children: true });
        this.views.delete(id);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.views.clear();
  }

  // --------------------------------------------------------------- private --

  private createView(battle: Battle): BubbleView {
    const node = new Container();
    const dial = new Graphics();

    const label = new Text({ text: '', style: this.labelStyle });
    label.anchor.set(0.5, 0);
    label.position.set(0, theme.battle.radiusPx + 4);
    label.resolution = 2;

    node.addChild(dial, label);
    this.container.addChild(node);

    const view: BubbleView = { node, dial, label, lastProgress: -1 };
    this.drawDial(view, battle);
    this.views.set(battle.id, view);
    return view;
  }

  private drawDial(view: BubbleView, battle: Battle): void {
    const r = theme.battle.radiusPx;
    const g = view.dial;
    g.clear();

    g.circle(0, 0, r).fill({ color: 0x0a0e14, alpha: 0.72 });

    // The arc is the story: it runs from 12 o'clock towards whoever is ahead.
    const colourA = this.allianceColour(battle.sides[0].alliance);
    const colourB = this.allianceColour(battle.sides[1].alliance);
    const split = -Math.PI / 2 + (battle.progress - 0.5) * Math.PI * 2;

    g.moveTo(0, 0).arc(0, 0, r - 2, split, -Math.PI / 2 + Math.PI, false).fill({ color: colourB, alpha: 0.75 });
    g.moveTo(0, 0).arc(0, 0, r - 2, -Math.PI / 2 - Math.PI, split, false).fill({ color: colourA, alpha: 0.75 });

    g.circle(0, 0, r).stroke({ width: 1.6, color: theme.battle.rim, alpha: 0.95 });

    // Crossed sabres, so the mark reads as combat and not as a pie chart.
    const s = r * 0.5;
    g.moveTo(-s, -s).lineTo(s, s).moveTo(-s, s).lineTo(s, -s)
      .stroke({ width: 2.2, color: theme.battle.blades, alpha: 0.95 });
  }

  private allianceColour(alliance: string): number {
    for (const faction of this.world.factions.values()) {
      if (faction.alliance === alliance) return faction.color;
    }
    return 0x888888;
  }

  private strengthLabel(battle: Battle): string {
    const a = Math.round(battle.sides[0].power);
    const b = Math.round(battle.sides[1].power);
    return `${a} : ${b}`;
  }
}
