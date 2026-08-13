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
 * CALIBRATION — the magnitudes are derived from the Port Authority of NY & NJ
 * 2024 Annual Airport Traffic Report (panynj.gov, Airport Traffic Statistics):
 *
 *  - The modeled facility is one mid-size checkpoint handling roughly half of
 *    a terminal like LaGuardia's Terminal C. ATR table 2.5.1 puts Terminal C
 *    at 13.99M passengers in 2024, of which ~7.03M departing (outbound) —
 *    about 19,200 departures/day, so ~9,600/day through this checkpoint.
 *  - Spread over a ~17.5-hour operating day that is ~9 pax/min on average,
 *    which sets the `steady` baseline.
 *  - Airports plan staffing around a design peak hour of roughly 9–10% of
 *    daily volume (~900+/hour here), and minute-level arrivals inside a
 *    departure bank crest above that hourly average — hence the morning bank
 *    peaking near 20 pax/min over a quieter ~6 pax/min shoulder.
 *  - Seasonality is left to the volume multiplier: July 2024, the region's
 *    busiest-ever month at 13.7M passengers, ran ~9% above an average 2024
 *    month — i.e. a ×1.1 setting. The slider's upper range covers holiday
 *    surges and growth scenarios.
 *
 * Shapes:
 *  - steady:      flat demand — a well-spread schedule at the daily average.
 *  - morningPeak: quiet shoulder plus one tall bank (~1.5 h wide) a fifth of
 *                 the way into the window.
 *  - bimodal:     morning bank + slightly smaller afternoon bank.
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
      return 9; // ~9 pax/min ≈ 540 pax/hour — the calibrated all-day average.

    case 'morningPeak': {
      // Off-peak shoulder traffic plus one departure bank about a fifth of
      // the way in, cresting near the calibrated ~20 pax/min.
      const baseline = 6;
      const peak = bump(t, horizon * 0.22, horizon * 0.075, 14);
      return baseline + peak;
    }

    case 'bimodal': {
      const baseline = 5;
      const morning = bump(t, horizon * 0.22, horizon * 0.06, 13);
      const afternoon = bump(t, horizon * 0.68, horizon * 0.07, 10);
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
