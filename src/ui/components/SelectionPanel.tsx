import type { DivisionSummary } from '@app/viewStore';

interface Props {
  selected: readonly DivisionSummary[];
  onStop: () => void;
}

/**
 * Details for the current selection.
 *
 * One division shows the full stat block; several show a roster with the
 * aggregate at the top, because at operational scale you mostly care about
 * "is this corps still combat-capable", not about individual numbers.
 */
export function SelectionPanel({ selected, onStop }: Props) {
  if (selected.length === 0) return null;

  if (selected.length === 1) {
    const d = selected[0]!;
    return (
      <aside className="panel">
        <header className="panel__head" style={{ borderColor: hex(d.factionColor) }}>
          <div>
            <h2 className="panel__name">{d.name}</h2>
            <p className="panel__sub">
              {d.formation || d.factionName} · {d.branch}
            </p>
          </div>
        </header>

        <div className="panel__body">
          <Stat label="Strength" value={`${d.manpower.toLocaleString()} / ${d.maxManpower.toLocaleString()}`} ratio={d.strength} tone="strength" />
          <Stat label="Organisation" value={pct(d.organisation)} ratio={d.organisation} tone="org" />
          <Stat label="Morale" value={pct(d.morale)} ratio={d.morale} tone="morale" />
          <Stat label="Supply" value={pct(d.supply)} ratio={d.supply} tone="supply" />
          <Stat label="Experience" value={pct(d.experience)} ratio={d.experience} tone="exp" />

          <dl className="panel__facts">
            <div><dt>Speed</dt><dd>{d.speedKmh.toFixed(2)} km/h</dd></div>
            <div><dt>Terrain</dt><dd>{d.terrain}</dd></div>
            <div><dt>Stance</dt><dd>{d.hasOrder ? 'Moving' : d.stance}</dd></div>
            <div><dt>Position</dt><dd>{d.lat.toFixed(2)}°N {d.lon.toFixed(2)}°E</dd></div>
          </dl>
        </div>

        <footer className="panel__foot">
          <button className="btn btn--wide" onClick={onStop} disabled={!d.hasOrder}>
            Halt (H)
          </button>
        </footer>
      </aside>
    );
  }

  const avg = (pick: (d: DivisionSummary) => number) =>
    selected.reduce((sum, d) => sum + pick(d), 0) / selected.length;

  return (
    <aside className="panel">
      <header className="panel__head">
        <div>
          <h2 className="panel__name">{selected.length} divisions</h2>
          <p className="panel__sub">
            {selected.reduce((s, d) => s + d.manpower, 0).toLocaleString()} men
          </p>
        </div>
      </header>

      <div className="panel__body">
        <Stat label="Avg. strength" value={pct(avg((d) => d.strength))} ratio={avg((d) => d.strength)} tone="strength" />
        <Stat label="Avg. organisation" value={pct(avg((d) => d.organisation))} ratio={avg((d) => d.organisation)} tone="org" />
        <Stat label="Avg. supply" value={pct(avg((d) => d.supply))} ratio={avg((d) => d.supply)} tone="supply" />

        <ul className="panel__roster">
          {selected.map((d) => (
            <li key={d.id}>
              <span className="swatch" style={{ background: hex(d.factionColor) }} />
              <span className="panel__rosterName">{d.name}</span>
              <span className="panel__rosterOrg">{pct(d.organisation)}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer className="panel__foot">
        <button className="btn btn--wide" onClick={onStop}>Halt all (H)</button>
      </footer>
    </aside>
  );
}

function Stat({ label, value, ratio, tone }: { label: string; value: string; ratio: number; tone: string }) {
  return (
    <div className="stat">
      <div className="stat__row">
        <span className="stat__label">{label}</span>
        <span className="stat__value">{value}</span>
      </div>
      <div className="stat__track">
        <div className={`stat__fill stat__fill--${tone}`} style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} />
      </div>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
