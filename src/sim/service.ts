/**
 * Service-time distribution for a single screening lane.
 *
 * WHY LOGNORMAL (and not normal):
 * Real screening times are right-skewed. The large majority of passengers clear
 * in a short, fairly consistent time, but a meaningful tail takes much longer:
 * a bag needs a secondary search, a passenger forgets a laptop, a pat-down is
 * required. A normal distribution is wrong for two reasons — it is symmetric
 * (no long tail) and it assigns positive probability to negative service times,
 * which is nonsensical. The lognormal is strictly positive and skewed, so it
 * captures "usually quick, occasionally very slow" behavior that dominates
 * queue dynamics: it is the slow tail, not the mean, that builds the line.
 */

import { Rng } from './random';

/**
 * Convert a desired real-space mean and standard deviation into the underlying
 * lognormal parameters (mu, sigma of the associated normal).
 *
 * If X ~ Lognormal(mu, sigma):
 *   mean = exp(mu + sigma^2 / 2)
 *   var  = (exp(sigma^2) - 1) * exp(2*mu + sigma^2)
 * Inverting these for mu and sigma given a target mean m and std s:
 *   sigma^2 = ln(1 + (s/m)^2)
 *   mu      = ln(m) - sigma^2 / 2
 */
export function lognormalParams(mean: number, std: number): { mu: number; sigma: number } {
  const variance = std * std;
  const sigmaSq = Math.log(1 + variance / (mean * mean));
  const sigma = Math.sqrt(sigmaSq);
  const mu = Math.log(mean) - sigmaSq / 2;
  return { mu, sigma };
}

/** Draw a single service time (in minutes) from Lognormal(mean, std). */
export function sampleServiceTime(rng: Rng, mean: number, std: number): number {
  const { mu, sigma } = lognormalParams(mean, std);
  return Math.exp(mu + sigma * rng.standardNormal());
}
