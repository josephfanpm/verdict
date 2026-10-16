import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type FlagSummary } from './api';
import { num, pct, VERDICT_LABELS } from './format';

export function FlagList() {
  const [flags, setFlags] = useState<FlagSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listFlags().then(setFlags, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="error-box">Could not reach the Verdict API: {error}</p>;
  if (!flags) return <p className="muted">Loading experiments…</p>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Experiments</h1>
          <p className="muted">
            {flags.length} flag{flags.length === 1 ? '' : 's'} · {num(flags.reduce((s, f) => s + f.summary.totalExposures, 0))} users bucketed
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating((c) => !c)}>
          {creating ? 'Cancel' : 'New flag'}
        </button>
      </div>

      {creating && <NewFlagForm />}

      {flags.length === 0 ? (
        <div className="empty">
          <p>No flags yet.</p>
          <p className="muted">
            Create one above, or run <code>npm run simulate</code> to load demo experiments.
          </p>
        </div>
      ) : (
        <ul className="flag-grid">
          {flags.map(({ flag, summary }) => (
            <li key={flag.key}>
              <a className="flag-card" href={`#/flags/${encodeURIComponent(flag.key)}`}>
                <div className="flag-card-top">
                  <code className="flag-key">{flag.key}</code>
                  <span className={`pill verdict-${summary.verdict}`}>{VERDICT_LABELS[summary.verdict]}</span>
                </div>
                <p className="flag-desc">{flag.description || 'No description'}</p>
                <p className="flag-headline">{summary.headline}</p>
                <div className="flag-meta">
                  <span className={`dot ${flag.enabled ? 'on' : 'off'}`} />
                  {flag.enabled ? `Live · ${flag.rolloutPercent}% rollout` : 'Off'}
                  <span className="sep">·</span>
                  {num(summary.totalExposures)} users
                  <span className="sep">·</span>
                  {flag.variants.length} variants
                </div>
                <div className="progress" title={`${pct(summary.progress, 0)} of planned sample`}>
                  <div style={{ width: pct(summary.progress) }} />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NewFlagForm() {
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [variants, setVariants] = useState('control, treatment');
  const [metric, setMetric] = useState('conversion');
  const [mde, setMde] = useState(10);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const keys = variants
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    // Integer weights that always sum to exactly 100, e.g. 34 / 33 / 33.
    const base = Math.floor(100 / keys.length);
    const weighted = keys.map((k, i) => ({ key: k, weight: base + (i < 100 - base * keys.length ? 1 : 0) }));
    try {
      const flag = await api.createFlag({ key, description, variants: weighted, primaryMetric: metric, minDetectableEffect: mde / 100 });
      window.location.hash = `#/flags/${encodeURIComponent(flag.key)}`;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <form className="panel new-flag" onSubmit={submit}>
      <h2>New flag</h2>
      <div className="form-grid">
        <label>
          Key
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="new-onboarding" required />
        </label>
        <label>
          Primary metric (event name)
          <input value={metric} onChange={(e) => setMetric(e.target.value)} required />
        </label>
        <label className="span-2">
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What are we testing, and why?" />
        </label>
        <label>
          Variants (first is control)
          <input value={variants} onChange={(e) => setVariants(e.target.value)} />
        </label>
        <label>
          Minimum detectable effect (%)
          <input type="number" min={1} max={500} value={mde} onChange={(e) => setMde(Number(e.target.value))} />
        </label>
      </div>
      {error && <p className="error-box">{error}</p>}
      <button className="btn primary">Create flag</button>
      <p className="muted small">New flags start switched off, so nobody is bucketed until you turn them on.</p>
    </form>
  );
}
