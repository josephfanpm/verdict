import NumberFlow from '@number-flow/react';
import { ArrowRight, User } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { requiredSampleSize } from '../../../src/core/stats';
import { api, ApiError, type Evaluation, type ExperimentReport, type FlagConfig } from '../api';
import { num, seriesColor } from '../format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { Field, Input } from './ui/input';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';

const FIELDS = ['enabled', 'rolloutPercent', 'variants', 'primaryMetric', 'minDetectableEffect'] as const;

export function ConfigCard({ flag, onSaved }: { flag: FlagConfig; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(flag);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(flag), [flag]);

  const patch: Partial<FlagConfig> = {};
  for (const f of FIELDS) {
    if (JSON.stringify(draft[f]) !== JSON.stringify(flag[f])) Object.assign(patch, { [f]: draft[f] });
  }
  const dirty = Object.keys(patch).length > 0;
  const totalWeight = draft.variants.reduce((s, v) => s + v.weight, 0);

  async function save(force = false) {
    setSaving(true);
    try {
      await api.updateFlag(flag.key, patch, force);
      toast.success(force ? 'Saved. Experiment restarted.' : 'Saved');
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNSAFE_CHANGE') {
        // The guardrail: explain why, and offer the explicit restart as the only way through.
        toast.warning('This would bias the running test', {
          description: `${e.issues.join(' ')} Applying it restarts the experiment.`,
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
    <>
      <Card>
        <CardHeader title="Configuration" />
        <CardBody className="divide-y divide-border pt-2">
          <Row label="Live" hint={draft.enabled ? 'Users are being bucketed' : 'Everyone gets the default variant'}>
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} aria-label="Live" />
          </Row>

          <div className="py-4">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-[15px] font-medium">Rollout</span>
              <span className="tabular text-[15px] font-semibold">
                <NumberFlow value={draft.rolloutPercent} suffix="%" />
              </span>
            </div>
            <Slider
              label="Rollout percent"
              min={0}
              max={100}
              step={1}
              value={[draft.rolloutPercent]}
              onValueChange={([v]) => setDraft({ ...draft, rolloutPercent: v ?? 0 })}
            />
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
                    onChange={(e) => setDraft({ ...draft, variants: draft.variants.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)) })}
                    className="tabular w-12 bg-transparent text-right text-sm font-semibold outline-none"
                    aria-label={`${v.key} weight`}
                  />
                  <span className="text-sm text-fg-faint">%</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-4 pt-4 sm:grid-cols-2">
            <Field label="Goal event">
              <Input value={draft.primaryMetric} onChange={(e) => setDraft({ ...draft, primaryMetric: e.target.value })} />
            </Field>
            <Field label="Smallest lift to detect (%)">
              <Input
                type="number"
                min={1}
                value={Math.round(draft.minDetectableEffect * 1000) / 10}
                onChange={(e) => setDraft({ ...draft, minDetectableEffect: Number(e.target.value) / 100 })}
              />
            </Field>
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
            <Button variant="ghost" size="sm" onClick={() => setDraft(flag)}>
              Discard
            </Button>
            <Button variant="primary" size="sm" disabled={saving || totalWeight !== 100} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
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

export function Planner({ flag, report }: { flag: FlagConfig; report: ExperimentReport }) {
  const control = report.variants[0]!;
  const observed = control.exposures >= 100 ? control.rate : 0.1;
  const [baseline, setBaseline] = useState(Math.round(observed * 1000) / 10);
  const [mde, setMde] = useState(Math.round(flag.minDetectableEffect * 1000) / 10);

  const perVariant = requiredSampleSize(baseline / 100, mde / 100, report.alpha);
  const smallestShare = Math.min(...flag.variants.map((v) => v.weight)) / 100;
  const rollout = flag.rolloutPercent / 100;
  const eligible = Number.isFinite(perVariant) && smallestShare > 0 && rollout > 0 ? Math.ceil(perVariant / smallestShare / rollout) : null;

  return (
    <Card>
      <CardHeader title="Sample size" description={`80% power · α ${report.alpha.toFixed(3)}`} />
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
      </CardBody>
    </Card>
  );
}

const REASONS: Record<Evaluation['reason'], string> = {
  ASSIGNED: 'Assigned by the experiment',
  FLAG_DISABLED: 'Flag is off',
  TARGETING_MISS: "Doesn't match targeting",
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
