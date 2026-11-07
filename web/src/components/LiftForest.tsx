import { AxisBottom } from '@visx/axis';
import { scaleLinear } from '@visx/scale';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import type { ExperimentReport } from '../api';
import { pValue, signedPct } from '../format';
import { useWidth } from '../lib/useWidth';

const ROW = 56;
const PAD = { top: 8, bottom: 28 };

/**
 * Each treatment's relative lift vs control, with its confidence interval.
 * An interval that crosses the zero line is indistinguishable from no change.
 */
export function LiftForest({ report }: { report: ExperimentReport }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const rows = report.variants.filter((v) => !v.isControl && v.comparison?.relativeLiftInterval);
  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-fg-muted">Lift appears once both variants have conversions.</p>;
  }

  const labelW = Math.min(140, Math.max(96, width * 0.24));
  const valueW = 72;
  const extent = Math.max(0.02, ...rows.flatMap((r) => r.comparison!.relativeLiftInterval!.map(Math.abs))) * 1.15;
  const x = scaleLinear({ domain: [-extent, extent], range: [labelW, Math.max(labelW + 80, width - valueW)], nice: true });
  const height = PAD.top + rows.length * ROW + PAD.bottom;
  const zero = x(0);

  return (
    <div ref={ref} className="relative w-full min-w-0">
      <svg width={width} height={height} role="img" aria-label="Relative lift versus control with confidence intervals">
        {x.ticks(5).map((t) => (
          <line key={t} x1={x(t)} x2={x(t)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--grid)" />
        ))}
        <line x1={zero} x2={zero} y1={PAD.top - 4} y2={height - PAD.bottom} stroke="var(--fg-faint)" strokeDasharray="3 3" />

        {rows.map((row, i) => {
          const c = row.comparison!;
          const [low, high] = c.relativeLiftInterval!;
          const y = PAD.top + i * ROW + ROW / 2;
          const color = !c.significant ? 'var(--fg-muted)' : c.absoluteLift > 0 ? 'var(--good)' : 'var(--bad)';
          const dim = hover !== null && hover !== row.variant;
          return (
            <g
              key={row.variant}
              opacity={dim ? 0.35 : 1}
              style={{ transition: 'opacity 150ms' }}
              onMouseEnter={() => setHover(row.variant)}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={0} y={y - ROW / 2} width={width} height={ROW} fill="transparent" />
              <text x={0} y={y + 4} className="fill-fg text-[13px] font-medium">
                {row.variant.length > 16 ? `${row.variant.slice(0, 15)}…` : row.variant}
              </text>
              <motion.rect
                y={y - 3}
                height={6}
                rx={3}
                fill={color}
                fillOpacity={0.22}
                initial={{ x: zero, width: 0 }}
                animate={{ x: x(low), width: Math.max(2, x(high) - x(low)) }}
                transition={{ type: 'spring', bounce: 0, duration: 0.8, delay: i * 0.06 }}
              />
              <motion.circle
                cy={y}
                r={7}
                fill={color}
                stroke="var(--surface)"
                strokeWidth={2.5}
                initial={{ cx: zero }}
                animate={{ cx: x(c.relativeLift!) }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.8, delay: i * 0.06 }}
              />
              <text x={width} y={y + 4} textAnchor="end" className="tabular fill-fg text-[13px] font-semibold">
                {signedPct(c.relativeLift!)}
              </text>
            </g>
          );
        })}

        <AxisBottom
          top={height - PAD.bottom}
          scale={x}
          numTicks={5}
          hideAxisLine
          hideTicks
          tickFormat={(v) => signedPct(Number(v), 0)}
          tickLabelProps={{ fill: 'var(--fg-faint)', fontSize: 11, textAnchor: 'middle', fontFamily: 'inherit' }}
        />
      </svg>

      {hover &&
        (() => {
          const i = rows.findIndex((r) => r.variant === hover);
          const c = rows[i]!.comparison!;
          const Icon = !c.significant ? Minus : c.absoluteLift > 0 ? ArrowUpRight : ArrowDownRight;
          return (
            <div
              className="pointer-events-none absolute z-10 w-56 rounded-xl border border-border bg-surface-raised p-3 text-xs shadow-pop"
              style={{ left: Math.min(Math.max(0, x(c.relativeLift!) - 112), width - 224), top: PAD.top + (i + 1) * ROW - 6 }}
            >
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
                <Icon className="size-3.5" /> {hover} {c.significant ? '· significant' : '· not significant'}
              </div>
              <Line k="Lift" v={signedPct(c.relativeLift!)} />
              <Line k="Interval" v={`${signedPct(c.relativeLiftInterval![0])} to ${signedPct(c.relativeLiftInterval![1])}`} />
              <Line k="p-value" v={pValue(c.pValue)} />
            </div>
          );
        })()}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-fg-muted">{k}</span>
      <span className="tabular font-medium">{v}</span>
    </div>
  );
}
