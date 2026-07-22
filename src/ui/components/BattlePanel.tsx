import type { BattleSummary } from '@app/viewStore';

interface Props {
  battles: readonly BattleSummary[];
  onFocus: (battle: BattleSummary) => void;
}

/**
 * Every engagement the player is involved in, worst first.
 *
 * On a 2000 km front the bubbles are the wrong tool for "am I losing
 * anywhere?" — you would have to pan the whole map to find out. This is the
 * index: sorted by how badly it is going, one click flies the camera there.
 */
export function BattlePanel({ battles, onFocus }: Props) {
  if (battles.length === 0) return null;

  return (
    <aside className="battles">
      <header className="battles__head">
        <span>Engagements</span>
        <span className="battles__count">{battles.length}</span>
      </header>

      <ul className="battles__list">
        {battles.slice(0, 12).map((b) => {
          const losing = b.progress < 0.45;
          const winning = b.progress > 0.6;
          return (
            <li key={b.id}>
              <button className="battles__item" onClick={() => onFocus(b)}>
                <span className="battles__row">
                  <span className={`battles__state ${losing ? 'is-losing' : winning ? 'is-winning' : ''}`}>
                    {losing ? 'losing' : winning ? 'winning' : 'even'}
                  </span>
                  <span className="battles__odds">
                    {b.playerDivisions}v{b.enemyDivisions}
                  </span>
                  <span className="battles__hours">{formatHours(b.hours)}</span>
                </span>

                <span className="battles__track">
                  <span className="battles__fill" style={{ width: `${clamp(b.progress) * 100}%` }} />
                </span>

                <span className="battles__meta">
                  {b.attacking ? 'attacking' : 'defending'} · {b.terrain} ·{' '}
                  {b.lat.toFixed(1)}°N {b.lon.toFixed(1)}°E
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function formatHours(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}
