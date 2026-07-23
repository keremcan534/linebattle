import { useCallback, useRef, useState } from 'react';
import { SelectionPanel } from '@ui/components/SelectionPanel';
import { TopBar } from '@ui/components/TopBar';
import { ControlsHint, LoadingOverlay } from '@ui/components/Overlays';
import { BattlePanel } from '@ui/components/BattlePanel';
import { ScenarioPicker, type ScenarioEntry } from '@ui/components/ScenarioPicker';
import { StrategicObjectives } from '@ui/components/StrategicObjectives';
import type { BattleSummary } from './viewStore';
import type { StrategicObjectiveKind } from '@core/world/strategicObjective';
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
  const scenarioUrl = scenario
    ? `${import.meta.env.BASE_URL}data/scenarios/${scenario.file}`
    : null;

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

  const focusBattle = useCallback(
    (battle: BattleSummary) => {
      const session = sessionRef.current;
      if (!session) return;
      session.renderer.camera.centerOn({ x: battle.x, y: battle.y });
    },
    [sessionRef],
  );

  const setObjectivePlacement = useCallback(
    (kind: StrategicObjectiveKind | null) => {
      const session = sessionRef.current;
      if (!session) return;
      session.store.setObjectivePlacement(kind);
      session.store.publish(session.renderer.camera.zoom, true);
    },
    [sessionRef],
  );

  const clearObjectives = useCallback(
    (kind: StrategicObjectiveKind) => {
      const session = sessionRef.current;
      if (!session || !session.store.playerAlliance) return;
      session.engine.issue({
        type: 'clearObjectives',
        alliance: session.store.playerAlliance,
        kind,
      });
      session.engine.flushCommandsWhilePaused();
      session.store.setObjectivePlacement(null);
      session.store.publish(session.renderer.camera.zoom, true);
    },
    [sessionRef],
  );

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
            onReturnToMenu={() => setScenario(null)}
          />
          <SelectionPanel selected={snapshot.selectedDetails} onStop={stopSelected} />
          <BattlePanel battles={snapshot.battles} onFocus={focusBattle} />
          <StrategicObjectives
            objectives={snapshot.objectives}
            placement={snapshot.objectivePlacement}
            onPlace={setObjectivePlacement}
            onClear={clearObjectives}
          />
          <ControlsHint />
        </>
      )}

      <LoadingOverlay state={loadState} />
    </div>
  );
}
