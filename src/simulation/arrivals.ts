/**
 * Passenger arrival process.
 *
 * Arrivals are modeled as a NON-HOMOGENEOUS POISSON PROCESS: a Poisson process
 * whose instantaneous rate lambda(t) varies over the day. This is the standard,
 * realistic model for arrivals to a service system — memoryless, "bursty" in the
 * right way, and reproducing the empirical fact that the *number* of arrivals in
 * a window is Poisson-distributed while individual arrivals are independent.
 *
 * The rate lambda(t) is expressed in passengers-per-minute and depends on the
 * chosen arrival profile below. A global volume multiplier scales every profile
 * up or down so the user can ask "what if traffic were 30% heavier?".
 */

import { Rng } from './random';

export type ArrivalProfile = 'steady' | 'morningPeak' | 'bimodal';

export interface ProfileMeta {
  id: ArrivalProfile;
  label: string;
  description: string;
}

export const ARRIVAL_PROFILES: ProfileMeta[] = [
  {
    id: 'steady',
    label: 'Steady baseline',
    description: 'Constant demand across the window — a well-spread schedule.',
  },
  {
    id: 'morningPeak',
    label: 'Morning bank',
    description:
      'A sharp cluster of departures — many flights pushing back in a short window drives a spike in arrivals.',
  },
  {
    id: 'bimodal',
    label: 'Morning + afternoon',
    description: 'Two departure banks separated by a midday lull.',
  },
];

/**
 * A Gaussian "bump" used to build peaks. `height` is the peak rate contributed
 * at the center, `center` is the time of the peak (minutes), `width` controls
 * how sharp the bank is (minutes; roughly the standard deviation).
 */
function bump(t: number, center: number, width: number, height: number): number {
  const z = (t - center) / width;
  return height * Math.exp(-0.5 * z * z);
}

/**
 * The instantaneous arrival rate (passengers/min) for a profile at time `t`
 * (minutes from the start of the window), before the volume multiplier.
 *
 * These shapes are illustrative but chosen to be operationally realistic:
 *  - steady:      flat demand.
 *  - morningPeak: low baseline with one tall, narrow bank ~45 min in.
 *  - bimodal:     two banks (morning + early afternoon) over a longer window.
 *
 * `horizon` lets the peaks scale to the configured window length so the shape
 * stays sensible whether the user simulates 2 hours or 6.
 */
export function baseArrivalRate(
  profile: ArrivalProfile,
  t: number,
  horizon: number,
): number {
  switch (profile) {
    case 'steady':
      return 6; // ~6 pax/min ≈ 360 pax/hour of steady demand.

    case 'morningPeak': {
      // Low background traffic plus one sharp bank about a fifth of the way in.
      const baseline = 1.5;
      const peak = bump(t, horizon * 0.22, horizon * 0.06, 22);
      return baseline + peak;
    }

    case 'bimodal': {
      const baseline = 1.5;
      const morning = bump(t, horizon * 0.22, horizon * 0.06, 16);
      const afternoon = bump(t, horizon * 0.68, horizon * 0.07, 13);
      return baseline + morning + afternoon;
    }
  }
}

/**
 * Generate arrival timestamps (minutes, sorted ascending) over [0, horizon)
 * using Lewis & Shedler's THINNING algorithm for a non-homogeneous Poisson
 * process:
 *
 *   1. Bound the rate with lambdaMax = max over the window of lambda(t).
 *   2. Generate candidate points as a homogeneous Poisson process at lambdaMax.
 *   3. Keep each candidate at time t with probability lambda(t)/lambdaMax.
 *
 * The kept points are exactly a realization of the non-homogeneous process.
 * This is preferred over naively bucketing time into slices because it is exact
 * (no discretization error) and still simple.
 */
export function generateArrivals(
  rng: Rng,
  profile: ArrivalProfile,
  horizon: number,
  volumeMultiplier: number,
): number[] {
  // Find an upper bound for the rate by sampling the profile densely. The
  // profiles are smooth, so a fine grid gives a safe bound; we pad it slightly.
  let lambdaMax = 0;
  const steps = 1000;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * horizon;
    const rate = baseArrivalRate(profile, t, horizon) * volumeMultiplier;
    if (rate > lambdaMax) lambdaMax = rate;
  }
  lambdaMax *= 1.05; // small safety margin against grid-missed maxima
  if (lambdaMax <= 0) return [];

  const arrivals: number[] = [];
  let t = 0;
  while (true) {
    // Time to the next candidate under the dominating homogeneous process.
    t += rng.exponential(lambdaMax);
    if (t >= horizon) break;
    // Thinning: accept this candidate with prob lambda(t)/lambdaMax.
    const rate = baseArrivalRate(profile, t, horizon) * volumeMultiplier;
    if (rng.next() < rate / lambdaMax) {
      arrivals.push(t);
    }
  }
  return arrivals;
}
