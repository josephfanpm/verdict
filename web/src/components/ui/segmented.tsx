import { motion } from 'motion/react';
import { useId } from 'react';
import { cn } from '../../lib/utils';

/** Segmented control with a sliding selection pill. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  className?: string;
  label: string;
}) {
  const id = useId();
  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex max-w-full overflow-x-auto rounded-full bg-bg-subtle p-1 ring-1 ring-inset ring-border', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition-colors',
              active ? 'text-fg' : 'text-fg-muted hover:text-fg'
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-full bg-surface-raised shadow-[0_1px_3px_rgb(0_0_0/0.1)] ring-1 ring-border"
                transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {o.label}
              {o.count !== undefined && <span className="tabular text-fg-faint">{o.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
