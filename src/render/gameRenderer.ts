import { Application, Container, Graphics } from 'pixi.js';
import type { GameEngine } from '@core/engine/gameEngine';
import type { MapData } from '@core/scenario/scenarioLoader';
import type { ViewStore } from '@app/viewStore';
import { Camera } from './camera';
import { BattleLayer } from './layers/battleLayer';
import { BorderLayer } from './layers/borderLayer';
import { ControlOverlay } from './layers/controlOverlay';
import { MapLayer } from './layers/mapLayer';
import { OrderLayer } from './layers/orderLayer';
import { ObjectiveLayer } from './layers/objectiveLayer';
import { UnitLayer } from './layers/unitLayer';
import { theme } from './theme';

/** How often the React-facing snapshot is refreshed, in milliseconds. */
const UI_PUBLISH_INTERVAL_MS = 100;

/**
 * Owns the PixiJS application and the single frame loop.
 *
 * Layer order is the draw order — map underneath, orders above it, counters on
 * top — and lives in one place so z-fighting can never become an emergent
 * property of import order.
 *
 * This class is the ONLY thing that drives the engine forward. Rendering and
 * simulation share one clock but not one timestep: `engine.advance` decides
 * how many fixed ticks the elapsed real time is worth, and the layers
 * interpolate across whatever fraction of a tick is left over.
 *
 * We run our OWN requestAnimationFrame loop rather than Pixi's ticker, and
 * call `renderer.render()` explicitly. The loop belongs to whoever owns the
 * simulation clock; borrowing the renderer's heartbeat inverts that and makes
 * "when does the world advance?" a question about Pixi's internals. Owning it
 * also makes teardown deterministic — `stop()` cancels one handle we hold.
 *
 * Note that rAF does not fire at all in a backgrounded or non-composited tab.
 * That is correct behaviour (a paused tab should not burn CPU simulating), and
 * `deltaMS` is clamped below so returning to the tab resumes smoothly rather
 * than fast-forwarding.
 */
export class GameRenderer {
  readonly camera: Camera;
  private readonly worldRoot = new Container();
  private readonly mapLayer: MapLayer;
  private readonly borderLayer: BorderLayer | null;
  private readonly unitLayer: UnitLayer;
  private readonly orderLayer: OrderLayer;
  private readonly objectiveLayer: ObjectiveLayer;
  private readonly battleLayer: BattleLayer;
  private readonly controlOverlay: ControlOverlay | null;
  private resizeObserver: ResizeObserver | null = null;
  private uiClock = 0;
  private rafHandle = 0;
  private lastFrameMs = 0;
  private running = false;

  private constructor(
    readonly app: Application,
    private readonly engine: GameEngine,
    private readonly store: ViewStore,
    mapData: MapData,
  ) {
    const world = engine.world;
    this.camera = new Camera(world.bounds);

    this.mapLayer = new MapLayer(mapData, world.projection, world.bounds);
    this.borderLayer = mapData.borders ? new BorderLayer(mapData.borders, world.projection) : null;
    this.orderLayer = new OrderLayer(world);
    this.objectiveLayer = new ObjectiveLayer(world);
    this.unitLayer = new UnitLayer(world);
    this.battleLayer = new BattleLayer(world);
    this.controlOverlay = world.supply ? new ControlOverlay(world) : null;

    // The hand-drawn period borders are approximations and the computed
    // liquid control map has superseded them as the political read, so they start
    // hidden; B brings them back for anyone who wants the treaty lines.
    this.borderLayer?.setVisible(false);
    // The control wash is the default political view — the front line lives
    // in it — so it starts on.
    this.controlOverlay?.setVisible(true);

    // Draw order. Borders sit above the terrain but below anything the player
    // manipulates, so a dashed frontier can never obscure a counter. Battle
    // bubbles go on top of everything: a fight is the most urgent thing on
    // the map and must never be hidden behind a counter.
    this.worldRoot.addChild(this.mapLayer.container);
    // The political wash sits directly on terrain and below every unit layer.
    if (this.controlOverlay) this.worldRoot.addChild(this.controlOverlay.container);
    if (this.borderLayer) this.worldRoot.addChild(this.borderLayer.container);
    this.worldRoot.addChild(
      this.objectiveLayer.container,
      this.orderLayer.container,
      this.unitLayer.container,
      this.battleLayer.container,
    );

    // Clip every world layer to the true projected theatre. Under LCC the
    // geographic lon/lat rectangle is a curved trapezium, not the camera's
    // enclosing rectangle; using that rectangle exposed unused corner strips.
    const b = world.bounds;
    const mask = new Graphics();
    const first = b.boundary?.[0];
    if (first) {
      mask.moveTo(first.x, first.y);
      for (let i = 1; i < b.boundary!.length; i++) {
        const p = b.boundary![i]!;
        mask.lineTo(p.x, p.y);
      }
      mask.closePath().fill(0xffffff);
    } else {
      // Synthetic test worlds only declare the numeric rectangle.
      mask.rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY).fill(0xffffff);
    }
    this.worldRoot.addChild(mask);
    this.worldRoot.mask = mask;

