import { Check, ChevronLeft, Copy, KeyRound, Plus, ShieldHalf, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api, type HoldoutReadout, type SdkKey } from '../api';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { Field, Input } from '../components/ui/input';
import { metricValue, num, signedPct } from '../format';
import { flagHref } from '../router';

const failed = (title: string) => (e: unknown) => toast.error(title, { description: e instanceof Error ? e.message : String(e) });

export function SettingsPage() {
  return (
    <div>
      <a href="#/" className="-ml-1 mb-6 inline-flex items-center gap-0.5 text-[15px] text-accent hover:underline">
        <ChevronLeft className="size-4" /> Experiments
      </a>
      <h1 className="mb-8 text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">Settings</h1>
      <div className="grid items-start gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Holdouts />
        <SdkKeys />
      </div>
    </div>
  );
}

/** Groups kept back from every experiment behind them, to measure what shipping added up to. */
function Holdouts() {
  const [holdouts, setHoldouts] = useState<HoldoutReadout[] | null>(null);
  const [key, setKey] = useState('');
  const [percent, setPercent] = useState(5);
  const [event, setEvent] = useState('');

  const load = useCallback(() => api.holdouts().then(setHoldouts, failed("Couldn't load holdouts")), []);
  useEffect(() => void load(), [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createHoldout({ key, percent, metric: event });
      toast.success('Holdout created');
      setKey('');
      setEvent('');
      await load();
    } catch (error) {
      failed("Couldn't create holdout")(error);
    }
  }

  return (
    <Card>
      <CardHeader title="Holdouts" description="Users who get no new features" />
      <CardBody className="space-y-5">
        {holdouts?.length === 0 && <p className="text-[13px] text-fg-faint">None</p>}
        {holdouts?.map(({ holdout, flags, report }) => {
          const [held, exposed] = report.variants;
          const c = exposed?.comparison;
          return (
            <div key={holdout.key} className="rounded-2xl bg-bg-subtle p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 font-semibold">
                  <ShieldHalf className="size-4 text-fg-muted" /> {holdout.key}
                </span>
                <span className="tabular text-[13px] text-fg-muted">
                  {holdout.percent}% · {num(held?.exposures ?? 0)} held back
                </span>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <div className="tabular text-[26px] font-semibold leading-none tracking-[-0.02em]">{c?.relativeLift != null ? signedPct(c.relativeLift) : '–'}</div>
                  <div className="mt-1 text-[13px] text-fg-muted">
                    {report.metric}
                    {c?.relativeLiftInterval && ` · ${signedPct(c.relativeLiftInterval[0])} to ${signedPct(c.relativeLiftInterval[1])}`}
                  </div>
                </div>
                {held && exposed && (
                  <div className="tabular text-right text-[13px] text-fg-muted">
                    <div>Held back {metricValue(report.metricKind, held.rate)}</div>
                    <div>Everyone else {metricValue(report.metricKind, exposed.rate)}</div>
                  </div>
                )}
              </div>
              {flags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {flags.map((f) => (
                    <a key={f} href={flagHref(f)} className="rounded-full bg-surface px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset ring-border hover:text-accent">
                      {f}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <form onSubmit={create} className="grid gap-3 border-t border-border pt-5 sm:grid-cols-[1fr_88px_1fr_auto] sm:items-end">
          <Field label="Key">
            <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="h2-2026" required />
          </Field>
          <Field label="Percent">
            <Input type="number" min={1} max={49} value={percent} onChange={(e) => setPercent(Number(e.target.value))} required />
          </Field>
          <Field label="Metric event">
            <Input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="purchase" required />
          </Field>
          <Button variant="primary" disabled={!key || !event}>
            <Plus /> Add
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

/** One key per environment. Once any key exists, SDKs must send one. */
function SdkKeys() {
  const [keys, setKeys] = useState<SdkKey[] | null>(null);
  const [environment, setEnvironment] = useState('production');
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => api.sdkKeys().then(setKeys, failed("Couldn't load SDK keys")), []);
  useEffect(() => void load(), [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createSdkKey(environment);
      toast.success('Key created');
      await load();
    } catch (error) {
      failed("Couldn't create key")(error);
    }
  }

  async function remove(key: string) {
    try {
      await api.deleteSdkKey(key);
      toast.success('Key deleted');
      await load();
    } catch (error) {
      failed("Couldn't delete key")(error);
    }
  }

  return (
    <Card>
      <CardHeader title="SDK keys" description={keys?.length ? 'Required on every SDK request' : 'Open until the first key is created'} />
      <CardBody className="space-y-5">
        {keys?.length === 0 && <p className="text-[13px] text-fg-faint">None</p>}
        {keys && keys.length > 0 && (
          <ul className="divide-y divide-border">
            {keys.map((k) => (
              <li key={k.key} className="flex items-center gap-3 py-2.5">
                <KeyRound className="size-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{k.environment}</div>
                  <div className="truncate font-mono text-[12px] text-fg-faint">{k.key}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copy key"
                  onClick={() => {
                    void navigator.clipboard?.writeText(k.key).then(() => {
                      setCopied(k.key);
                      window.setTimeout(() => setCopied(null), 1500);
                    });
                  }}
                >
                  {copied === k.key ? <Check className="text-good" /> : <Copy />}
                </Button>
                <Button variant="ghost" size="icon" aria-label="Delete key" onClick={() => void remove(k.key)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={create} className="flex items-end gap-3 border-t border-border pt-5">
          <Field label="Environment" className="flex-1">
            <Input value={environment} onChange={(e) => setEnvironment(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="production" required />
          </Field>
          <Button variant="primary" disabled={!environment}>
            <Plus /> Create key
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
