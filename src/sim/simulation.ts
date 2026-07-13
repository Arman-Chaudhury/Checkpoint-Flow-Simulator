/**
 * Discrete-event simulation of passenger flow through a security checkpoint.
 *
 * MODEL: single shared queue, multiple identical parallel lanes (an M/G/c–style
 * structure). Passengers form ONE line and the passenger at the head is pulled
 * to whichever lane frees up first. This "single queue, multi-server" design is
 * both what modern checkpoints actually do and what minimizes wait — it avoids
 * the bad luck of picking a slow line. Service times are drawn from a
 * right-skewed lognormal distribution (see service.ts) rather than being
 * constant, because the slow tail of service is what actually builds queues.
 *
 * This is an EVENT-DRIVEN simulation, not a frame-by-frame animation. We never
 * step time forward by a fixed dt to "move" passengers. Instead we reason
 * directly about the two events that matter — an arrival and a service
 * completion — and compute exact timestamps for each passenger.
 *
 * The engine is intentionally decoupled from React and has no I/O, so it is
 * fully unit-testable on its own.
 */

import { Rng } from './random';
import { sampleServiceTime } from './service';
import { ArrivalProfile, generateArrivals } from './arrivals';

export interface SimConfig {
  /** Length of the simulated window, in minutes. */
  horizonMinutes: number;
  /** Sampling resolution for the output time series, in minutes. */
  resolutionMinutes: number;
  /** Number of open screening lanes (the key interactive lever). */
  numLanes: number;
  /** Which time-of-day arrival shape to use. */
  arrivalProfile: ArrivalProfile;
  /** Scales the whole arrival profile up or down (1 = as defined). */
  volumeMultiplier: number;
  /** Mean lane service time, minutes. */
  serviceMeanMinutes: number;
  /** Std dev of lane service time, minutes (drives the skew of the tail). */
  serviceStdMinutes: number;
  /** Seed for reproducible runs. */
  seed: number;
}

/** One passenger's full journey through the checkpoint. */
export interface Passenger {
  id: number;
  /** When they joined the queue. */
  arrival: number;
  /** When a lane started screening them. */
  serviceStart: number;
  /** When screening finished. */
  serviceEnd: number;
  /** Which lane served them (0-indexed). */
  lane: number;
  /** Time spent waiting in the queue (serviceStart - arrival). */
  wait: number;
  /** Total time in the system (serviceEnd - arrival). */
  timeInSystem: number;
}

/** One sampled point of the output time series. */
export interface TimeSeriesPoint {
  /** Time in minutes from the start of the window. */
  t: number;
  /** Mean wait of passengers who ARRIVED in this resolution bucket (0 if none). */
  avgWait: number;
  /** Number of passengers waiting in the queue at exactly time t. */
  queueLength: number;
  /** Number of passengers in the system (queue + in service) at time t. */
  inSystem: number;
}

export interface SimSummary {
  totalProcessed: number;
  avgWait: number;
  /**
   * 95th-percentile wait. WHY THIS MATTERS MORE THAN THE AVERAGE: operations are
   * judged on the tail, not the middle. An average wait of 4 minutes can hide a
   * p95 of 25 minutes — meaning 1 in 20 passengers has a miserable experience
   * and may miss a flight. Staffing decisions target the tail.
   */
  p95Wait: number;
  maxWait: number;
  maxQueueLength: number;
  /** Average fraction of lane-time spent actively screening (0–1). */
  avgUtilization: number;
  avgTimeInSystem: number;
}

export interface SimResult {
  config: SimConfig;
  passengers: Passenger[];
  timeSeries: TimeSeriesPoint[];
  summary: SimSummary;
}

/**
 * Core queue mechanics, decoupled from arrival/service *generation* so it can be
 * driven by known inputs in unit tests.
 *
 * Given passenger arrival times (must be sorted ascending) and their service
 * durations, assign each passenger to a lane under FIFO discipline with the
 * "next free lane" rule and return the fully-resolved passenger records.
 *
 * ALGORITHM: keep the time each lane becomes free. For each passenger in arrival
 * order, choose the lane that frees earliest; the passenger begins service at
 * max(their arrival, that lane's free time). This is exactly the event-driven
 * behavior of a single queue feeding c servers — the "events" (arrivals and
 * completions) are encoded in the arrival list and the per-lane free times.
 * Lanes are few, so a linear scan for the earliest-free lane is simplest and
 * unambiguously correct.
 */
export function simulateQueue(
  arrivals: number[],
  serviceTimes: number[],
  numLanes: number,
): Passenger[] {
  if (numLanes < 1) throw new Error('numLanes must be >= 1');
  if (arrivals.length !== serviceTimes.length) {
    throw new Error('arrivals and serviceTimes must have equal length');
  }

  // laneFreeAt[k] = time at which lane k next becomes available.
  const laneFreeAt = new Array<number>(numLanes).fill(0);
  const passengers: Passenger[] = [];

  for (let i = 0; i < arrivals.length; i++) {
    const arrival = arrivals[i];

    // Pick the lane that becomes free earliest (ties resolved by lane index,
    // so behavior is deterministic).
    let lane = 0;
    for (let k = 1; k < numLanes; k++) {
      if (laneFreeAt[k] < laneFreeAt[lane]) lane = k;
    }

    // The passenger cannot start before they arrive, nor before their lane is
    // free. Whichever is later governs.
    const serviceStart = Math.max(arrival, laneFreeAt[lane]);
    const serviceEnd = serviceStart + serviceTimes[i];
    laneFreeAt[lane] = serviceEnd;

    passengers.push({
      id: i,
      arrival,
      serviceStart,
      serviceEnd,
      lane,
      wait: serviceStart - arrival,
      timeInSystem: serviceEnd - arrival,
    });
  }

  return passengers;
}

