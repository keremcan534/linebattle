import { useCallback, useRef, useState } from 'react';
import { SelectionPanel } from '@ui/components/SelectionPanel';
import { TopBar } from '@ui/components/TopBar';
import { ControlsHint, LoadingOverlay } from '@ui/components/Overlays';
import { ScenarioPicker, type ScenarioEntry } from '@ui/components/ScenarioPicker';
import { useGame, useViewSnapshot } from './useGame';

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
  const [scenario, setScenario] = useState<ScenarioEntry | null>(null);
  const scenarioUrl = scenario ? `/data/scenarios/${scenario.file}` : null;

  const { loadState, sessionRef, store } = useGame(scenarioUrl, hostRef);
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

  if (!scenario) return <ScenarioPicker onPick={setScenario} />;

  return (
    <div className="app">
      {/* Keyed on the scenario so switching campaigns tears the canvas host
          down entirely rather than trying to reuse a WebGL context. */}
      <div className="app__map" key={scenario.id} ref={hostRef} />

      {loadState.status === 'ready' && (
        <>
          <TopBar
            snapshot={snapshot}
            scenarioName={sessionRef.current?.scenarioName ?? scenario.name}
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
