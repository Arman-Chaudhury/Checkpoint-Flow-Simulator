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
 * This is an EVENT-DRIVEN simulation, not a frame-by-frame animation. Time is
 * never advanced by a fixed dt; instead the loop maintains an event list of the
 * only two things that change system state — passenger arrivals and service
 * completions — and jumps directly from one event to the next. Between events
 * nothing happens, so every timestamp is exact rather than rounded to a frame,
 * and a quiet stretch costs nothing to simulate.
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
  /**
   * Hard cap on simulated passengers. Extreme volume settings could otherwise
   * generate an unbounded number of arrivals and freeze the browser tab; the
   * cap keeps the UI responsive, and the result carries a flag so the UI can
   * tell the user the run was truncated.
   */
  maxPassengers: number;
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
  /** Every passenger who arrived during the window. */
  totalArrivals: number;
  /** Passengers whose screening FINISHED within the window. */
  totalProcessed: number;
  /**
   * Passengers still queued or mid-screening when the window closed. By
   * conservation, totalProcessed + stillInSystemAtHorizon = totalArrivals —
   * the model neither creates nor loses passengers, which the tests assert.
   */
  stillInSystemAtHorizon: number;
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
  /** True if the run hit config.maxPassengers and arrivals were truncated. */
  capped: boolean;
}

