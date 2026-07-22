import type { GameEngine } from '@core/engine/gameEngine';
import type { Vec2 } from '@core/math/vec2';
import type { DivisionId, FactionId } from '@core/world/ids';
import type { ViewStore } from '@app/viewStore';
import type { Camera } from '@render/camera';
import { theme } from '@render/theme';
import { MAX_SPEED } from '@core/time/gameClock';

/** Pixels of movement before a press is treated as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5;
const KEYBOARD_PAN_PX_PER_SEC = 900;

/**
 * Translates mouse and keyboard into camera moves and simulation Commands.
 *
 * Nothing here mutates the world. Selection goes to the ViewStore, orders go
 * to the engine's command queue. That separation means the same interactions
 * could later be produced by a replay file or a network peer without this
 * class being involved at all.
 *
 * Raw DOM listeners are used rather than Pixi's event system: we need
 * box-select, drag-pan and modifier keys, all of which are easier to reason
 * about against the canvas element directly than through scene-graph hit
 * testing.
 */
export class InputController {
  private readonly disposers: (() => void)[] = [];
  private readonly held = new Set<string>();

  private panning = false;
  private panButton = -1;
  private dragStartScreen: Vec2 | null = null;
  private dragMoved = false;
  private boxSelecting = false;
  private lastFrameTime = performance.now();
  private rafHandle = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly engine: GameEngine,
    private readonly store: ViewStore,
    private readonly playerFaction: FactionId,
  ) {
    this.attach();
    this.rafHandle = requestAnimationFrame(this.keyboardPanLoop);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafHandle);
    for (const dispose of this.disposers) dispose();
  }

  // ---------------------------------------------------------------- wiring --

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (e: E) => void,
    opts?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, opts);
    this.disposers.push(() => target.removeEventListener(type, listener, opts));
  }

  private attach(): void {
    this.listen<PointerEvent>(this.canvas, 'pointerdown', this.onPointerDown);
    this.listen<PointerEvent>(window, 'pointermove', this.onPointerMove);
    this.listen<PointerEvent>(window, 'pointerup', this.onPointerUp);
    this.listen<WheelEvent>(this.canvas, 'wheel', this.onWheel, { passive: false });
    this.listen<Event>(this.canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen<KeyboardEvent>(window, 'keydown', this.onKeyDown);
    this.listen<KeyboardEvent>(window, 'keyup', this.onKeyUp);
    this.listen<Event>(window, 'blur', () => this.held.clear());
    this.listen<PointerEvent>(this.canvas, 'pointerleave', () => {
      this.store.cursorWorld = null;
      this.store.setHovered(null);
    });
  }

  private localPoint(e: PointerEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ------------------------------------------------------------- pointer ---

  private onPointerDown = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    this.dragStartScreen = p;
    this.dragMoved = false;

    if (e.button === 1 || (e.button === 0 && this.held.has('Space'))) {
      this.panning = true;
      this.panButton = e.button;
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      this.boxSelecting = true;
      const world = this.camera.screenToWorld(p.x, p.y);
      this.store.dragBox = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
    } else if (e.button === 2) {
      // Right button is ambiguous until release: a click issues an order, a
      // drag pans the map. Decided in onPointerUp by distance travelled.
      this.panning = true;
      this.panButton = 2;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    this.store.cursorWorld = this.camera.screenToWorld(p.x, p.y);

    if (this.dragStartScreen) {
      const dx = p.x - this.dragStartScreen.x;
      const dy = p.y - this.dragStartScreen.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) this.dragMoved = true;
    }

    if (this.panning && this.dragMoved) {
      this.camera.panByScreen(e.movementX, e.movementY);
      return;
    }

    if (this.boxSelecting && this.store.dragBox) {
      const world = this.camera.screenToWorld(p.x, p.y);
      this.store.dragBox.x1 = world.x;
      this.store.dragBox.y1 = world.y;
      return;
    }

    this.store.setHovered(this.pickDivision(p) ?? null);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.localPoint(e);

    if (this.panning && this.panButton === e.button) {
      this.panning = false;
      // A right press that never moved was an order, not a pan.
      if (e.button === 2 && !this.dragMoved) this.issueMoveOrder(p, e.shiftKey);
      this.dragStartScreen = null;
      return;
    }

    if (this.boxSelecting && e.button === 0) {
      this.boxSelecting = false;
      if (this.dragMoved && this.store.dragBox) this.selectInBox(e.shiftKey);
      else this.selectAtPoint(p, e.shiftKey);
      this.store.dragBox = null;
      this.store.publish(this.camera.zoom, true);
    }

    this.dragStartScreen = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    // Exponential so each notch is a constant *ratio*; linear zoom feels
    // glacial when zoomed out and violent when zoomed in.
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  };

  // ------------------------------------------------------------- keyboard --

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target)) return;
    this.held.add(e.code);

    const clock = this.engine.world.clock;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        clock.togglePause();
        break;
      case 'Escape':
        this.store.clearSelection();
        break;
      // 'H' for halt, not 'S': S is taken by WASD panning.
      case 'KeyH':
        if (this.store.selection.size) {
          this.engine.issue({ type: 'stop', divisions: [...this.store.selection] });
        }
        break;
      case 'KeyA':
        if (e.ctrlKey) {
          e.preventDefault();
          this.selectAllOwnDivisions();
        }
        break;
      case 'Home':
        this.camera.fitToBounds();
        break;
      case 'Equal':
      case 'NumpadAdd':
        this.camera.zoomAt(this.camera.viewportWidth / 2, this.camera.viewportHeight / 2, 1.25);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        this.camera.zoomAt(this.camera.viewportWidth / 2, this.camera.viewportHeight / 2, 0.8);
        break;
      default:
        if (/^Digit[0-5]$/.test(e.code)) {
          clock.setSpeed(Math.min(MAX_SPEED, Number(e.code.slice(5))));
        }
    }
    this.store.publish(this.camera.zoom, true);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** Smooth WASD / arrow-key panning, independent of key repeat rate. */
  private keyboardPanLoop = (now: number): void => {
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    let dx = 0;
    let dy = 0;
    // Ctrl+A is "select all", not "pan left".
    if (this.held.has('ControlLeft') || this.held.has('ControlRight')) {
      this.rafHandle = requestAnimationFrame(this.keyboardPanLoop);
      return;
    }
    if (this.held.has('KeyA') || this.held.has('ArrowLeft')) dx += 1;
    if (this.held.has('KeyD') || this.held.has('ArrowRight')) dx -= 1;
    if (this.held.has('KeyW') || this.held.has('ArrowUp')) dy += 1;
    if (this.held.has('KeyS') || this.held.has('ArrowDown')) dy -= 1;
    if (dx || dy) this.camera.panByScreen(dx * KEYBOARD_PAN_PX_PER_SEC * dt, dy * KEYBOARD_PAN_PX_PER_SEC * dt);

    this.rafHandle = requestAnimationFrame(this.keyboardPanLoop);
  };

  // ------------------------------------------------------------ selection --

  /**
   * Screen-space rectangle hit test against every counter.
   *
   * Done in screen space because that is where the counter has a fixed size —
   * in world space its footprint changes with zoom, and clicking a unit at
   * theatre view would need pixel-perfect aim.
   */
  private pickDivision(screen: Vec2): DivisionId | undefined {
    const halfW = theme.unit.widthPx / 2 + 3;
    const halfH = theme.unit.heightPx / 2 + 3;
    let best: { id: DivisionId; d2: number } | undefined;

    for (const d of this.engine.world.divisions.values()) {
      const s = this.camera.worldToScreen(d.position);
      const dx = screen.x - s.x;
      const dy = screen.y - s.y;
      if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 < best.d2) best = { id: d.id, d2 };
    }
    return best?.id;
  }

  private selectAtPoint(screen: Vec2, additive: boolean): void {
    const hit = this.pickDivision(screen);
    if (!hit) {
      if (!additive) this.store.clearSelection();
      return;
    }
    if (additive) this.store.toggleSelection(hit);
    else this.store.setSelection([hit]);
  }

  private selectInBox(additive: boolean): void {
    const box = this.store.dragBox;
    if (!box) return;
    const minX = Math.min(box.x0, box.x1);
    const maxX = Math.max(box.x0, box.x1);
    const minY = Math.min(box.y0, box.y1);
    const maxY = Math.max(box.y0, box.y1);

    const hits: DivisionId[] = [];
    for (const d of this.engine.world.divisions.values()) {
      // Box-select only ever grabs your own troops — dragging over the front
      // and picking up enemy divisions would be nothing but a nuisance.
      if (d.faction !== this.playerFaction) continue;
      const { x, y } = d.position;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) hits.push(d.id);
    }

    if (additive) for (const id of hits) this.store.selection.add(id);
    else this.store.setSelection(hits);
    this.store.invalidate();
  }

  private selectAllOwnDivisions(): void {
    const ids: DivisionId[] = [];
    for (const d of this.engine.world.divisions.values()) {
      if (d.faction === this.playerFaction) ids.push(d.id);
    }
    this.store.setSelection(ids);
  }

  // --------------------------------------------------------------- orders --

  private issueMoveOrder(screen: Vec2, append: boolean): void {
    const ordered = [...this.store.selection].filter(
      (id) => this.engine.world.getDivision(id)?.faction === this.playerFaction,
    );
    if (!ordered.length) return;

    const destination = this.camera.screenToWorld(screen.x, screen.y);
    this.engine.issue({ type: 'move', divisions: ordered, destination, append });
    this.store.publish(this.camera.zoom, true);
  }
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};
