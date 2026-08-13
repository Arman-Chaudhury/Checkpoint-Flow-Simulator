# Checkpoint Flow Simulator

I built this browser-based simulator to answer a practical staffing question:
what actually happens to airport security wait times when you open one more
screening lane during a departure bank? It models passenger flow through a
checkpoint as a discrete-event simulation — Poisson arrivals, a single shared
queue, lognormal screening times — and lets you drag the staffing and demand
levers while the wait-time and queue-length charts respond instantly. Pin a
scenario, change a setting, and the two runs render side by side. Everything
runs client-side; there is no backend.

## Why this model

**Discrete events, not animation.** The engine never advances time by a fixed
tick. Only two things change the state of a checkpoint — a passenger arriving
and a screening finishing — so the simulation keeps an event list of exactly
those and jumps from one event to the next. Every timestamp is exact, and a
quiet half hour costs nothing to simulate.

**Non-homogeneous Poisson arrivals.** Passengers don't show up on a schedule;
they trickle in independently, at a rate that swells before a bank of
departures and fades after. That is precisely a Poisson process with a
time-varying rate λ(t). I generate it with Lewis & Shedler's thinning
algorithm, which is exact — no discretization of time into buckets. Three
built-in profiles (steady, single morning bank, bimodal) plus a volume
multiplier cover the interesting demand shapes.

**Calibrated to real traffic data.** The profile magnitudes are derived from
the Port Authority of NY & NJ's [2024 Annual Airport Traffic
Report](https://www.panynj.gov/airports/en/statistics-general-info.html). The
modeled facility is a mid-size checkpoint handling about half of a terminal
like LaGuardia's Terminal C, which the report puts at ~7.03 million departing
passengers in 2024 — roughly 19,200 per day, so ~9,600/day through this
checkpoint. Spread over a ~17.5-hour operating day that averages ~9
passengers/minute (the steady baseline), and with the standard planning
assumption that the design peak hour carries 9–10% of daily volume, the
morning bank crests near 20 passengers/minute. Seasonality maps onto the
volume slider: LGA's peak month runs about 9–10% above its average month — a
×1.1 setting.

I anchored the calibration to 2024 deliberately: it was the record year (145.9
million passengers regionwide), and a staffing model should be sized against
the busiest realistic demand — the design load — not an off year. The 2025
edition of the report validates that choice: even as regional traffic eased to
142.7 million during Newark's runway rehabilitation, Terminal C's departing
volume held within 0.1% of the 2024 figure, and the region set a new
single-month record (13.8 million, August 2025). The full derivation is
documented in `src/simulation/arrivals.ts`.

**Lognormal service times.** Most passengers clear screening quickly and
consistently; a meaningful few take far longer — the forgotten laptop, the bag
search, the pat-down. Screening time is therefore right-skewed, which a normal
distribution can't represent (it's symmetric and admits negative times). The
lognormal is strictly positive and long-tailed, and that tail matters: it is
the occasional slow screening, not the average one, that builds the line.

**The 95th-percentile wait is the headline number.** Averages hide the pain.
An average wait of 4 minutes is compatible with 1 passenger in 20 waiting 25
minutes and missing a flight. Operations teams plan staffing against the tail,
so the p95 card is the most prominent stat in the UI. The lane slider makes
the key dynamic visible: near saturation, one extra lane collapses the p95
non-linearly; once the checkpoint is comfortably staffed, another lane buys
almost nothing.

## Running it

```bash
npm install
npm run dev     # local dev server
npm test        # engine unit tests (Vitest)
npm run build   # production build
```

## Model assumptions and limitations

- **Single shared queue.** One FIFO line feeds all lanes (which is both what
  modern checkpoints do and what minimizes wait). Per-lane queues with jockeying
  are not modeled.
- **No reneging or balking.** Every passenger joins the queue and stays until
  screened, however long the line gets.
- **Stationary service distribution.** Screening times are i.i.d. lognormal;
  lanes don't slow down when the hall is crowded, officers don't fatigue, and
  no lane opens or closes mid-run.
- **Identical lanes.** No dedicated PreCheck/priority lanes and no passenger
  classes.
- **Seeded randomness.** Every run is deterministic in the seed (a mulberry32
  PRNG drives all sampling), so any result you see can be reproduced exactly —
  and the scenario comparison is apples to apples on the same draw.
- **Truncation cap.** Extreme settings cap the run at 20,000 passengers to keep
  the browser responsive; the UI flags when a run was truncated.
- **Calibration is scale, not schedule.** The Port Authority data pins the
  realistic *magnitude* of demand (passengers per day through a checkpoint);
  the minute-by-minute *shape* of each profile is a modeling choice, since
  published statistics are monthly, not per-minute.

MIT licensed.
