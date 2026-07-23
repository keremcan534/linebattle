import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Geometry, Position } from '@core/geo/geojson';
import type { Projection } from '@core/geo/projection';
import type { MapData } from '@core/scenario/scenarioLoader';
import type { WorldBounds } from '@core/world/world';
import { theme } from '../theme';

/**
 * Static map geometry: sea, coastlines, lakes, rivers, cities.
 *
 * Built once in world coordinates and then left alone — the camera moves the
 * container rather than this layer redrawing. The single exception is stroke
 * width: a line authored in world km would be sub-pixel when zoomed out and
 * fat when zoomed in, so strokes are re-issued when the zoom crosses a band
 * threshold. That is a redraw every few seconds of player input, not per frame.
 */
export class MapLayer {
  readonly container = new Container();

  private readonly seaGfx = new Graphics();
  private readonly landGfx = new Graphics();
  private readonly lakeGfx = new Graphics();
  private readonly riverGfx = new Graphics();
  private readonly cityContainer = new Container();
  private readonly cityEntries: { node: Container; scalerank: number }[] = [];

  /** Zoom the strokes were last generated for. */
  private strokeZoom = 0;

  constructor(
    private readonly data: MapData,
    private readonly projection: Projection,
    private readonly bounds: WorldBounds,
  ) {
    this.container.addChild(this.seaGfx, this.landGfx, this.lakeGfx, this.riverGfx, this.cityContainer);
    this.drawSea();
    this.buildCities();
  }

  /** Called by the renderer whenever the camera zoom has changed materially. */
  update(zoom: number): void {
    // 12% hysteresis: enough that continuous wheel zooming redraws a handful
    // of times across the full range rather than every frame.
    if (Math.abs(Math.log(zoom / this.strokeZoom)) > 0.12) {
      this.strokeZoom = zoom;
      this.drawLand(zoom);
      this.drawLakes(zoom);
      this.drawRivers(zoom);
    }
    this.updateCityLOD(zoom);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  // ------------------------------------------------------------- geometry --

  private drawSea(): void {
    const { minX, minY, maxX, maxY } = this.bounds;
    this.seaGfx.clear();
    const first = this.bounds.boundary?.[0];
    if (first) {
      this.seaGfx.moveTo(first.x, first.y);
      for (let i = 1; i < this.bounds.boundary!.length; i++) {
        const p = this.bounds.boundary![i]!;
        this.seaGfx.lineTo(p.x, p.y);
      }
      this.seaGfx.closePath().fill(theme.map.sea);
    } else {
      this.seaGfx.rect(minX, minY, maxX - minX, maxY - minY).fill(theme.map.sea);
    }
  }

  private drawLand(zoom: number): void {
    const g = this.landGfx;
    g.clear();
    for (const f of this.data.land.features) this.tracePolygon(g, f.geometry);
    g.fill({ color: theme.map.land });
    g.stroke({ width: theme.map.coastWidthPx / zoom, color: theme.map.landOutline, alpha: 0.9 });
  }

  private drawLakes(zoom: number): void {
    const g = this.lakeGfx;
    g.clear();
    if (!this.data.lakes) return;
    for (const f of this.data.lakes.features) this.tracePolygon(g, f.geometry);
    g.fill({ color: theme.map.lake });
    g.stroke({ width: (theme.map.coastWidthPx * 0.7) / zoom, color: theme.map.landOutline, alpha: 0.5 });
  }

  private drawRivers(zoom: number): void {
    const g = this.riverGfx;
    g.clear();
    if (!this.data.rivers) return;

    // Two passes so major rivers read clearly at low zoom without every creek
    // turning the map into spaghetti.
    for (const major of [true, false]) {
      let any = false;
      for (const f of this.data.rivers.features) {
        const isMajor = (f.properties.scalerank ?? 6) <= 4;
        if (isMajor !== major) continue;
        if (!major && zoom < 0.08) continue; // minor rivers hidden at theatre view
        this.traceLine(g, f.geometry);
        any = true;
      }
      if (!any) continue;
      const widthPx = major ? theme.map.riverMajorWidthPx : theme.map.riverMinorWidthPx;
      g.stroke({ width: widthPx / zoom, color: theme.map.river, alpha: major ? 0.95 : 0.6 });
    }
  }

  // ---------------------------------------------------------------- cities --

  private buildCities(): void {
    if (!this.data.cities) return;

    const style = new TextStyle({
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: 12,
      fill: theme.city.label,
      stroke: { color: 0x0a0e14, width: 3 },
    });

    for (const f of this.data.cities.features) {
      if (f.geometry.type !== 'Point') continue;
      const [lon, lat] = f.geometry.coordinates;
      const world = this.projection.project(lon, lat);
      const rank = f.properties.scalerank ?? 9;

      // One container per city, counter-scaled each frame so the dot and the
      // label keep a constant pixel size no matter how far we zoom.
      const node = new Container();
      node.position.set(world.x, world.y);

      const dot = new Graphics();
      const r = rank <= 2 ? 3.5 : rank <= 5 ? 2.5 : 1.8;
      dot.circle(0, 0, r).fill(rank <= 2 ? theme.city.capitalDot : theme.city.dot);
      dot.circle(0, 0, r).stroke({ width: 1, color: 0x0a0e14, alpha: 0.8 });
      node.addChild(dot);

      const label = new Text({ text: f.properties.name ?? '', style });
      label.anchor.set(0, 0.5);
      label.position.set(r + 4, 0);
      label.resolution = 2;
      node.addChild(label);

      this.cityContainer.addChild(node);
      this.cityEntries.push({ node, scalerank: rank });
    }
  }

  /**
   * Level of detail: show progressively smaller towns as the player zooms in.
   * Without this the theatre view is an unreadable wall of place names.
   */
  private updateCityLOD(zoom: number): void {
    const maxRank = zoom < 0.06 ? 1 : zoom < 0.12 ? 3 : zoom < 0.3 ? 5 : zoom < 0.8 ? 6 : 7;
    const inverse = 1 / zoom;
    for (const entry of this.cityEntries) {
      const visible = entry.scalerank <= maxRank;
      entry.node.visible = visible;
      if (visible) entry.node.scale.set(inverse);
    }
  }

  // ----------------------------------------------------------- primitives --

  private tracePolygon(g: Graphics, geom: Geometry): void {
    if (geom.type === 'Polygon') this.rings(g, geom.coordinates);
    else if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) this.rings(g, poly);
  }

  private rings(g: Graphics, rings: Position[][]): void {
    for (const ring of rings) {
      if (ring.length < 3) continue;
      this.path(g, ring);
      g.closePath();
    }
  }

  private traceLine(g: Graphics, geom: Geometry): void {
    if (geom.type === 'LineString') this.path(g, geom.coordinates);
    else if (geom.type === 'MultiLineString') for (const line of geom.coordinates) this.path(g, line);
  }

  private path(g: Graphics, points: Position[]): void {
    const first = points[0];
    if (!first) return;
    const p0 = this.projection.project(first[0], first[1]);
    g.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const pt = points[i]!;
      const p = this.projection.project(pt[0], pt[1]);
      g.lineTo(p.x, p.y);
    }
  }
}
