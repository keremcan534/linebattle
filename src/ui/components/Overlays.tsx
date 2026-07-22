import { useState } from 'react';
import type { LoadState } from '@app/useGame';

export function LoadingOverlay({ state }: { state: LoadState }) {
  if (state.status === 'ready') return null;

  if (state.status === 'error') {
    return (
      <div className="overlay overlay--error">
        <div className="overlay__card">
          <h1>Scenario failed to load</h1>
          <pre>{state.message}</pre>
          <p className="overlay__hint">
            If this is a fresh checkout, run <code>npm run data:prepare</code> to generate the map
            data, then reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay">
      <div className="overlay__card">
        <h1>Linebattle</h1>
        <p className="overlay__stage">{state.stage}…</p>
        <div className="overlay__track">
          <div className="overlay__fill" style={{ width: `${state.progress * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

const CONTROLS: [string, string][] = [
  ['Left click', 'Select division'],
  ['Left drag', 'Box-select your divisions'],
  ['Shift + click', 'Add to selection'],
  ['Right click', 'Move order'],
  ['Shift + right click', 'Queue waypoint'],
  ['Right drag / middle drag', 'Pan the map'],
  ['Wheel', 'Zoom'],
  ['W A S D / arrows', 'Pan'],
  ['Space', 'Pause'],
  ['1 – 5', 'Game speed'],
  ['H', 'Halt selected'],
  ['Ctrl + A', 'Select all your divisions'],
  ['Home', 'Fit theatre'],
  ['Esc', 'Clear selection'],
];

export function ControlsHint() {
  const [open, setOpen] = useState(true);
  return (
    <div className={`controls ${open ? 'is-open' : ''}`}>
      <button className="controls__toggle" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide controls' : 'Controls'}
      </button>
      {open && (
        <dl className="controls__list">
          {CONTROLS.map(([key, action]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