    app.stage.addChild(this.worldRoot);
  }

  static async create(
    host: HTMLElement,
    engine: GameEngine,
    mapData: MapData,
    store: ViewStore,
  ): Promise<GameRenderer> {
    const app = new Application();
    await app.init({
      background: theme.background,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      width: host.clientWidth || 800,
      height: host.clientHeight || 600,
      preference: 'webgl',
      // We own the loop; Pixi must neither start one nor share one.
      autoStart: false,
      sharedTicker: false,
    });
    host.appendChild(app.canvas);

    const renderer = new GameRenderer(app, engine, store, mapData);
    renderer.observeResize(host);
    renderer.camera.fitToBounds();
    renderer.start();
    return renderer;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /** Toggles the liquid political map. Returns the new visibility. */
  toggleControlOverlay(): boolean {
    if (!this.controlOverlay) return false;
    this.controlOverlay.setVisible(!this.controlOverlay.visible);
    return this.controlOverlay.visible;
  }

  /** Toggles the political overlay. Returns the new visibility. */
  toggleBorders(): boolean {
    if (!this.borderLayer) return false;
    this.borderLayer.setVisible(!this.borderLayer.visible);
    return this.borderLayer.visible;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameMs = performance.now();
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  destroy(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.mapLayer.destroy();
    this.borderLayer?.destroy();
    this.unitLayer.destroy();
    this.orderLayer.destroy();
    this.objectiveLayer.destroy();
    this.battleLayer.destroy();
    this.controlOverlay?.destroy();
    this.app.destroy(true, { children: true });
  }

  // ------------------------------------------------------------ frame loop --

  private frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.frame);

    // Clamped so an alt-tabbed tab does not return with a multi-second delta.
    const deltaMS = Math.min(250, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;
    const dt = deltaMS / 1000;

    // 1. Simulation. Consumes commands, runs whole ticks, emits events.
    this.engine.advance(dt);

    // 2. Camera transform, once, for every world-space layer.
    this.camera.applyTo(this.worldRoot);

    // 3. Layers read world state. None of them writes to it.
    const zoom = this.camera.zoom;
    const alpha = this.engine.world.clock.subTickAlpha;
    this.mapLayer.update(zoom);
    this.borderLayer?.update(zoom);
    this.controlOverlay?.update();
    this.objectiveLayer.update(zoom);
    this.orderLayer.update(zoom, this.store.selection, this.store.dragBox);
    this.unitLayer.update(zoom, alpha, this.store.selection, this.store.hovered);
    this.battleLayer.update(zoom, deltaMS);

    // 4. Publish to React on a throttle, never per frame.
    this.uiClock += deltaMS;
    if (this.uiClock >= UI_PUBLISH_INTERVAL_MS) {
      this.uiClock = 0;
      this.store.invalidate();
      this.store.publish(zoom);
    }

    // 5. Draw. Explicit, because autoStart is off.
    this.app.renderer.render(this.app.stage);
  };

  private observeResize(host: HTMLElement): void {
    const apply = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      const wasDegenerate = !this.camera.hasValidViewport;

      this.app.renderer.resize(w, h);
      this.camera.viewportWidth = w;
      this.camera.viewportHeight = h;

      // The host can be laid out after the renderer is created (hidden tab,
      // flex parent, mount inside a collapsed container). Re-frame the theatre
      // the first time we learn a real size, otherwise the initial fit was
      // computed against a 1x1 viewport and the map stays unusable.
      if (wasDegenerate && this.camera.hasValidViewport) this.camera.fitToBounds();
      else this.camera.clampToBounds();
    };
    apply();
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(host);
  }
}