/**
 * Core discrete-event loop, decoupled from arrival/service *generation* so it
 * can be driven by known inputs in unit tests.
 *
 * Given passenger arrival times (must be sorted ascending) and their service
 * durations, run the single-queue / multi-lane checkpoint and return the
 * fully-resolved passenger records.
 *
 * EVENT LIST: two event types drive the system.
 *   - Arrival events are known upfront: the sorted `arrivals` array IS the
 *     arrival half of the event list, consumed through an index cursor.
 *   - Service-completion events are scheduled when a passenger starts service.
 *     At most one screening is in progress per lane, so there are never more
 *     than `numLanes` pending completions — a per-lane completion-time array
 *     scanned for its minimum is the simplest correct priority structure here
 *     (a heap would buy nothing at this size).
 *
 * The loop repeatedly takes whichever pending event is earliest and applies it:
 *   - completion: the lane frees; if anyone is queued, the head of the shared
 *     FIFO queue starts service on that lane at the completion timestamp.
 *   - arrival: if a lane is idle (and nobody is queued ahead), service starts
 *     immediately; otherwise the passenger joins the tail of the queue.
 * Completions are processed before arrivals at identical timestamps, and lane
 * ties resolve to the lowest lane index, so runs are fully deterministic.
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

  const n = arrivals.length;
  const passengers = new Array<Passenger>(n);

  // Pending completion events: completionAt[k] = when lane k finishes its
  // current passenger, or Infinity if lane k is idle.
  const completionAt = new Array<number>(numLanes).fill(Infinity);
  let lanesBusy = 0;

  // The shared FIFO queue, as passenger indices with a head cursor (a cursor
  // avoids O(n) Array.shift when the queue grows long).
  const queue: number[] = [];
  let queueHead = 0;

  let nextArrival = 0; // cursor into the arrival event list

  const startService = (i: number, lane: number, t: number) => {
    const serviceEnd = t + serviceTimes[i];
    completionAt[lane] = serviceEnd;
    lanesBusy++;
    passengers[i] = {
      id: i,
      arrival: arrivals[i],
      serviceStart: t,
      serviceEnd,
      lane,
      wait: t - arrivals[i],
      timeInSystem: serviceEnd - arrivals[i],
    };
  };

  while (nextArrival < n || lanesBusy > 0) {
    // Earliest pending completion event (ties -> lowest lane index).
    let completionLane = -1;
    let completionTime = Infinity;
    for (let k = 0; k < numLanes; k++) {
      if (completionAt[k] < completionTime) {
        completionTime = completionAt[k];
        completionLane = k;
      }
    }

    const arrivalTime = nextArrival < n ? arrivals[nextArrival] : Infinity;

    if (completionTime <= arrivalTime) {
      // COMPLETION EVENT: the lane frees; pull the head of the queue if any.
      completionAt[completionLane] = Infinity;
      lanesBusy--;
      if (queueHead < queue.length) {
        startService(queue[queueHead++], completionLane, completionTime);
      }
    } else {
      // ARRIVAL EVENT: start immediately on the lowest-index idle lane, or
      // join the tail of the shared queue.
      const i = nextArrival++;
      if (lanesBusy < numLanes && queueHead === queue.length) {
        startService(i, completionAt.indexOf(Infinity), arrivalTime);
      } else {
        queue.push(i);
      }
    }
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
 *
 * The instantaneous counts come from a three-cursor sweep over the sorted
 * arrival / service-start / service-end times: at any t, (arrivals so far) −
 * (starts so far) is the queue and (arrivals so far) − (ends so far) is the
 * system population. O(n log n) total instead of O(n · buckets).
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

  // Arrivals are already sorted; service starts and ends are not guaranteed to
  // be (a later arrival can start on another lane before an earlier passenger
  // finishes), so sort both.
  const arrivalTimes = passengers.map((p) => p.arrival);
  const startTimes = passengers.map((p) => p.serviceStart).sort((a, b) => a - b);
  const endTimes = passengers.map((p) => p.serviceEnd).sort((a, b) => a - b);
  let ai = 0; // count of arrivals with time <= t
  let si = 0; // count of service starts with time <= t
  let ei = 0; // count of service ends with time <= t

  for (let i = 0; i <= numBuckets; i++) {
    const t = i * resolution;

    while (ai < arrivalTimes.length && arrivalTimes[ai] <= t) ai++;
    while (si < startTimes.length && startTimes[si] <= t) si++;
    while (ei < endTimes.length && endTimes[ei] <= t) ei++;

    const queueLength = ai - si;
    const inSystem = ai - ei;

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
      totalArrivals: 0,
      totalProcessed: 0,
      stillInSystemAtHorizon: 0,
      avgWait: 0,
      p95Wait: 0,
      maxWait: 0,
      maxQueueLength: 0,
      avgUtilization: 0,
      avgTimeInSystem: 0,
    };
  }

  const horizon = config.horizonMinutes;

  // Wait statistics are computed over EVERY arrival, including passengers whose
  // screening spills past the horizon — dropping them would understate exactly
  // the congestion this tool exists to show.
  const waits = passengers.map((p) => p.wait);
  const avgWait = waits.reduce((a, b) => a + b, 0) / n;
  const avgTimeInSystem =
    passengers.reduce((a, p) => a + p.timeInSystem, 0) / n;

  const totalProcessed = passengers.filter((p) => p.serviceEnd <= horizon).length;

  // Utilization = busy lane-minutes / total available lane-minutes over the
  // window. We only count service that falls within [0, horizon] so a job that
  // spills past the end of the window doesn't inflate the number.
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
    totalArrivals: n,
    totalProcessed,
    stillInSystemAtHorizon: n - totalProcessed,
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

  let arrivals = generateArrivals(
    rng,
    config.arrivalProfile,
    config.horizonMinutes,
    config.volumeMultiplier,
  );

  const capped = arrivals.length > config.maxPassengers;
  if (capped) arrivals = arrivals.slice(0, config.maxPassengers);

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

  return { config, passengers, timeSeries, summary, capped };
}

/** A sensible default configuration, also used as the UI's starting point. */
export const DEFAULT_CONFIG: SimConfig = {
  horizonMinutes: 240, // 4-hour window
  resolutionMinutes: 1, // per-minute buckets for the output series
  numLanes: 6,
  arrivalProfile: 'morningPeak',
  volumeMultiplier: 1,
  serviceMeanMinutes: 0.6, // ~36s mean screening time per passenger
  serviceStdMinutes: 0.45, // right-skewed: many quick, some slow
  seed: 42,
  maxPassengers: 20000,
};
