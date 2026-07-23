import { describe, it, expect } from 'vitest';
import {
  simulateQueue,
  percentile,
  runSimulation,
  DEFAULT_CONFIG,
  type SimConfig,
} from './simulation';
import { lognormalParams } from './service';
import { generateArrivals } from './arrivals';
import { Rng } from './random';

describe('simulateQueue — core FIFO / multi-server mechanics', () => {
  it('single lane: waits stack up behind a slow passenger (hand-calculated)', () => {
    // Arrivals at t = 0, 1, 2. First passenger takes 5 min; the rest 1 min.
    //  P0: arrives 0, starts 0, ends 5           -> wait 0
    //  P1: arrives 1, lane busy until 5, starts 5, ends 6 -> wait 4
    //  P2: arrives 2, lane busy until 6, starts 6, ends 7 -> wait 4
    const pax = simulateQueue([0, 1, 2], [5, 1, 1], 1);

    expect(pax.map((p) => p.serviceStart)).toEqual([0, 5, 6]);
    expect(pax.map((p) => p.serviceEnd)).toEqual([5, 6, 7]);
    expect(pax.map((p) => p.wait)).toEqual([0, 4, 4]);
    expect(pax.map((p) => p.timeInSystem)).toEqual([5, 5, 5]);
    expect(pax.every((p) => p.lane === 0)).toBe(true);
  });

  it('single lane, no contention: nobody waits', () => {
    // Each passenger finishes well before the next arrives.
    const pax = simulateQueue([0, 10, 20], [2, 2, 2], 1);
    expect(pax.map((p) => p.wait)).toEqual([0, 0, 0]);
  });

  it('two lanes: third simultaneous arrival waits for the first free lane', () => {
    // Three passengers arrive together, each needs 3 min, two lanes open.
    //  P0 -> lane 0: start 0, end 3, wait 0
    //  P1 -> lane 1: start 0, end 3, wait 0
    //  P2 -> earliest free lane frees at 3: start 3, end 6, wait 3
    const pax = simulateQueue([0, 0, 0], [3, 3, 3], 2);
    expect(pax.map((p) => p.wait)).toEqual([0, 0, 3]);
    expect(pax[0].lane).toBe(0);
    expect(pax[1].lane).toBe(1);
    // P2 should reuse lane 0 (freed at 3, tie broken by lowest index).
    expect(pax[2].lane).toBe(0);
    expect(pax[2].serviceStart).toBe(3);
  });

  it('two lanes: passenger takes whichever lane frees first, not round-robin', () => {
    // Lane 0 gets a long job, lane 1 a short one; the next passenger should go
    // to lane 1 because it frees first.
    //  P0 -> lane 0: 0..10
    //  P1 -> lane 1: 0..2
    //  P2 arrives at 3: lane 1 free at 2, lane 0 busy to 10 -> lane 1, start 3
    const pax = simulateQueue([0, 0, 3], [10, 2, 4], 2);
    expect(pax[2].lane).toBe(1);
    expect(pax[2].serviceStart).toBe(3);
    expect(pax[2].wait).toBe(0);
  });

  it('adding a lane never increases anyone\'s wait (monotonicity)', () => {
    const arrivals = [0, 0, 0, 0, 1, 1, 2, 3, 3, 3];
    const service = [4, 2, 6, 1, 3, 5, 2, 4, 1, 2];
    const one = simulateQueue(arrivals, service, 1);
    const two = simulateQueue(arrivals, service, 2);
    for (let i = 0; i < arrivals.length; i++) {
      expect(two[i].wait).toBeLessThanOrEqual(one[i].wait);
    }
  });

  it('throws on mismatched input lengths and bad lane counts', () => {
    expect(() => simulateQueue([0, 1], [1], 1)).toThrow();
    expect(() => simulateQueue([0], [1], 0)).toThrow();
  });
});

describe('percentile', () => {
  it('matches known values for a simple set', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 100)).toBe(10);
    // NumPy-style linear interpolation: 50th pct of 1..10 = 5.5
    expect(percentile(v, 50)).toBeCloseTo(5.5, 10);
    // 95th pct: rank = 0.95 * 9 = 8.55 -> between v[8]=9 and v[9]=10 => 9.55
    expect(percentile(v, 95)).toBeCloseTo(9.55, 10);
  });

  it('handles empty and singleton arrays', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('lognormalParams — moment matching', () => {
  it('recovers the requested mean and variance in real space', () => {
    const mean = 0.6;
    const std = 0.45;
    const { mu, sigma } = lognormalParams(mean, std);
    // Reconstruct the real-space moments from mu, sigma and check they match.
    const reconstructedMean = Math.exp(mu + (sigma * sigma) / 2);
    const reconstructedVar =
      (Math.exp(sigma * sigma) - 1) * Math.exp(2 * mu + sigma * sigma);
    expect(reconstructedMean).toBeCloseTo(mean, 10);
    expect(reconstructedVar).toBeCloseTo(std * std, 10);
  });

  it('empirical sample mean/std of many draws is close to requested', () => {
    const rng = new Rng(123);
    const mean = 0.6;
    const std = 0.45;
    const { mu, sigma } = lognormalParams(mean, std);
    const n = 50000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.exp(mu + sigma * rng.standardNormal());
      sum += x;
      sumSq += x * x;
    }
    const empMean = sum / n;
    const empVar = sumSq / n - empMean * empMean;
    expect(empMean).toBeCloseTo(mean, 1);
    expect(Math.sqrt(empVar)).toBeCloseTo(std, 1);
  });
});

