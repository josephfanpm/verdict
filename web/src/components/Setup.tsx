import NumberFlow from '@number-flow/react';
import { Archive, ArrowRight, Play, Plus, RotateCcw, Rocket, Square, User, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { metric } from '../../../src/core/flag';
import { requiredSampleSize } from '../../../src/core/stats';
import type { Condition, OverrideRule } from '../../../src/core/types';
import { api, ApiError, type Evaluation, type ExperimentReport, type FlagBody, type FlagConfig, type HoldoutReadout, type MetricDef } from '../api';
import { num, seriesColor } from '../format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { Field, Input, Select } from './ui/input';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The stated baseline as a percent (conversion goals) or a plain number, or '' when there is none. */
function statedBaseline(flag: FlagConfig): string {
  if (flag.plan.baseline === null || flag.plan.source === 'observed') return '';
  return flag.goal.kind === 'conversion' ? String(Math.round(flag.plan.baseline * 1000) / 10) : String(flag.plan.baseline);
}

export function ConfigCard({ flag, onSaved }: { flag: FlagConfig; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(flag);
  const [baseline, setBaseline] = useState(statedBaseline(flag));
  const [holdouts, setHoldouts] = useState<HoldoutReadout[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(flag);
    setBaseline(statedBaseline(flag));
  }, [flag]);
  useEffect(() => {
    api.holdouts().then(setHoldouts, () => setHoldouts([]));
  }, []);

  const set = (changes: Partial<FlagConfig>) => setDraft((d) => ({ ...d, ...changes }));

  const patch: FlagBody = {};
  if (draft.rolloutPercent !== flag.rolloutPercent) patch.rolloutPercent = draft.rolloutPercent;
  if (!same(draft.variants, flag.variants)) patch.variants = draft.variants;
  if (!same(draft.goal, flag.goal)) patch.goal = draft.goal;
  if (!same(draft.guardrails, flag.guardrails)) patch.guardrails = draft.guardrails;
  if (draft.minDetectableEffect !== flag.minDetectableEffect) patch.minDetectableEffect = draft.minDetectableEffect;
  if (draft.minRuntimeDays !== flag.minRuntimeDays) patch.minRuntimeDays = draft.minRuntimeDays;
  if (draft.sequential !== flag.sequential) patch.sequential = draft.sequential;
  if (draft.cuped !== flag.cuped) patch.cuped = draft.cuped;
  if (!same(draft.overrides, flag.overrides)) patch.overrides = draft.overrides;
  if (!same(draft.exclusion, flag.exclusion)) patch.exclusion = draft.exclusion;
  if (!same(draft.dimensions, flag.dimensions)) patch.dimensions = draft.dimensions;
  if (!same(draft.environments, flag.environments)) patch.environments = draft.environments;
  if ((draft.holdout?.key ?? null) !== (flag.holdout?.key ?? null)) patch.holdout = draft.holdout?.key ?? null;
  if (baseline !== statedBaseline(flag)) {
    const value = Number(baseline);
    patch.expectedBaseline = baseline.trim() === '' || !(value > 0) ? null : draft.goal.kind === 'conversion' ? value / 100 : value;
  }
  const dirty = Object.keys(patch).length > 0;
  const totalWeight = draft.variants.reduce((s, v) => s + v.weight, 0);

  async function save(force = false) {
    setSaving(true);
    try {
      await api.updateFlag(flag.key, patch, force);
      toast.success(force ? 'Saved. New phase started.' : 'Saved');
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNSAFE_CHANGE') {
        // The guardrail: explain why, and offer the explicit restart as the only way through.
        toast.warning('This would bias the running test', {
          description: `${e.issues.join(' ')} Applying it starts a new phase. Current results are kept.`,
          duration: 15_000,
          action: { label: 'Apply & restart', onClick: () => void save(true) },
          cancel: { label: 'Cancel', onClick: () => {} },
        });
      } else {
        toast.error("Couldn't save", { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Traffic" />
        <CardBody className="divide-y divide-border pt-2">
          <div className="py-4">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-[15px] font-medium">Rollout</span>
              <span className="tabular text-[15px] font-semibold">
                <NumberFlow value={draft.rolloutPercent} suffix="%" />
              </span>
            </div>
            <Slider label="Rollout percent" min={0} max={100} step={1} value={[draft.rolloutPercent]} onValueChange={([v]) => set({ rolloutPercent: v ?? 0 })} />
          </div>

          <div className="py-4">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-[15px] font-medium">Traffic split</span>
              <span className={cn('tabular text-[13px]', totalWeight === 100 ? 'text-fg-faint' : 'font-medium text-bad')}>{totalWeight}% total</span>
            </div>
            <div className="mb-4 flex h-2 gap-0.5 overflow-hidden rounded-full bg-bg-subtle">
              {draft.variants.map((v, i) => (
                <motion.div
                  key={v.key}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{ background: seriesColor(i) }}
                  animate={{ width: `${(v.weight / Math.max(100, totalWeight)) * 100}%` }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                />
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {draft.variants.map((v, i) => (
                <label key={v.key} className="flex items-center gap-2.5 rounded-xl bg-bg-subtle px-3 py-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{v.key}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={v.weight}
                    onChange={(e) => set({ variants: draft.variants.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)) })}
                    className="tabular w-12 bg-transparent text-right text-sm font-semibold outline-none"
                    aria-label={`${v.key} weight`}
                  />
                  <span className="text-sm text-fg-faint">%</span>
                </label>
              ))}
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Metrics" />
        <CardBody className="space-y-5">
          <div>
            <div className="mb-2 text-[13px] font-medium text-fg-muted">Goal</div>
            <MetricEditor value={draft.goal} onChange={(goal) => set({ goal })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Smallest lift to detect (%)">
              <Input type="number" min={1} value={Math.round(draft.minDetectableEffect * 1000) / 10} onChange={(e) => set({ minDetectableEffect: Number(e.target.value) / 100 })} />
            </Field>
            <Field label={draft.goal.kind === 'conversion' ? 'Expected baseline (%)' : 'Expected baseline'}>
              <Input
                type="number"
                min={0}
                step="any"
                value={baseline}
                placeholder={flag.plan.source === 'observed' && flag.plan.baseline !== null ? 'From data' : 'Optional'}
                onChange={(e) => setBaseline(e.target.value)}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-medium text-fg-muted">Guardrails</span>
              <button
                type="button"
                onClick={() => set({ guardrails: [...draft.guardrails, metric({ event: '', direction: 'decrease' })] })}
                className="flex items-center gap-1.5 text-[13px] font-medium text-accent"
              >
                <Plus className="size-3.5" /> Add
              </button>
            </div>
            {draft.guardrails.length === 0 ? (
              <p className="text-[13px] text-fg-faint">None</p>
            ) : (
              <div className="space-y-3">
                {draft.guardrails.map((g, i) => (
                  <div key={i} className="rounded-2xl bg-bg-subtle p-3">
                    <MetricEditor
                      value={g}
                      onChange={(next) => set({ guardrails: draft.guardrails.map((x, j) => (j === i ? next : x)) })}
                      onRemove={() => set({ guardrails: draft.guardrails.filter((_, j) => j !== i) })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Decision rules" />
        <CardBody className="divide-y divide-border pt-2">
          <Row label="Minimum runtime" hint="Days of enrollment before a win is called">
            <Input type="number" min={0} max={90} className="w-20 text-right" value={draft.minRuntimeDays} onChange={(e) => set({ minRuntimeDays: Number(e.target.value) })} aria-label="Minimum runtime in days" />
          </Row>
          <Row label="Sequential testing" hint={draft.sequential ? 'Results are valid whenever you look' : 'Results are valid only at the planned sample'}>
            <Switch checked={draft.sequential} onCheckedChange={(sequential) => set({ sequential })} aria-label="Sequential testing" />
          </Row>
          <Row label="Variance reduction" hint="Uses pre-experiment behavior to cut noise">
            <Switch checked={draft.cuped} onCheckedChange={(cuped) => set({ cuped })} aria-label="Variance reduction" />
          </Row>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Audience" />
        <CardBody className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Segment by" hint="User attributes, comma-separated">
              <ListInput value={draft.dimensions} onChange={(dimensions) => set({ dimensions })} placeholder="country, plan" />
            </Field>
            <Field label="Test environments" hint="Live here before launch">
              <ListInput value={draft.environments} onChange={(environments) => set({ environments })} placeholder="staging" />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Holdout">
              <Select
                value={draft.holdout?.key ?? ''}
                onChange={(e) => {
                  const picked = holdouts.find((h) => h.holdout.key === e.target.value)?.holdout;
                  set({ holdout: picked ? { key: picked.key, percent: picked.percent } : null });
                }}
              >
                <option value="">None</option>
                {holdouts.map((h) => (
                  <option key={h.holdout.key} value={h.holdout.key}>
                    {h.holdout.key} ({h.holdout.percent}%)
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Exclusion group" hint={draft.exclusion ? 'Tests in a group never share users' : undefined}>
              <Input
                value={draft.exclusion?.group ?? ''}
                placeholder="None"
                onChange={(e) => set({ exclusion: e.target.value ? { group: e.target.value, start: draft.exclusion?.start ?? 0, end: draft.exclusion?.end ?? 50 } : null })}
              />
            </Field>
          </div>
          {draft.exclusion && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From (%)">
                <Input type="number" min={0} max={100} value={draft.exclusion.start} onChange={(e) => set({ exclusion: { ...draft.exclusion!, start: Number(e.target.value) } })} />
              </Field>
              <Field label="To (%)">
                <Input type="number" min={0} max={100} value={draft.exclusion.end} onChange={(e) => set({ exclusion: { ...draft.exclusion!, end: Number(e.target.value) } })} />
              </Field>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-medium text-fg-muted">Forced variants</span>
              <button
                type="button"
                onClick={() => set({ overrides: [...draft.overrides, { conditions: [{ attribute: 'email', operator: 'contains', values: [''] }], variant: draft.variants[1]?.key ?? draft.variants[0]!.key }] })}
                className="flex items-center gap-1.5 text-[13px] font-medium text-accent"
              >
                <Plus className="size-3.5" /> Add
              </button>
            </div>
            {draft.overrides.length === 0 ? (
              <p className="text-[13px] text-fg-faint">None</p>
            ) : (
              <div className="space-y-2">
                {draft.overrides.map((rule, i) => (
                  <OverrideEditor
                    key={i}
                    rule={rule}
                    variants={draft.variants.map((v) => v.key)}
                    onChange={(next) => set({ overrides: draft.overrides.map((x, j) => (j === i ? next : x)) })}
                    onRemove={() => set({ overrides: draft.overrides.filter((_, j) => j !== i) })}
                  />
                ))}
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Floating save bar, only while there are unsaved edits. */}
      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            className="fixed inset-x-0 bottom-6 z-30 mx-auto flex w-[calc(100vw-32px)] max-w-md items-center gap-3 rounded-full border border-border bg-surface-raised/90 py-2 pl-5 pr-2 shadow-pop backdrop-blur-xl"
          >
            <span className="flex-1 text-sm font-medium">Unsaved changes</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(flag);
                setBaseline(statedBaseline(flag));
              }}
            >
              Discard
            </Button>
            <Button variant="primary" size="sm" disabled={saving || totalWeight !== 100} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MetricEditor({ value, onChange, onRemove }: { value: MetricDef; onChange: (next: MetricDef) => void; onRemove?: () => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Event">
        <div className="flex items-center gap-2">
          <Input value={value.event} onChange={(e) => onChange({ ...value, event: e.target.value })} placeholder="purchase" />
          {onRemove && (
            <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={onRemove} aria-label="Remove metric">
              <X />
            </Button>
          )}
        </div>
      </Field>
      <Field label="Measure">
        <Select
          value={value.kind}
          // Switching type resets the options that only make sense for the old one.
          onChange={(e) => onChange(metric({ event: value.event, direction: value.direction, windowHours: value.windowHours, kind: e.target.value as MetricDef['kind'], denominatorEvent: value.denominatorEvent }))}
        >
          <option value="conversion">Did it (yes/no)</option>
          <option value="mean">Value per user</option>
          <option value="ratio">Value per event</option>
        </Select>
      </Field>
      {value.kind === 'ratio' && (
        <Field label="Per event">
          <Input value={value.denominatorEvent ?? ''} onChange={(e) => onChange({ ...value, denominatorEvent: e.target.value || null })} placeholder="session" />
        </Field>
      )}
      <Field label="Good direction">
        <Select value={value.direction} onChange={(e) => onChange({ ...value, direction: e.target.value as MetricDef['direction'] })}>
          <option value="increase">Higher is better</option>
          <option value="decrease">Lower is better</option>
        </Select>
      </Field>
      <Field label="Window (hours)">
        <Input
          type="number"
          min={1}
          value={value.windowHours ?? ''}
          placeholder="No limit"
          onChange={(e) => onChange({ ...value, windowHours: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </Field>
    </div>
  );
}

const OPERATORS: Array<{ value: Condition['operator']; label: string }> = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'is above' },
  { value: 'lt', label: 'is below' },
];

/** Edits the first condition of a rule; any further conditions set through the API are kept as they are. */
function OverrideEditor({ rule, variants, onChange, onRemove }: { rule: OverrideRule; variants: string[]; onChange: (next: OverrideRule) => void; onRemove: () => void }) {
  const condition = rule.conditions[0] ?? { attribute: '', operator: 'equals' as const, values: [''] };
  const update = (changes: Partial<Condition>) => onChange({ ...rule, conditions: [{ ...condition, ...changes }, ...rule.conditions.slice(1)] });
  return (
    <div className="grid grid-cols-2 items-center gap-2 rounded-2xl bg-bg-subtle p-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto]">
      <Input value={condition.attribute} onChange={(e) => update({ attribute: e.target.value })} placeholder="email" aria-label="Attribute" />
      <Select value={condition.operator} onChange={(e) => update({ operator: e.target.value as Condition['operator'] })} aria-label="Operator" className="sm:w-32">
        {OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      <ListInput value={condition.values.map(String)} onChange={(values) => update({ values: values.length ? values : [''] })} placeholder="@acme.com" />
      <ArrowRight className="mx-auto hidden size-4 text-fg-faint sm:block" />
      <Select value={rule.variant} onChange={(e) => onChange({ ...rule, variant: e.target.value })} aria-label="Variant">
        {variants.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </Select>
      <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Remove rule">
        <X />
      </Button>
    </div>
  );
}

/** A comma-separated list that keeps what the user is typing, trailing comma included. */
function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const parse = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    setText((current) => (same(parse(current), value) ? current : value.join(', ')));
  }, [value]);
  return (
    <Input
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <div className="text-[15px] font-medium">{label}</div>
        {hint && <div className="text-[13px] text-fg-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

const STATUS_LABEL: Record<FlagConfig['status'], string> = {
  draft: 'Draft',
  running: 'Running',
  stopped: 'Stopped',
  rolled_out: 'Rolled out',
  archived: 'Archived',
};

/** Start, stop, ship, restart, archive. Every step is explicit and lands in History. */
export function LifecycleCard({ flag, report, onSaved }: { flag: FlagConfig; report: ExperimentReport; onSaved: () => Promise<void> }) {
  const [variant, setVariant] = useState(report.verdict.winner ?? flag.variants[1]?.key ?? flag.variants[0]!.key);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (report.verdict.winner) setVariant(report.verdict.winner);
  }, [report.verdict.winner]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      await onSaved();
    } catch (e) {
      toast.error("Couldn't do that", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const archived = flag.status === 'archived';
  return (
    <Card>
      <CardHeader title="Lifecycle" description={`${STATUS_LABEL[flag.status]}${flag.rolledOutVariant ? ` · ${flag.rolledOutVariant}` : ''} · Phase ${flag.phase}`} />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(flag.status === 'draft' || flag.status === 'stopped') && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(() => api.start(flag.key), 'Started')}>
              <Play /> {flag.status === 'draft' ? 'Start' : 'Resume'}
            </Button>
          )}
          {(flag.status === 'running' || flag.status === 'rolled_out') && (
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.stop(flag.key), 'Stopped')}>
              <Square /> Stop
            </Button>
          )}
          {!archived && flag.status !== 'running' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.archive(flag.key), 'Archived')}>
              <Archive /> Archive
            </Button>
          )}
        </div>

        {!archived && (
          <>
            <Field label="Roll out to everyone">
              <div className="flex gap-2">
                <Select value={variant} onChange={(e) => setVariant(e.target.value)}>
                  {flag.variants.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.key}
                    </option>
                  ))}
                </Select>
                <Button size="md" className="shrink-0" disabled={busy} onClick={() => void run(() => api.rollout(flag.key, variant), `Rolled out ${variant}`)}>
                  <Rocket /> Roll out
                </Button>
              </div>
            </Field>
            <Field label="Restart as a new phase">
              <div className="flex gap-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" />
                <Button
                  size="md"
                  className="shrink-0"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.restart(flag.key, reason);
                      setReason('');
                    }, 'New phase started')
                  }
                >
                  <RotateCcw /> Restart
                </Button>
              </div>
            </Field>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function Planner({ flag, report }: { flag: FlagConfig; report: ExperimentReport }) {
  const control = report.variants[0]!;
  const start = flag.plan.baseline !== null && flag.goal.kind === 'conversion' ? flag.plan.baseline : control.analyzed >= 100 ? control.rate : 0.1;
  const [baseline, setBaseline] = useState(Math.round(start * 1000) / 10);
  const [mde, setMde] = useState(Math.round(flag.minDetectableEffect * 1000) / 10);

  const locked = report.planSource === 'locked' && report.requiredPerVariant !== null;
  const description = `80% power · α ${report.alpha.toFixed(3)}`;

  // Per-user averages and ratios are planned from the control's spread, which a what-if form can't guess.
  if (flag.goal.kind !== 'conversion') {
    return (
      <Card>
        <CardHeader title="Sample size" description={description} />
        <CardBody>
          <div className="rounded-2xl bg-bg-subtle p-4">
            {report.requiredPerVariant ? (
              <>
                <div className="tabular text-[28px] font-semibold leading-none tracking-[-0.02em]">{num(report.requiredPerVariant)}</div>
                <div className="mt-1 text-[13px] text-fg-muted">users per variant · {locked ? 'locked' : 'estimate'}</div>
              </>
            ) : (
              <p className="text-sm text-fg-muted">Needs 100 control users to plan.</p>
            )}
          </div>
        </CardBody>
      </Card>
    );
  }

  const perVariant = requiredSampleSize(baseline / 100, mde / 100, report.alpha);
  const smallestShare = Math.min(...flag.variants.map((v) => v.weight)) / 100;
  const rollout = flag.rolloutPercent / 100;
  const eligible = Number.isFinite(perVariant) && smallestShare > 0 && rollout > 0 ? Math.ceil(perVariant / smallestShare / rollout) : null;

  return (
    <Card>
      <CardHeader title="Sample size" description={description} />
      <CardBody>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Baseline (%)">
            <Input type="number" step="0.1" min={0.1} max={99} value={baseline} onChange={(e) => setBaseline(Number(e.target.value))} />
          </Field>
          <Field label="Lift (%)">
            <Input type="number" step="1" min={1} value={mde} onChange={(e) => setMde(Number(e.target.value))} />
          </Field>
        </div>
        <div className="mt-5 rounded-2xl bg-bg-subtle p-4">
          {Number.isFinite(perVariant) ? (
            <>
              <div className="tabular text-[28px] font-semibold leading-none tracking-[-0.02em]">
                <NumberFlow value={perVariant} />
              </div>
              <div className="mt-1 text-[13px] text-fg-muted">users per variant</div>
              {eligible && <div className="mt-3 text-[13px] text-fg-muted">{num(eligible)} eligible users at {flag.rolloutPercent}% rollout</div>}
            </>
          ) : (
            <p className="text-sm text-fg-muted">Keep baseline and lift within 0–100%.</p>
          )}
        </div>
        {locked && <p className="mt-3 text-[13px] text-fg-muted">This experiment is locked at {num(report.requiredPerVariant!)} per variant.</p>}
      </CardBody>
    </Card>
  );
}

const REASONS: Record<Evaluation['reason'], string> = {
  ASSIGNED: 'Assigned by the experiment',
  OVERRIDE: 'Forced variant',
  ROLLED_OUT: 'Rolled out to everyone',
  FLAG_DISABLED: 'Flag is off',
  TARGETING_MISS: "Doesn't match targeting",
  HOLDOUT: 'In the holdout',
  EXCLUDED: 'Reserved for another test',
  OUTSIDE_ROLLOUT: 'Outside the rollout',
};

export function Playground({ flag }: { flag: FlagConfig }) {
  const [userId, setUserId] = useState('user-123');
  const [attributes, setAttributes] = useState('country=US, plan=free');
  const [result, setResult] = useState<Evaluation | null>(null);

  async function run(event: FormEvent) {
    event.preventDefault();
    const attrs: Record<string, string | number> = {};
    for (const pair of attributes.split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim());
      if (k && v !== undefined) attrs[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    try {
      setResult(await api.evaluate(flag.key, { id: userId, attributes: attrs }));
    } catch (e) {
      toast.error("Couldn't evaluate", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  const index = result ? flag.variants.findIndex((v) => v.key === result.variant) : -1;

  return (
    <Card>
      <CardHeader title="Try a user" description="Dry run. Nothing is recorded." />
      <CardBody>
        <form onSubmit={run} className="flex flex-col gap-3">
          <Field label="User ID">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} required />
          </Field>
          <Field label="Attributes">
            <Input value={attributes} onChange={(e) => setAttributes(e.target.value)} placeholder="country=US, plan=pro" />
          </Field>
          {flag.targeting.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {flag.targeting.map((t) => (
                <span key={t.attribute} className="rounded-full bg-bg-subtle px-2.5 py-1 font-mono text-[11px] text-fg-muted ring-1 ring-inset ring-border">
                  {t.attribute} {t.operator} {t.values.join(', ')}
                </span>
              ))}
            </div>
          )}
          <Button className="mt-1">
            Evaluate <ArrowRight />
          </Button>
        </form>
        <AnimatePresence mode="wait">
          {result && (
            <motion.div
              key={`${result.variant}-${result.reason}-${result.bucket}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 flex items-center gap-3 rounded-2xl bg-bg-subtle p-4"
            >
              <span className="grid size-9 place-items-center rounded-full bg-surface text-fg-muted ring-1 ring-border">
                <User className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[15px] font-semibold">
                  <span className="size-2.5 rounded-full" style={{ background: seriesColor(Math.max(0, index)) }} />
                  {result.variant}
                </div>
                <div className="text-[13px] text-fg-muted">
                  {REASONS[result.reason]}
                  {result.bucket !== null && ` · bucket ${num(result.bucket)}`}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardBody>
    </Card>
  );
}
