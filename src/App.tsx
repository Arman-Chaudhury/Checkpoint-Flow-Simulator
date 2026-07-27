import { useMemo, useState } from 'react';
import ControlsPanel from './components/ControlsPanel';
import SummaryCards from './components/SummaryCards';
import TimeSeriesCharts from './components/TimeSeriesCharts';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { ARRIVAL_PROFILES } from './simulation/arrivals';
import {
  DEFAULT_CONFIG,
  runSimulation,
  type SimConfig,
  type SimResult,
} from './simulation/simulation';

/** Frozen copy of a configuration + its results, for side-by-side comparison. */
interface PinnedScenario {
  config: SimConfig;
  result: SimResult;
}

function describeConfig(config: SimConfig): string {
  const profile =
    ARRIVAL_PROFILES.find((p) => p.id === config.arrivalProfile)?.label ??
    config.arrivalProfile;
  return (
    `${profile} · ${config.numLanes} lanes · volume ×${config.volumeMultiplier.toFixed(2)} · ` +
    `${Math.round(config.serviceMeanMinutes * 60)} s mean screening · seed ${config.seed}`
  );
}

export default function App() {
  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG);
  const [pinned, setPinned] = useState<PinnedScenario | null>(null);

  // Sliders update `config` on every input event; the simulation itself only
  // re-runs once the debounced copy settles, so dragging stays smooth.
  const debouncedConfig = useDebouncedValue(config, 150);
  const result = useMemo(() => runSimulation(debouncedConfig), [debouncedConfig]);

  const updateConfig = (patch: Partial<SimConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      // Keep the service-time spread proportional to the mean (constant
      // coefficient of variation) so one slider controls a coherent
      // distribution instead of exposing sigma as a second dial.
      if (patch.serviceMeanMinutes !== undefined) {
        next.serviceStdMinutes = patch.serviceMeanMinutes * 0.75;
      }
      return next;
    });
  };

  // Deterministic "fresh draw": advance the seed so the run changes but any
  // seed value shown in the input can still be typed back in to reproduce it.
  const rerun = () => updateConfig({ seed: (config.seed + 1) >>> 0 });

  return (
    <div className="app">
      <header className="app-header">
        <h1>Checkpoint Flow Simulator</h1>
        <p>
          A discrete-event model of an airport security checkpoint. Adjust
          staffing and demand, and watch what the queue does — especially the
          95th-percentile wait.
        </p>
      </header>

      <ControlsPanel config={config} onChange={updateConfig} onRerun={rerun} />

      <div className="pin-bar">
        {pinned ? (
          <>
            <span className="pin-info">
              <span className="swatch swatch--pinned" aria-hidden />
              Pinned: {describeConfig(pinned.config)}
            </span>
            <button type="button" onClick={() => setPinned(null)}>
              Unpin
            </button>
          </>
        ) : (
          <>
            <span className="pin-info">
              Pin this scenario, then change a setting to compare the two runs
              side by side.
            </span>
            <button
              type="button"
              onClick={() =>
                setPinned({ config: debouncedConfig, result })
              }
            >
              Pin scenario
            </button>
          </>
        )}
      </div>

      {result.capped && (
        <p className="notice" role="status">
          Passenger volume hit the simulation cap (
          {result.config.maxPassengers.toLocaleString()} passengers), so this
          run is truncated. Lower the volume or shorten the window for exact
          results.
        </p>
      )}

      <SummaryCards
        current={result.summary}
        pinned={pinned ? pinned.result.summary : null}
      />

      <TimeSeriesCharts
        current={result.timeSeries}
        pinned={pinned ? pinned.result.timeSeries : null}
      />

      <footer className="app-footer">
        <p>
          Single shared queue, {result.config.numLanes} screening lanes,
          lognormal service times, non-homogeneous Poisson arrivals. All runs
          are deterministic in the seed.
        </p>
      </footer>
    </div>
  );
}
