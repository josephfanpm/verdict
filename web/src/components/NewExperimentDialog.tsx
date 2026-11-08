import { Plus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { FLAG_KEY_PATTERN as KEY_PATTERN } from '../../../src/core/evaluate';
import { api, ApiError } from '../api';
import { flagHref, navigate } from '../router';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Field, Input } from './ui/input';

export function NewExperimentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [variants, setVariants] = useState(['control', 'treatment']);
  const [metric, setMetric] = useState('conversion');
  const [mde, setMde] = useState(10);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setKey('');
    setDescription('');
    setVariants(['control', 'treatment']);
    setMetric('conversion');
    setMde(10);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const keys = variants.map((v) => v.trim()).filter(Boolean);
    // Integer weights that always sum to exactly 100, e.g. 34 / 33 / 33.
    const base = Math.floor(100 / keys.length);
    const weighted = keys.map((k, i) => ({ key: k, weight: base + (i < 100 - base * keys.length ? 1 : 0) }));
    setSaving(true);
    try {
      const flag = await api.createFlag({ key, description, variants: weighted, primaryMetric: metric, minDetectableEffect: mde / 100 });
      toast.success('Experiment created', { description: 'It starts off. Turn it on in Setup when you are ready.' });
      onOpenChange(false);
      reset();
      navigate(flagHref(flag.key));
    } catch (e) {
      toast.error("Couldn't create experiment", { description: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  const keyInvalid = key.length > 0 && !KEY_PATTERN.test(key);
  const validVariants = variants.filter((v) => v.trim()).length >= 2;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New experiment">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <Field label="Key" hint={keyInvalid ? 'Lowercase letters, numbers, dashes' : undefined}>
            <Input autoFocus value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="new-onboarding" required aria-invalid={keyInvalid} />
          </Field>
          <Field label="Hypothesis">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What are you testing, and why?" />
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg-muted">Variants</span>
            <div className="flex flex-col gap-2">
              {variants.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={v}
                    onChange={(e) => setVariants(variants.map((x, j) => (j === i ? e.target.value : x)))}
                    aria-label={i === 0 ? 'Control variant' : `Variant ${i + 1}`}
                  />
                  {i === 0 ? (
                    <span className="w-16 shrink-0 text-center text-xs text-fg-faint">Control</span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="w-16 shrink-0"
                      disabled={variants.length <= 2}
                      onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                      aria-label="Remove variant"
                    >
                      <X />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {variants.length < 5 && (
              <button
                type="button"
                onClick={() => setVariants([...variants, `variant-${variants.length}`])}
                className="mt-1 flex items-center gap-1.5 self-start text-[13px] font-medium text-accent"
              >
                <Plus className="size-3.5" /> Add variant
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Goal event">
              <Input value={metric} onChange={(e) => setMetric(e.target.value)} required />
            </Field>
            <Field label="Smallest lift (%)">
              <Input type="number" min={1} max={500} value={mde} onChange={(e) => setMde(Number(e.target.value))} />
            </Field>
          </div>

          <Button variant="primary" disabled={saving || !key || keyInvalid || !validVariants} className="mt-1">
            {saving ? 'Creating…' : 'Create experiment'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
