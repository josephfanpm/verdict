export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
export const signedPct = (x: number, digits = 1) => `${x >= 0 ? '+' : ''}${pct(x, digits)}`;
export const num = (x: number) => x.toLocaleString('en-US');
export const pValue = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3));
/** A metric's value: a rate for yes/no metrics, a plain number for per-user averages and ratios. */
export const metricValue = (kind: 'conversion' | 'mean' | 'ratio', v: number) =>
  kind === 'conversion' ? pct(v, 2) : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dayCount = (d: number) => (d >= 10 ? Math.round(d).toString() : (Math.floor(d * 10) / 10).toString());
export const shortDate = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** NumberFlow format presets. */
export const PERCENT_FORMAT = { style: 'percent', maximumFractionDigits: 1, minimumFractionDigits: 1 } as const;
export const SIGNED_PERCENT_FORMAT = { ...PERCENT_FORMAT, signDisplay: 'exceptZero' } as const;

export function timeAgo(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const units: Array<[number, string]> = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** CSS color for a variant by its position: control is neutral, treatments take fixed categorical slots. */
export const seriesColor = (index: number) => `var(--series-${Math.min(index, 4)})`;
