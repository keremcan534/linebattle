import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GameEngine } from '@core/engine/gameEngine';
import { loadScenario } from '@core/scenario/scenarioLoader';
import { factionId } from '@core/world/ids';
import { InputController } from '@input/inputController';
import { GameRenderer } from '@render/gameRenderer';
import { ViewStore, type ViewSnapshot } from './viewStore';

export interface GameSession {
  engine: GameEngine;
  renderer: GameRenderer;
  store: ViewStore;
  scenarioName: string;
}

export type LoadState =
  | { status: 'loading'; stage: string; progress: number }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/**
 * Boots a scenario and wires engine, renderer, input and view store together.
 *
 * This hook is the ONLY place where the three subsystems meet. Everything else
 * in the app depends on at most one of them, which is what keeps the
 * dependency graph a tree rather than a knot: React → hook → {core, render,
 * input}, and never render → React or core → anything.
 */
export function useGame(scenarioUrl: string | null, hostRef: React.RefObject<HTMLDivElement>) {
  const [loadState, setLoadState] = useState<LoadState>({
    status: 'loading',
    stage: 'Starting',
    progress: 0,
  });
  const sessionRef = useRef<GameSession | null>(null);
  const storeRef = useRef<ViewStore>(new ViewStore());

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scenarioUrl) return;

    // React 18 StrictMode mounts effects twice in development. `cancelled`
    // makes the discarded first run tear itself down instead of leaving a
    // second WebGL context and a second ticker running forever.
    let cancelled = false;
    let session: GameSession | null = null;
    let input: InputController | null = null;

    (async () => {
      try {
        const { scenario, world, mapData } = await loadScenario(scenarioUrl, (stage, progress) => {
          if (!cancelled) setLoadState({ status: 'loading', stage, progress });
        });
        if (cancelled) return;

        const store = storeRef.current;
        store.attach(world);
        const playerAlliance = world.getFaction(factionId(scenario.playerFaction))?.alliance ?? '';
        store.playerAlliance = playerAlliance;

        // Every alliance the player does not command is played by the AI.
        const engine = new GameEngine(world, {
          aiAlliances: world.alliances.filter((a) => a !== playerAlliance),
        });
        const renderer = await GameRenderer.create(host, engine, mapData, store);
        if (cancelled) {
          renderer.destroy();
          return;
        }

        input = new InputController(renderer, engine, store, factionId(scenario.playerFaction));

        session = { engine, renderer, store, scenarioName: scenario.name };
        sessionRef.current = session;

        // Dev-only handle for poking at the running game from the console.
        // Stripped from production builds by the bundler's dead-code pass.
        if (import.meta.env.DEV) {
          (window as unknown as { __game?: GameSession }).__game = session;
        }

        // Start paused so the player can survey the front before H-hour.
        world.clock.setSpeed(0);
        store.publish(renderer.camera.zoom, true);
        setLoadState({ status: 'ready' });
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setLoadState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      cancelled = true;
      input?.destroy();
      session?.renderer.destroy();
      session?.engine.destroy();
      sessionRef.current = null;
    };
  }, [scenarioUrl, hostRef]);

  return { loadState, sessionRef, store: storeRef.current };
}

/** Subscribes a component to the throttled view snapshot. */
export function useViewSnapshot(store: ViewStore): ViewSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
