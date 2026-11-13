import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-10 w-full rounded-xl border border-border-strong bg-surface px-3 text-sm text-fg outline-none transition-shadow placeholder:text-fg-faint focus:border-accent focus:ring-4 focus:ring-ring',
      className
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-10 w-full rounded-xl border border-border-strong bg-surface px-3 text-sm text-fg outline-none transition-shadow focus:border-accent focus:ring-4 focus:ring-ring',
        className
      )}
      {...props}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-[13px] font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-fg-faint">{hint}</span>}
    </label>
  );
}
