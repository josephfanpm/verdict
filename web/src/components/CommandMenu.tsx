import { Command } from 'cmdk';
import { ArrowRight, FlaskConical, Moon, Plus } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import type { FlagSummary } from '../api';
import { flagHref, navigate } from '../router';
import { VERDICT } from '../verdict';

export function CommandMenu({
  open,
  onOpenChange,
  flags,
  onCreate,
  onToggleTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flags: FlagSummary[];
  onCreate: () => void;
  onToggleTheme: () => void;
}) {
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="dialog-content fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-pop outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <Command loop className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-faint">
            <Command.Input
              autoFocus
              placeholder="Jump to an experiment or action…"
              className="h-14 w-full border-b border-border bg-transparent px-5 text-[15px] text-fg outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-sm text-fg-muted">No matches.</Command.Empty>
              {flags.length > 0 && (
                <Command.Group heading="Experiments">
                  {flags.map(({ flag, summary }) => {
                    const meta = VERDICT[summary.verdict];
                    const Icon = meta.icon;
                    return (
                      <Item key={flag.key} value={`${flag.key} ${flag.description}`} onSelect={() => run(() => navigate(flagHref(flag.key)))}>
                        <Icon className={`size-4 ${meta.text}`} />
                        <span className="truncate font-medium">{flag.key}</span>
                        <span className="ml-auto shrink-0 text-xs text-fg-faint">{meta.label}</span>
                      </Item>
                    );
                  })}
                </Command.Group>
              )}
              <Command.Group heading="Actions">
                <Item value="new experiment create flag" onSelect={() => run(onCreate)}>
                  <Plus className="size-4 text-fg-muted" /> New experiment
                </Item>
                <Item value="all experiments home" onSelect={() => run(() => navigate('#/'))}>
                  <FlaskConical className="size-4 text-fg-muted" /> All experiments
                </Item>
                <Item value="toggle theme dark light mode" onSelect={() => run(onToggleTheme)}>
                  <Moon className="size-4 text-fg-muted" /> Toggle theme
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Item({ children, value, onSelect }: { children: ReactNode; value: string; onSelect: () => void }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="group flex h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm text-fg data-[selected=true]:bg-bg-subtle"
    >
      {children}
      <ArrowRight className="ml-1 size-3.5 shrink-0 text-fg-faint opacity-0 group-data-[selected=true]:opacity-100" />
    </Command.Item>
  );
}
