import { MAX_SPEED } from '@core/time/gameClock';
import type { ViewSnapshot } from '@app/viewStore';

interface Props {
  snapshot: ViewSnapshot;
  scenarioName: string;
  onSetSpeed: (speed: number) => void;
  onTogglePause: () => void;
  onReturnToMenu: () => void;
}

/** Date, speed controls and cursor readout — the caption bar of the map animation. */
export function TopBar({
  snapshot,
  scenarioName,
  onSetSpeed,
  onTogglePause,
  onReturnToMenu,
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar__scenario">
        <div className="topbar__scenarioLine">
          <button
            className="btn btn--menu"
            onClick={onReturnToMenu}
            title="Return to scenario menu"
          >
            Menu
          </button>
          <span className="topbar__title">{scenarioName}</span>
        </div>
        <span className="topbar__count">
          {snapshot.divisionCount} divisions
          {' · '}
          {snapshot.frontlineSegmentCount} sectors
          {snapshot.weather && <> · {snapshot.weather}</>}
          {snapshot.campaignPhase && (
            <span className="topbar__phase"> · {snapshot.campaignPhase}</span>
          )}
          {snapshot.encircled > 0 && (
            <span className="topbar__alarm"> · {snapshot.encircled} encircled</span>
          )}
        </span>
      </div>

      <div className="topbar__clock">
        <time className="topbar__date">{snapshot.dateLabel}</time>
      </div>

      <div className="topbar__speed">
        <button
          className={`btn btn--pause ${snapshot.paused ? 'is-active' : ''}`}
          onClick={onTogglePause}
          title="Pause / resume (Space)"
        >
          {snapshot.paused ? '▶' : '❚❚'}
        </button>
        {Array.from({ length: MAX_SPEED }, (_, i) => i + 1).map((speed) => (
          <button
            key={speed}
            className={`btn btn--speed ${snapshot.speed === speed ? 'is-active' : ''}`}
            onClick={() => onSetSpeed(speed)}
            title={`Speed ${speed}`}
          >
            {speed}
          </button>
        ))}
      </div>

      <div className="topbar__cursor">
        {snapshot.cursor ? (
          <>
            <span>{formatLatLon(snapshot.cursor.lat, snapshot.cursor.lon)}</span>
            <span className="topbar__terrain">{snapshot.cursor.terrain}</span>
          </>
        ) : (
          <span className="topbar__terrain">—</span>
        )}
      </div>
    </header>
  );
}

function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(lon).toFixed(2)}°${ew}`;
}
