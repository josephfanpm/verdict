import type { ExperimentReport } from './api';
import { signedPct } from './format';

/**
 * Forest plot of each treatment's relative lift vs control, with its
 * confidence interval. If a bar crosses the zero line, the result is not
 * statistically distinguishable from "no change".
 */
export function LiftChart({ report }: { report: ExperimentReport }) {
  const rows = report.variants.filter((v) => !v.isControl && v.comparison?.relativeLiftInterval);
  if (rows.length === 0) return null;

  const lows = rows.map((r) => r.comparison!.relativeLiftInterval![0]);
  const highs = rows.map((r) => r.comparison!.relativeLiftInterval![1]);
  const span = Math.max(Math.abs(Math.min(0, ...lows)), Math.abs(Math.max(0, ...highs)), 0.02) * 1.15;

  const width = 560;
  const labelWidth = 120;
  const plotWidth = width - labelWidth - 20;
  const rowHeight = 40;
  const height = rows.length * rowHeight + 34;
  const x = (value: number) => labelWidth + ((value + span) / (2 * span)) * plotWidth;
  const ticks = [-span, -span / 2, 0, span / 2, span].map((t) => Math.round(t * 1000) / 1000);

  return (
    <figure className="lift-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Relative lift versus control with confidence intervals">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={6} y2={height - 26} className={t === 0 ? 'axis-zero' : 'grid'} />
            <text x={x(t)} y={height - 8} textAnchor="middle" className="tick">
              {signedPct(t, 0)}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const c = row.comparison!;
          const [low, high] = c.relativeLiftInterval!;
          const y = 12 + i * rowHeight + rowHeight / 2;
          const tone = !c.significant ? 'neutral' : c.absoluteLift > 0 ? 'good' : 'bad';
          return (
            <g key={row.variant} className={`lift-${tone}`}>
              <text x={labelWidth - 10} y={y + 4} textAnchor="end" className="row-label">
                {row.variant}
              </text>
              <line x1={x(low)} x2={x(high)} y1={y} y2={y} className="ci" />
              <line x1={x(low)} x2={x(low)} y1={y - 6} y2={y + 6} className="ci" />
              <line x1={x(high)} x2={x(high)} y1={y - 6} y2={y + 6} className="ci" />
              <circle cx={x(c.relativeLift!)} cy={y} r={5.5} className="point" />
              <title>{`${row.variant}: ${signedPct(c.relativeLift!)} (CI ${signedPct(low)} to ${signedPct(high)})`}</title>
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small">
        Relative lift vs control with {Math.round((1 - report.alpha) * 1000) / 10}% confidence intervals. Bars that cross 0 are not significant.
      </figcaption>
    </figure>
  );
}