/** Linear-interpolated percentile of a numeric array (p in [0, 100]). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  // "Linear interpolation between closest ranks" (same method as NumPy default).
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Build the sampled time series from resolved passengers.
 *
 * For each sample time t (0, res, 2*res, …, horizon):
 *   - queueLength: passengers who have arrived but not yet started service.
 *   - inSystem:    passengers who have arrived but not yet finished service.
 * And for each bucket [t, t+res): the mean wait of passengers who ARRIVED in
 * that bucket — this is what reveals wait time climbing during a peak and then
 * recovering, which is the whole point of the visualization.
 */
function buildTimeSeries(
  passengers: Passenger[],
  horizon: number,
  resolution: number,
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  const numBuckets = Math.ceil(horizon / resolution);

  // Accumulate wait per arrival-bucket in one pass.
  const bucketWaitSum = new Array<number>(numBuckets + 1).fill(0);
  const bucketCount = new Array<number>(numBuckets + 1).fill(0);
  for (const p of passengers) {
    const b = Math.min(Math.floor(p.arrival / resolution), numBuckets);
    bucketWaitSum[b] += p.wait;
    bucketCount[b] += 1;
  }

  for (let i = 0; i <= numBuckets; i++) {
    const t = i * resolution;

    // Instantaneous counts at time t. Passengers are few thousand and buckets a
    // few hundred, so an O(n) scan per sample is comfortably fast and obviously
    // correct; a sweep-line optimization isn't worth the added complexity here.
    let queueLength = 0;
    let inSystem = 0;
    for (const p of passengers) {
      if (p.arrival <= t && p.serviceStart > t) queueLength++;
      if (p.arrival <= t && p.serviceEnd > t) inSystem++;
    }

    const count = bucketCount[i] ?? 0;
    const avgWait = count > 0 ? bucketWaitSum[i] / count : 0;

    points.push({ t, avgWait, queueLength, inSystem });
  }

  return points;
}

/** Compute the headline summary statistics. */
function buildSummary(
  passengers: Passenger[],
  config: SimConfig,
  timeSeries: TimeSeriesPoint[],
): SimSummary {
  const n = passengers.length;
  if (n === 0) {
    return {
      totalProcessed: 0,
      avgWait: 0,
      p95Wait: 0,
      maxWait: 0,
      maxQueueLength: 0,
      avgUtilization: 0,
      avgTimeInSystem: 0,
    };
  }

  const waits = passengers.map((p) => p.wait);
  const avgWait = waits.reduce((a, b) => a + b, 0) / n;
  const avgTimeInSystem =
    passengers.reduce((a, p) => a + p.timeInSystem, 0) / n;

  // Utilization = busy lane-minutes / total available lane-minutes over the
  // window. We only count service that falls within [0, horizon] so a job that
  // spills past the end of the window doesn't inflate the number.
  const horizon = config.horizonMinutes;
  let busyLaneMinutes = 0;
  for (const p of passengers) {
    const start = Math.min(p.serviceStart, horizon);
    const end = Math.min(p.serviceEnd, horizon);
    if (end > start) busyLaneMinutes += end - start;
  }
  const avgUtilization = busyLaneMinutes / (config.numLanes * horizon);

  const maxQueueLength = timeSeries.reduce(
    (m, pt) => Math.max(m, pt.queueLength),
    0,
  );

  return {
    totalProcessed: n,
    avgWait,
    p95Wait: percentile(waits, 95),
    maxWait: Math.max(...waits),
    maxQueueLength,
    avgUtilization,
    avgTimeInSystem,
  };
}

/**
 * Run a full simulation from a config. Deterministic in `config.seed`.
 *
 * Note on determinism: we draw ALL arrivals first (consuming the RNG stream),
 * then draw service times. Because both the arrival generator and the service
 * sampler pull from the same seeded stream in a fixed order, an identical config
 * yields identical results — the property the "re-run / seed" controls rely on.
 */
export function runSimulation(config: SimConfig): SimResult {
  const rng = new Rng(config.seed);

  const arrivals = generateArrivals(
    rng,
    config.arrivalProfile,
    config.horizonMinutes,
    config.volumeMultiplier,
  );

  const serviceTimes = arrivals.map(() =>
    sampleServiceTime(rng, config.serviceMeanMinutes, config.serviceStdMinutes),
  );

  const passengers = simulateQueue(arrivals, serviceTimes, config.numLanes);
  const timeSeries = buildTimeSeries(
    passengers,
    config.horizonMinutes,
    config.resolutionMinutes,
  );
  const summary = buildSummary(passengers, config, timeSeries);

  return { config, passengers, timeSeries, summary };
}

/** A sensible default configuration, also used as the UI's starting point. */
export const DEFAULT_CONFIG: SimConfig = {
  horizonMinutes: 240, // 4-hour window
  resolutionMinutes: 2,
  numLanes: 6,
  arrivalProfile: 'morningPeak',
  volumeMultiplier: 1,
  serviceMeanMinutes: 0.6, // ~36s mean screening time per passenger
  serviceStdMinutes: 0.45, // right-skewed: many quick, some slow
  seed: 42,
};
