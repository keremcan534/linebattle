import type { StrategicObjectiveKind } from '@core/world/strategicObjective';
import { MAX_OBJECTIVES_PER_KIND } from '@core/world/strategicObjective';
import type { StrategicObjectiveSummary } from '@app/viewStore';

interface Props {
  objectives: readonly StrategicObjectiveSummary[];
  placement: StrategicObjectiveKind | null;
  onPlace: (kind: StrategicObjectiveKind | null) => void;
  onClear: (kind: StrategicObjectiveKind) => void;
}

export function StrategicObjectives({
  objectives,
  placement,
  onPlace,
  onClear,
}: Props) {
  const count = (kind: StrategicObjectiveKind) =>
    objectives.filter((objective) => objective.kind === kind).length;
  const attack = count('attack');
  const defense = count('defense');

  const objectiveButton = (
    kind: StrategicObjectiveKind,
    label: string,
    current: number,
  ) => (
    <div className="objectives__row">
      <button
        className={`btn objectives__place objectives__place--${kind} ${
          placement === kind ? 'is-active' : ''
        }`}
        disabled={current >= MAX_OBJECTIVES_PER_KIND && placement !== kind}
        onClick={() => onPlace(placement === kind ? null : kind)}
      >
        {label} {current}/{MAX_OBJECTIVES_PER_KIND}
      </button>
      <button
        className="btn objectives__clear"
        disabled={current === 0}
        onClick={() => onClear(kind)}
        title={`Clear ${label.toLowerCase()} objectives`}
      >
        ×
      </button>
    </div>
  );

  return (
    <section className="objectives" aria-label="Strategic objectives">
      <div className="objectives__title">Strategic intent</div>
      {objectiveButton('attack', 'Attack', attack)}
      {objectiveButton('defense', 'Defense', defense)}
      <div className="objectives__hint">
        {placement ? 'Click the map to place · Esc cancels' : 'Up to three of each'}
      </div>
    </section>
  );
}
