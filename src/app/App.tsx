import { useCallback, useRef } from 'react';
import { SelectionPanel } from '@ui/components/SelectionPanel';
import { TopBar } from '@ui/components/TopBar';
import { ControlsHint, LoadingOverlay } from '@ui/components/Overlays';
import { useGame, useViewSnapshot } from './useGame';

const SCENARIO_URL = '/data/scenarios/barbarossa-1941.json';

/**
 * The application shell.
 *
 * React's job here is deliberately small: own a host <div> for the canvas,
 * render the HUD from an immutable snapshot, and turn button clicks into
 * commands. It never touches the World, never holds a Pixi object, and never
 * re-renders because of a game frame.
 */
export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const { loadState, sessionRef, store } = useGame(SCENARIO_URL, hostRef);
  const snapshot = useViewSnapshot(store);

  const setSpeed = useCallback(
    (speed: number) => {
      const session = sessionRef.current;
      if (!session) return;
      session.engine.world.clock.setSpeed(speed);
      session.store.publish(session.renderer.camera.zoom, true);
    },
    [sessionRef],
  );

  const togglePause = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.engine.world.clock.togglePause();
    session.store.publish(session.renderer.camera.zoom, true);
  }, [sessionRef]);

  const stopSelected = useCallback(() => {
    const session = sessionRef.current;
    if (!session || snapshot.selection.length === 0) return;
    session.engine.issue({ type: 'stop', divisions: [...snapshot.selection] });
  }, [sessionRef, snapshot.selection]);

  return (
    <div className="app">
      <div className="app__map" ref={hostRef} />

      {loadState.status === 'ready' && (
        <>
          <TopBar
            snapshot={snapshot}
            scenarioName={sessionRef.current?.scenarioName ?? ''}
            onSetSpeed={setSpeed}
            onTogglePause={togglePause}
          />
          <SelectionPanel selected={snapshot.selectedDetails} onStop={stopSelected} />
          <ControlsHint />
        </>
      )}

      <LoadingOverlay state={loadState} />
    </div>
  );
}
