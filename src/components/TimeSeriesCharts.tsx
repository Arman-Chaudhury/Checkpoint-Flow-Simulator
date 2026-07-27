import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TimeSeriesPoint } from '../simulation/simulation';

/*
 * Chart chrome + series colors. The two series colors are the first two slots
 * of a colorblind-validated categorical order (blue for the live scenario,
 * orange for the pinned one); the pinned line is additionally dashed so the
 * distinction never rests on hue alone.
 */
const COLOR_CURRENT = '#2a78d6';
const COLOR_PINNED = '#eb6834';
const COLOR_GRID = '#e1e0d9';
const COLOR_AXIS = '#898781';

const AXIS_TICK = { fill: COLOR_AXIS, fontSize: 12 } as const;

interface ChartProps {
  title: string;
  dataKey: 'avgWait' | 'queueLength';
  yLabel: string;
  valueFormatter: (v: number) => string;
  current: TimeSeriesPoint[];
  pinned: TimeSeriesPoint[] | null;
}

function xTicks(maxT: number): number[] {
  const step = maxT <= 180 ? 30 : 60;
  const ticks: number[] = [];
  for (let t = 0; t <= maxT; t += step) ticks.push(t);
  return ticks;
}

function SeriesChart({
  title,
  dataKey,
  yLabel,
  valueFormatter,
  current,
  pinned,
}: ChartProps) {
  const maxT = Math.max(
    current.length ? current[current.length - 1].t : 0,
    pinned && pinned.length ? pinned[pinned.length - 1].t : 0,
  );

  return (
    <div className="chart">
      <h2>{title}</h2>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={COLOR_GRID} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={[0, maxT]}
            ticks={xTicks(maxT)}
            tick={AXIS_TICK}
            stroke={COLOR_GRID}
            label={{
              value: 'Minutes from start of window',
              position: 'insideBottom',
              offset: -2,
              fill: COLOR_AXIS,
              fontSize: 12,
            }}
            height={40}
          />
          <YAxis
            tick={AXIS_TICK}
            stroke={COLOR_GRID}
            width={48}
            label={{
              value: yLabel,
              angle: -90,
              position: 'insideLeft',
              fill: COLOR_AXIS,
              fontSize: 12,
            }}
            allowDecimals={false}
          />
          <Tooltip
            formatter={(value: number | string) => valueFormatter(Number(value))}
            labelFormatter={(t) => `minute ${t}`}
            contentStyle={{ fontSize: 13, borderColor: COLOR_GRID }}
          />
          {pinned && <Legend verticalAlign="top" height={28} />}
          {pinned && (
            <Line
              data={pinned}
              dataKey={dataKey}
              name="Pinned"
              type="monotone"
              stroke={COLOR_PINNED}
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          <Line
            data={current}
            dataKey={dataKey}
            name="Current"
            type="monotone"
            stroke={COLOR_CURRENT}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface Props {
  current: TimeSeriesPoint[];
  pinned: TimeSeriesPoint[] | null;
}

export default function TimeSeriesCharts({ current, pinned }: Props) {
  return (
    <section className="charts" aria-label="Simulation time series">
      <SeriesChart
        title="Average wait by minute of arrival"
        dataKey="avgWait"
        yLabel="Wait (min)"
        valueFormatter={(v) => `${v.toFixed(1)} min`}
        current={current}
        pinned={pinned}
      />
      <SeriesChart
        title="Queue length over time"
        dataKey="queueLength"
        yLabel="Passengers in queue"
        valueFormatter={(v) => `${Math.round(v)} passengers`}
        current={current}
        pinned={pinned}
      />
    </section>
  );
}
