import { useEffect, useState } from 'react';

export interface ScenarioEntry {
  id: string;
  file: string;
  name: string;
  date: string;
  theatre: string;
  blurb: string;
}

/**
 * Campaign select.
 *
 * Exists because there are now three theatres and hardcoding a URL in `App`
 * would make the multi-theatre work invisible. The list is data
 * (`scenarios/index.json`), so adding a campaign stays a no-code change —
 * the same rule the scenario format itself follows.
 */
export function ScenarioPicker({ onPick }: { onPick: (entry: ScenarioEntry) => void }) {
  const [entries, setEntries] = useState<ScenarioEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}data/scenarios/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { scenarios: ScenarioEntry[] }) => {
        if (!cancelled) setEntries(data.scenarios);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="overlay">
      <div className="picker">
        <h1 className="picker__title">Linebattle</h1>
        <p className="picker__sub">Operational command on a continuous map</p>

        {error && <p className="picker__error">Could not load campaigns: {error}</p>}
        {!entries && !error && <p className="picker__sub">Loading campaigns…</p>}

        <ul className="picker__list">
          {entries?.map((entry) => (
            <li key={entry.id}>
              <button className="picker__item" onClick={() => onPick(entry)}>
                <span className="picker__itemHead">
                  <span className="picker__name">{entry.name}</span>
                  <span className="picker__date">{entry.date}</span>
                </span>
                <span className="picker__theatre">{entry.theatre}</span>
                <span className="picker__blurb">{entry.blurb}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