describe('determinism & reproducibility', () => {
  it('same seed => identical arrivals', () => {
    const a = generateArrivals(new Rng(7), 'morningPeak', 240, 1);
    const b = generateArrivals(new Rng(7), 'morningPeak', 240, 1);
    expect(a).toEqual(b);
  });

  it('different seed => different arrivals', () => {
    const a = generateArrivals(new Rng(7), 'morningPeak', 240, 1);
    const b = generateArrivals(new Rng(8), 'morningPeak', 240, 1);
    expect(a).not.toEqual(b);
  });

  it('runSimulation is fully reproducible for a fixed config', () => {
    const r1 = runSimulation(DEFAULT_CONFIG);
    const r2 = runSimulation(DEFAULT_CONFIG);
    expect(r2.summary).toEqual(r1.summary);
    expect(r2.passengers).toEqual(r1.passengers);
  });
});

describe('runSimulation — end-to-end sanity & the non-linear lane effect', () => {
  const base: SimConfig = {
    ...DEFAULT_CONFIG,
    arrivalProfile: 'morningPeak',
    volumeMultiplier: 1,
    seed: 99,
  };

  it('produces a coherent result set', () => {
    const r = runSimulation(base);
    expect(r.passengers.length).toBeGreaterThan(0);
    expect(r.summary.totalArrivals).toBe(r.passengers.length);
    expect(r.summary.totalProcessed).toBeLessThanOrEqual(r.summary.totalArrivals);
    // p95 wait must be >= average wait by definition of the tail.
    expect(r.summary.p95Wait).toBeGreaterThanOrEqual(r.summary.avgWait);
    // Time series is sampled across the full window.
    expect(r.timeSeries[0].t).toBe(0);
    expect(r.timeSeries[r.timeSeries.length - 1].t).toBeGreaterThanOrEqual(
      base.horizonMinutes,
    );
  });

  it('utilization never exceeds 1, across profiles, loads and lane counts', () => {
    // A lane cannot be more than 100% busy no matter how overloaded the
    // checkpoint gets — only service INSIDE the window counts as busy time.
    for (const arrivalProfile of ['steady', 'morningPeak', 'bimodal'] as const) {
      for (const volumeMultiplier of [0.5, 1, 3]) {
        for (const numLanes of [1, 2, 8]) {
          const r = runSimulation({
            ...base,
            arrivalProfile,
            volumeMultiplier,
            numLanes,
          });
          expect(r.summary.avgUtilization).toBeGreaterThanOrEqual(0);
          expect(r.summary.avgUtilization).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('conservation: processed + still in system at horizon = total arrivals', () => {
    // Nobody is created or destroyed by the model. Every arrival either
    // finished screening inside the window or is still queued/in-service when
    // the window closes. An overloaded config makes the check meaningful —
    // plenty of passengers must actually be left over at the horizon.
    for (const seed of [1, 42, 99]) {
      const r = runSimulation({ ...base, seed, numLanes: 2, volumeMultiplier: 1.5 });
      const leftOver = r.passengers.filter(
        (p) => p.serviceEnd > base.horizonMinutes,
      ).length;
      expect(r.summary.stillInSystemAtHorizon).toBe(leftOver);
      expect(
        r.summary.totalProcessed + r.summary.stillInSystemAtHorizon,
      ).toBe(r.summary.totalArrivals);
    }
  });

  it('caps the number of simulated passengers and flags the truncation', () => {
    const r = runSimulation({ ...base, maxPassengers: 100, volumeMultiplier: 2 });
    expect(r.capped).toBe(true);
    expect(r.passengers.length).toBe(100);
    const uncapped = runSimulation(base);
    expect(uncapped.capped).toBe(false);
  });

  it('THE "AHA": adding lanes during a peak collapses wait non-linearly', () => {
    // Hold everything fixed except the number of lanes. As we open lanes, the
    // average wait should fall — and fall by DIMINISHING amounts, i.e. the
    // first extra lane during congestion buys far more than a later one. This
    // is the non-linear relationship the tool is built to demonstrate.
    const waitFor = (lanes: number) =>
      runSimulation({ ...base, numLanes: lanes }).summary.avgWait;

    const w3 = waitFor(3);
    const w4 = waitFor(4);
    const w5 = waitFor(5);
    const w6 = waitFor(6);

    // Monotonic improvement.
    expect(w4).toBeLessThan(w3);
    expect(w5).toBeLessThan(w4);
    expect(w6).toBeLessThanOrEqual(w5);

    // Diminishing returns: the first added lane helps more than the next.
    const gain34 = w3 - w4;
    const gain45 = w4 - w5;
    expect(gain34).toBeGreaterThan(gain45);
  });

  it('scaling volume up increases waits', () => {
    const light = runSimulation({ ...base, volumeMultiplier: 0.6 }).summary.avgWait;
    const heavy = runSimulation({ ...base, volumeMultiplier: 1.4 }).summary.avgWait;
    expect(heavy).toBeGreaterThan(light);
  });
});
