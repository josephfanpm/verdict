import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { requiredSampleSize } from '../../src/core/stats';
import { api, ApiError, type AuditEntry, type Evaluation, type ExperimentReport, type FlagConfig } from './api';
import { num, pct, pValue, signedPct, timeAgo, VERDICT_LABELS } from './format';
import { LiftChart } from './LiftChart';

export function FlagDetail({ flagKey }: { flagKey: string }) {
  const [flag, setFlag] = useState<FlagConfig | null>(null);
  const [report, setReport] = useState<ExperimentReport | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [f, r, a] = await Promise.all([api.getFlag(flagKey), api.results(flagKey), api.audit(flagKey)]);
      setFlag(f);
      setReport(r);
      setAudit(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [flagKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) return <p className="error-box">{error}</p>;
  if (!flag || !report) return <p className="muted">Loading…</p>;

  return (
    <>
      <a href="#/" className="back">
        ← All experiments
      </a>
      <div className="page-head">
        <div>
          <h1>
            <code>{flag.key}</code>
          </h1>
          <p className="muted">{flag.description || 'No description'}</p>
        </div>
        <div className="head-meta">
          <span className={`dot ${flag.enabled ? 'on' : 'off'}`} /> {flag.enabled ? 'Live' : 'Off'} · v{flag.version}
        </div>
      </div>

      <VerdictCard report={report} />

      <div className="detail-grid">
        <div className="col">
          <Results report={report} />
          <SrmPanel report={report} />
        </div>
        <div className="col">
          <ConfigPanel flag={flag} onSaved={reload} />
          <Playground flag={flag} />
          <SampleSizePlanner flag={flag} report={report} />
          <AuditLog entries={audit} />
        </div>
      </div>
    </>
  );
}

function VerdictCard({ report }: { report: ExperimentReport }) {
  const { verdict } = report;
  return (
    <section className={`verdict-card verdict-${verdict.kind}`} aria-live="polite">
      <div className="verdict-label">{VERDICT_LABELS[verdict.kind]}</div>
      <h2 className="verdict-headline">{verdict.headline}</h2>
      {verdict.reasons.length > 0 && (
        <ul className="verdict-reasons">
          {verdict.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {report.requiredPerVariant !== null && (
        <div className="verdict-progress">
          <div className="progress">
            <div style={{ width: pct(report.progress) }} />
          </div>
          <span className="small">
            {pct(report.progress, 0)} of {num(report.requiredPerVariant)} users per variant needed to detect the planned effect
          </span>
        </div>
      )}
    </section>
  );
}

function Results({ report }: { report: ExperimentReport }) {
  return (
    <section className="panel">
      <h3>
        Results <span className="muted small">· metric: {report.metric}</span>
      </h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th className="num">Users</th>
              <th className="num">Conversions</th>
              <th className="num">Rate</th>
              <th className="num">Lift vs control</th>
              <th className="num">p-value</th>
            </tr>
          </thead>
          <tbody>
            {report.variants.map((v) => {
              const c = v.comparison;
              const tone = !c || !c.significant ? '' : c.absoluteLift > 0 ? 'good' : 'bad';
              return (
                <tr key={v.variant}>
                  <td>
                    <code>{v.variant}</code> {v.isControl && <span className="tag">control</span>}
                  </td>
                  <td className="num">{num(v.exposures)}</td>
                  <td className="num">{num(v.conversions)}</td>
                  <td className="num">{pct(v.rate, 2)}</td>
                  <td className={`num ${tone}`}>
                    {c?.relativeLift != null ? (
                      <>
                        {signedPct(c.relativeLift)}
                        <div className="muted small">
                          {signedPct(c.relativeLiftInterval![0])} to {signedPct(c.relativeLiftInterval![1])}
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{c ? pValue(c.pValue) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <LiftChart report={report} />
    </section>
  );
}

function SrmPanel({ report }: { report: ExperimentReport }) {
  const { srm } = report;
  return (
    <section className="panel">
      <h3>
        Traffic split health{' '}
        <span className={`pill ${srm.mismatch ? 'verdict-INVESTIGATE' : 'verdict-SHIP'}`}>{srm.mismatch ? 'Mismatch' : 'Healthy'}</span>
      </h3>
      <p className="muted small">
        Sample ratio mismatch check: a chi-square test of observed vs configured split (χ² = {srm.statistic.toFixed(2)}, p ={' '}
        {srm.pValue < 0.0001 ? srm.pValue.toExponential(1) : srm.pValue.toFixed(3)}). Below p = 0.001 means users are being lost or
        double-counted somewhere.
      </p>
      <div className="split-bars">
        {report.variants.map((v, i) => (
          <div key={v.variant} className="split-row">
            <code>{v.variant}</code>
            <div className="split-track">
              <div className="split-expected" style={{ width: pct(srm.expectedShares[i] ?? 0) }} />
              <div className="split-observed" style={{ width: pct(srm.observedShares[i] ?? 0) }} />
            </div>
            <span className="small num">
              {pct(srm.observedShares[i] ?? 0)} <span className="muted">/ {pct(srm.expectedShares[i] ?? 0)}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="legend small muted">
        <span className="swatch observed" /> observed <span className="swatch expected" /> expected
      </p>
    </section>
  );
}

function ConfigPanel({ flag, onSaved }: { flag: FlagConfig; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(flag);
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(flag), [flag]);

  const fields = ['enabled', 'rolloutPercent', 'variants', 'primaryMetric', 'minDetectableEffect'] as const;
  const patch: Partial<FlagConfig> = {};
  for (const f of fields) {
    if (JSON.stringify(draft[f]) !== JSON.stringify(flag[f])) Object.assign(patch, { [f]: draft[f] });
  }
  const dirty = Object.keys(patch).length > 0;
  const totalWeight = draft.variants.reduce((s, v) => s + v.weight, 0);

  async function save(force = false) {
    setSaving(true);
    setError(null);
    try {
      await api.updateFlag(flag.key, patch, force);
      setConflict(null);
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNSAFE_CHANGE') setConflict(e);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <h3>Configuration</h3>
      <label className="toggle">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <span>{draft.enabled ? 'Flag is on' : 'Flag is off'}</span>
      </label>

      <label>
        Rollout: {draft.rolloutPercent}% of eligible users
        <input
          type="range"
          min={0}
          max={100}
          value={draft.rolloutPercent}
          onChange={(e) => setDraft({ ...draft, rolloutPercent: Number(e.target.value) })}
        />
      </label>

      <fieldset>
        <legend>
          Variant weights <span className={totalWeight === 100 ? 'muted' : 'bad'}>(total {totalWeight}%)</span>
        </legend>
        {draft.variants.map((v, i) => (
          <div key={v.key} className="weight-row">
            <code>{v.key}</code>
            <input
              type="number"
              min={0}
              max={100}
              value={v.weight}
              onChange={(e) => {
                const variants = draft.variants.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x));
                setDraft({ ...draft, variants });
              }}
            />
            <span className="muted">%</span>
          </div>
        ))}
      </fieldset>

      <div className="form-grid">
        <label>
          Primary metric
          <input value={draft.primaryMetric} onChange={(e) => setDraft({ ...draft, primaryMetric: e.target.value })} />
        </label>
        <label>
          Min. detectable effect (%)
          <input
            type="number"
            min={1}
            value={Math.round(draft.minDetectableEffect * 1000) / 10}
            onChange={(e) => setDraft({ ...draft, minDetectableEffect: Number(e.target.value) / 100 })}
          />
        </label>
      </div>

      {conflict && (
        <div className="warn-box">
          <strong>This change would bias the running experiment.</strong>
          <ul>
            {conflict.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          <div className="row">
            <button className="btn danger" disabled={saving} onClick={() => save(true)}>
              Apply and restart experiment
            </button>
            <button className="btn" onClick={() => setConflict(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-box">{error}</p>}

      <div className="row">
        <button className="btn primary" disabled={!dirty || saving} onClick={() => save()}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && (
          <button className="btn" onClick={() => setDraft(flag)}>
            Discard
          </button>
        )}
      </div>
    </section>
  );
}

function Playground({ flag }: { flag: FlagConfig }) {
  const [userId, setUserId] = useState('user-123');
  const [attributes, setAttributes] = useState('country=US, plan=free');
  const [result, setResult] = useState<Evaluation | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(event: FormEvent) {
    event.preventDefault();
    const attrs: Record<string, string | number> = {};
    for (const pair of attributes.split(',')) {
      const [k, v] = pair.split('=').map((s) => s.trim());
      if (k && v !== undefined) attrs[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    try {
      setResult(await api.evaluate(flag.key, { id: userId, attributes: attrs }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="panel">
      <h3>Try a user</h3>
      <p className="muted small">Dry-run evaluation: see which variant someone gets, and why. Nothing is recorded.</p>
      <form onSubmit={run} className="form-grid">
        <label>
          User ID
          <input value={userId} onChange={(e) => setUserId(e.target.value)} required />
        </label>
        <label>
          Attributes
          <input value={attributes} onChange={(e) => setAttributes(e.target.value)} placeholder="country=US, plan=pro" />
        </label>
        <button className="btn span-2">Evaluate</button>
      </form>
      {flag.targeting.length > 0 && (
        <p className="small muted">
          Targeting:{' '}
          {flag.targeting.map((t) => (
            <code key={t.attribute}>
              {t.attribute} {t.operator} {t.values.join(', ')}
            </code>
          ))}
        </p>
      )}
      {error && <p className="error-box">{error}</p>}
      {result && (
        <div className="eval-result">
          <div>
            Variant <strong>
              <code>{result.variant}</code>
            </strong>
          </div>
          <div className="small muted">
            {REASONS[result.reason]}
            {result.bucket !== null && ` · bucket ${result.bucket} of 10,000`}
          </div>
        </div>
      )}
    </section>
  );
}

const REASONS: Record<Evaluation['reason'], string> = {
  ASSIGNED: 'Assigned by the experiment',
  FLAG_DISABLED: 'Flag is off, so the default variant is served',
  TARGETING_MISS: 'User does not match targeting, so the default variant is served',
  OUTSIDE_ROLLOUT: 'User is outside the rollout percentage, so the default variant is served',
};

function SampleSizePlanner({ flag, report }: { flag: FlagConfig; report: ExperimentReport }) {
  const control = report.variants[0]!;
  const observed = control.exposures >= 100 ? control.rate : 0.1;
  const [baseline, setBaseline] = useState(Math.round(observed * 1000) / 10);
  const [mde, setMde] = useState(Math.round(flag.minDetectableEffect * 1000) / 10);

  const perVariant = requiredSampleSize(baseline / 100, mde / 100, report.alpha);
  const smallestShare = Math.min(...flag.variants.map((v) => v.weight)) / 100;
  const rollout = flag.rolloutPercent / 100;
  const eligible = Number.isFinite(perVariant) && smallestShare > 0 && rollout > 0 ? Math.ceil(perVariant / smallestShare / rollout) : null;

  return (
    <section className="panel">
      <h3>Sample size planner</h3>
      <div className="form-grid">
        <label>
          Baseline conversion (%)
          <input type="number" step="0.1" min={0.1} max={99} value={baseline} onChange={(e) => setBaseline(Number(e.target.value))} />
        </label>
        <label>
          Lift to detect (%)
          <input type="number" step="1" min={1} value={mde} onChange={(e) => setMde(Number(e.target.value))} />
        </label>
      </div>
      {Number.isFinite(perVariant) ? (
        <p className="planner-result">
          <strong>{num(perVariant)}</strong> users per variant
          {eligible && (
            <>
              {' '}
              · <strong>{num(eligible)}</strong> eligible users at the current {flag.rolloutPercent}% rollout
            </>
          )}
        </p>
      ) : (
        <p className="muted">Pick a baseline and lift that keep the rate between 0% and 100%.</p>
      )}
      <p className="muted small">
        80% power, α = {report.alpha.toFixed(3)}. Halving the lift you want to detect roughly quadruples the users you need.
      </p>
    </section>
  );
}

function AuditLog({ entries }: { entries: AuditEntry[] }) {
  return (
    <section className="panel">
      <h3>Change history</h3>
      <ol className="audit">
        {entries.map((e) => (
          <li key={e.id}>
            <span className="tag">v{e.version}</span> {e.summary}
            <div className="muted small">{timeAgo(e.ts)}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
