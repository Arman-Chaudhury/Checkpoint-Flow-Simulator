import { ARRIVAL_PROFILES } from '../simulation/arrivals';
import type { SimConfig } from '../simulation/simulation';

interface Props {
  config: SimConfig;
  onChange: (patch: Partial<SimConfig>) => void;
  onRerun: () => void;
}

const HORIZON_OPTIONS = [120, 180, 240, 300, 360];

/** Clamp an integer input; empty/garbage falls back to the given default. */
function toInt(raw: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export default function ControlsPanel({ config, onChange, onRerun }: Props) {
  const profileMeta = ARRIVAL_PROFILES.find((p) => p.id === config.arrivalProfile);

  return (
    <section className="controls" aria-label="Simulation controls">
      <div className="control-group control-group--lanes">
        <label htmlFor="lanes">
          Open lanes <span className="control-value">{config.numLanes}</span>
        </label>
        <input
          id="lanes"
          type="range"
          min={1}
          max={12}
          step={1}
          value={config.numLanes}
          onChange={(e) => onChange({ numLanes: Number(e.target.value) })}
        />
        <p className="control-hint">
          The main staffing lever — drag to see waits respond.
        </p>
      </div>

      <div className="control-group">
        <label htmlFor="profile">Arrival profile</label>
        <select
          id="profile"
          value={config.arrivalProfile}
          onChange={(e) =>
            onChange({ arrivalProfile: e.target.value as SimConfig['arrivalProfile'] })
          }
        >
          {ARRIVAL_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {profileMeta && <p className="control-hint">{profileMeta.description}</p>}
      </div>

      <div className="control-group">
        <label htmlFor="volume">
          Passenger volume{' '}
          <span className="control-value">×{config.volumeMultiplier.toFixed(2)}</span>
        </label>
        <input
          id="volume"
          type="range"
          min={0.25}
          max={3}
          step={0.05}
          value={config.volumeMultiplier}
          onChange={(e) => onChange({ volumeMultiplier: Number(e.target.value) })}
        />
      </div>

      <div className="control-group">
        <label htmlFor="service-mean">
          Mean screening time{' '}
          <span className="control-value">
            {Math.round(config.serviceMeanMinutes * 60)} s
          </span>
        </label>
        <input
          id="service-mean"
          type="range"
          min={0.3}
          max={1.5}
          step={0.05}
          value={config.serviceMeanMinutes}
          onChange={(e) => onChange({ serviceMeanMinutes: Number(e.target.value) })}
        />
      </div>

      <div className="control-group">
        <label htmlFor="horizon">Window length</label>
        <select
          id="horizon"
          value={config.horizonMinutes}
          onChange={(e) => onChange({ horizonMinutes: Number(e.target.value) })}
        >
          {HORIZON_OPTIONS.map((h) => (
            <option key={h} value={h}>
              {h / 60} hours
            </option>
          ))}
        </select>
      </div>

      <div className="control-group control-group--seed">
        <label htmlFor="seed">Random seed</label>
        <div className="seed-row">
          <input
            id="seed"
            type="number"
            min={0}
            max={2 ** 31}
            value={config.seed}
            onChange={(e) =>
              onChange({ seed: toInt(e.target.value, config.seed, 0, 2 ** 31) })
            }
          />
          <button type="button" onClick={onRerun}>
            Re-run
          </button>
        </div>
        <p className="control-hint">
          Same seed, same result — Re-run draws a fresh sequence.
        </p>
      </div>
    </section>
  );
}
