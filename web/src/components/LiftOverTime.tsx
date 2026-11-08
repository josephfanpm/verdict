import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TimeseriesPoint } from '../api';
import { num, seriesColor, shortDate, signedPct } from '../format';

/**
 * Cumulative lift with its confidence band, per treatment. The band starts
 * wide and narrows as data arrives, which is why early results can't be trusted.
 */
export function LiftOverTime({ points, variants }: { points: TimeseriesPoint[]; variants: string[] }) {
  // Stable identities matter: Recharts restarts its entry animation whenever data or keys change.
  const variantKey = variants.join('|');
  const treatments = useMemo(() => variantKey.split('|').slice(1), [variantKey]);

  const data = useMemo(
    () =>
      points.map((p) => {
        const row: Record<string, number | [number, number] | null> = { ts: p.ts, users: Object.values(p.exposures).reduce((a, b) => a + b, 0) };
        for (const t of treatments) {
          const l = p.lift[t];
          row[t] = l ? l.value : null;
          row[`band_${t}`] = l ? [l.low, l.high] : null;
        }
        return row;
      }),
    [points, treatments]
  );

  // Scale to the settled part of the run: the first few buckets have huge intervals that would flatten the rest.
  const domain = useMemo(() => {
    const settled = points.slice(Math.floor(points.length * 0.2));
    const values = settled.flatMap((p) => treatments.flatMap((t) => (p.lift[t] ? [p.lift[t]!.low, p.lift[t]!.high] : [])));
    const raw = Math.max(0.02, ...values.map(Math.abs)) * 1.05;
    // Round to a clean step so ticks land on whole percentages.
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1].find((s) => raw / s <= 3) ?? 1;
    const max = Math.ceil(raw / step) * step;
    return { domain: [-max, max] as [number, number], ticks: [-2, -1, 0, 1, 2].map((k) => (k * max) / 2) };
  }, [points, treatments]);

  if (data.length < 2) return <p className="py-10 text-center text-sm text-fg-muted">Not enough history yet.</p>;

  return (
    <div>
      {treatments.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-4 text-[13px] text-fg-muted">
          {treatments.map((t, i) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full" style={{ background: seriesColor(i + 1) }} />
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={shortDate}
              tick={{ fill: 'var(--fg-faint)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={domain.domain}
              ticks={domain.ticks}
              allowDataOverflow
              tickFormatter={(v: number) => signedPct(v, 0)}
              tick={{ fill: 'var(--fg-faint)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <ReferenceLine y={0} stroke="var(--fg-faint)" strokeDasharray="3 3" />
            {treatments.map((t, i) => (
              <Area
                key={`band_${t}`}
                dataKey={`band_${t}`}
                type="monotone"
                stroke="none"
                fill={seriesColor(i + 1)}
                fillOpacity={treatments.length > 1 ? 0.1 : 0.16}
                // Recharts' clip-reveal for range areas can stall at zero width, so the band appears instantly.
                isAnimationActive={false}
                connectNulls
                activeDot={false}
              />
            ))}
            {treatments.map((t, i) => (
              <Line
                key={t}
                dataKey={t}
                type="monotone"
                stroke={seriesColor(i + 1)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--surface)' }}
                connectNulls
                animationDuration={700}
              />
            ))}
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]!.payload as Record<string, number | [number, number] | null>;
                return (
                  <div className="min-w-48 rounded-xl border border-border bg-surface-raised p-3 text-xs shadow-pop">
                    <div className="mb-1.5 flex justify-between gap-4 text-fg-muted">
                      <span>{shortDate(Number(label))}</span>
                      <span className="tabular">{num(Number(row.users))} users</span>
                    </div>
                    {treatments.map((t, i) => {
                      const v = row[t] as number | null;
                      const band = row[`band_${t}`] as [number, number] | null;
                      return (
                        <div key={t} className="flex items-center justify-between gap-4 py-0.5">
                          <span className="flex items-center gap-1.5">
                            <span className="size-2 rounded-full" style={{ background: seriesColor(i + 1) }} />
                            {t}
                          </span>
                          <span className="tabular font-medium">
                            {v === null ? '–' : signedPct(v)}
                            {band && (
                              <span className="ml-1.5 font-normal text-fg-faint">
                                {signedPct(band[0], 0)} to {signedPct(band[1], 0)}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
