import type { SimSummary } from '../simulation/simulation';

interface Props {
  current: SimSummary;
  pinned: SimSummary | null;
}

function formatMinutes(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  return `${m.toFixed(1)} min`;
}

interface CardSpec {
  key: string;
  label: string;
  prominent?: boolean;
  value: (s: SimSummary) => string;
}

const CARDS: CardSpec[] = [
  {
    key: 'p95',
    label: '95th-percentile wait',
    prominent: true,
    value: (s) => formatMinutes(s.p95Wait),
  },
  { key: 'avg', label: 'Average wait', value: (s) => formatMinutes(s.avgWait) },
  {
    key: 'maxq',
    label: 'Max queue length',
    value: (s) => `${s.maxQueueLength} pax`,
  },
  {
    key: 'processed',
    label: 'Passengers processed',
    value: (s) => `${s.totalProcessed.toLocaleString()}`,
  },
  {
    key: 'util',
    label: 'Lane utilization',
    value: (s) => `${Math.round(s.avgUtilization * 100)}%`,
  },
];

export default function SummaryCards({ current, pinned }: Props) {
  return (
    <section className="cards" aria-label="Summary statistics">
      {CARDS.map((card) => (
        <div
          key={card.key}
          className={`card${card.prominent ? ' card--prominent' : ''}`}
        >
          <p className="card-label">{card.label}</p>
          <p className="card-value">
            {pinned && <span className="swatch swatch--current" aria-hidden />}
            {card.value(current)}
          </p>
          {pinned && (
            <p className="card-pinned">
              <span className="swatch swatch--pinned" aria-hidden />
              {card.value(pinned)}
              <span className="card-pinned-label"> pinned</span>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
