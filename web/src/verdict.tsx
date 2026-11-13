import { CircleCheck, CircleDashed, Equal, Hourglass, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import type { VerdictKind } from './api';
import { cn } from './lib/utils';

interface VerdictMeta {
  label: string;
  icon: LucideIcon;
  /** Text color class. */
  text: string;
  /** Tinted background class. */
  bg: string;
  /** Short, human description used in filters and tooltips. */
  hint: string;
}

export const VERDICT: Record<VerdictKind, VerdictMeta> = {
  SHIP: { label: 'Ship it', icon: CircleCheck, text: 'text-good', bg: 'bg-good-bg', hint: 'A winner, with guardrails intact' },
  DONT_SHIP: { label: "Don't ship", icon: OctagonX, text: 'text-bad', bg: 'bg-bad-bg', hint: 'A treatment hurts the goal or a guardrail' },
  INVESTIGATE: { label: 'Investigate', icon: TriangleAlert, text: 'text-warn', bg: 'bg-warn-bg', hint: "The data can't be trusted yet" },
  KEEP_RUNNING: { label: 'Keep running', icon: Hourglass, text: 'text-info', bg: 'bg-info-bg', hint: 'Not enough data yet' },
  NO_DIFFERENCE: { label: 'No difference', icon: Equal, text: 'text-neutral', bg: 'bg-neutral-bg', hint: 'Fully powered, no real change' },
  NOT_STARTED: { label: 'Not started', icon: CircleDashed, text: 'text-fg-faint', bg: 'bg-neutral-bg', hint: 'No exposures yet' },
};

/** Verdicts that are ready for someone to act on. */
export const DECIDED: VerdictKind[] = ['SHIP', 'DONT_SHIP', 'INVESTIGATE', 'NO_DIFFERENCE'];

export function VerdictBadge({ kind, className, animate = false }: { kind: VerdictKind; className?: string; animate?: boolean }) {
  const meta = VERDICT[kind];
  const Icon = meta.icon;
  return (
    <motion.span
      initial={animate ? { opacity: 0, scale: 0.85 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', bounce: 0.35, duration: 0.5 }}
      className={cn('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium', meta.bg, meta.text, className)}
    >
      <Icon className="size-3.5" strokeWidth={2.4} aria-hidden />
      {meta.label}
    </motion.span>
  );
}

export function VerdictIcon({ kind, size = 'md' }: { kind: VerdictKind; size?: 'md' | 'lg' }) {
  const meta = VERDICT[kind];
  const Icon = meta.icon;
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-full', meta.bg, meta.text, size === 'lg' ? 'size-14' : 'size-10')}>
      <Icon className={size === 'lg' ? 'size-7' : 'size-5'} strokeWidth={2.2} aria-hidden />
    </span>
  );
}
