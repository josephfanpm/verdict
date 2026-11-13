# Verdict technical reference

Setup, code layout, bucketing, counting rules, statistics, API, SDK and tests. For the product summary and what each tool is for, see the [README](../README.md).

## Quick start

Requires **Node.js 22.13+**. There is no database to install: Verdict uses Node's built-in SQLite.

```bash
git clone https://github.com/josephfanpm/verdict.git
cd verdict
npm install
npm run simulate   # seed 8 demo experiments and a holdout (~206k simulated users, ~1s)
npm run dev        # API on :3000, dashboard on http://localhost:5173
```

Or run the production build:

```bash
npm run build && npm start   # dashboard + API on http://localhost:3000
```

Or with Docker (seeds the demo automatically):

```bash
docker build -t verdict . && docker run -p 3000:3000 verdict
```

Or deploy to Render with [`render.yaml`](../render.yaml) (free tier, Docker runtime). The free tier's disk is ephemeral, so the demo data re-seeds on every restart.

A database created by an earlier version is upgraded in place on first start.

## Code layout

```
src/
  core/      Pure domain logic. No dependencies, fully unit-tested.
    hash.ts       MurmurHash3 + bucketing
    flag.ts       Flag and metric defaults; upgrades older stored configs
    evaluate.ts   Overrides, targeting, holdout, exclusion, rollout, assignment, validation
    aggregate.ts  Counting rules: exposures + events -> one row per user -> sums per variant
    stats.ts      Distributions, z-test, Welch t-test, ratios, sequential, CUPED, sample size, SRM
    analyze.ts    Decision engine: sums -> verdict + reasons
    timeseries.ts Cumulative exposures and lift over time
  server/    Fastify API + SQLite store + demo data generator
  sdk/       Client SDK (local evaluation, batched ingestion) and an OpenFeature provider
web/         React dashboard (Vite, Tailwind v4, Radix, Motion, Recharts, visx)
test/        123 tests: unit, API integration, SDK end-to-end
scripts/     simulate.ts (demo data), peeking.ts (A/A peeking simulation)
```

`src/core` is pure TypeScript with no I/O. The server, the SDK, and the dashboard all import the same hashing, evaluation, and statistics code. A user is bucketed identically whether the server or the SDK makes the decision, and the dashboard's sample size planner runs the exact formula the decision engine uses. The SDK test asserts that local evaluation matches the server's answer.

## Evaluation order

`evaluate(flag, user)` runs these checks in order. Every early exit serves a variant without counting the user.

| # | Check | Serves | Reason |
|---|---|---|---|
| 1 | An override rule matches | The rule's variant | `OVERRIDE` |
| 2 | Flag is rolled out | The shipped variant | `ROLLED_OUT` |
| 3 | Flag is off (draft, stopped, archived) | Default | `FLAG_DISABLED` |
| 4 | Targeting does not match | Default | `TARGETING_MISS` |
| 5 | User is in the flag's holdout | Default | `HOLDOUT` |
| 6 | User is outside the flag's exclusion slice | Default | `EXCLUDED` |
| 7 | User is outside the rollout | Default | `OUTSIDE_ROLLOUT` |
| 8 | Assigned by the experiment | Assigned variant | `ASSIGNED` |

Overrides come first so QA can see a variant before launch.

## Bucketing in detail

```ts
unit          = user.anonymousId ?? user.id
holdoutBucket = murmur3(`holdout:${holdoutKey}:${unit}`) % 10_000
exclusionSlot = murmur3(`exclusion:${group}:${unit}`) % 10_000
rolloutBucket = murmur3(`${salt}:rollout:${unit}`) % 10_000
variantBucket = murmur3(`${salt}:variant:${unit}`) % 10_000
```

- **Independent hashes.** One decides *whether* a user is in the experiment, another decides *which* variant. A ramp-up from 10% to 50% admits new users without reshuffling anyone already enrolled. Each flag has its own salt, so a user's bucket in one experiment says nothing about their bucket in another.
- **Holdouts** hash on the holdout key only, so every flag behind a holdout holds back the same users.
- **Exclusion groups** hash on the group name only. Flags in a group own non-overlapping slices of that hash, so no user is in two of them. The API rejects overlapping slices.
- **Stable across login.** When `anonymousId` is supplied, it is the bucketing unit, so signing in does not move a user to another variant.
- Variant boundaries are rounded cumulatively, so a 33.3/33.3/33.3 split still covers all 10,000 buckets.

## Counting rules

All in [`src/core/aggregate.ts`](../src/core/aggregate.ts). Exposures and events are joined in memory and each user is reduced to one row.

| Rule | Detail |
|---|---|
| First exposure wins | One row per user per flag per phase |
| After exposure only | An event counts only if it happened at or after the user's first exposure |
| Conversion window | If the metric has `windowHours`, events after the window are ignored, and users whose window is still open are left out of that metric |
| Pre-experiment value | Events of the same name in the `preExperimentDays` before exposure become the user's covariate (CUPED and the balance check) |
| Identity | Ids linked through `/api/identify` are one user: an exposure under an anonymous id and a purchase under the account id are joined |
| Double exposure | A user logged in two variants is dropped and counted |
| Capping | For value and ratio metrics, per-user values above the cap percentile (default 99th, over users with a non-zero value, pooled across arms) are clipped to it |
| Idempotency | An event sent twice with the same `idempotencyKey` is stored once |

The traffic-split check uses every logged exposure, including users later dropped from the metrics.

## Metrics

| Kind | Per-user value | Test |
|---|---|---|
| `conversion` | 1 if the event fired, else 0 | Two-proportion z-test, pooled standard error |
| `mean` | Sum of the event's `value` (or the event count if no value is sent) | Welch's t-test |
| `ratio` | Sum of `value` across users ÷ count of `denominatorEvent` across users | Delta-method variance, then Welch's t-test |

Each metric has a `direction` (`increase` or `decrease`). A goal wins when it moves significantly in its good direction; a guardrail is broken when it moves significantly the other way.

## Statistics

All in [`src/core/stats.ts`](../src/core/stats.ts), no stats library.

| Piece | Method |
|---|---|
| Relative lift CI | Delta method on the ratio of the two arms (noise in both) |
| Multiple treatments | Bonferroni: alpha = 0.05 / number of treatments |
| Sequential testing | Mixture sequential probability ratio test with a normal mixing prior, tuned to the planned sample size. Gives an always-valid p-value and confidence interval. In the peeking simulation it produces 1.7% false positives where the ordinary test produces 25.1% |
| Variance reduction | CUPED: subtract theta × (pre-experiment value − its mean), with theta pooled across arms. Applied when it removes at least 1% of the variance. Not applied to ratio metrics |
| Sample size | Two-proportion formula for conversion metrics; `2(z_alpha + z_beta)² sd² / delta²` for value and ratio metrics; 80% power |
| Sample plan | Locked from a stated baseline at first read, or from the control arm at 1,000 users. A provisional estimate is shown from 100 control users |
| SRM | Chi-square goodness-of-fit vs configured weights, p < 0.001. Also run per day and per segment |
| Multiple exposures | Flagged above 1% of users (and at least 10) |
| Pre-experiment check | Welch's t-test on the pre-experiment value of the goal metric, p < 0.001 |
| Distributions | Normal CDF/quantile; chi-square via regularized incomplete gamma; Student's t via regularized incomplete beta |

## API

### Flags and lifecycle

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/flags` | List flags with a verdict summary and any cleanup reminder (`?archived=true` to include archived) |
| `POST` | `/api/flags` | Create a flag. A draft unless `enabled: true` |
| `GET` | `/api/flags/:key` | Get a flag |
| `PATCH` | `/api/flags/:key` | Update a flag. Returns **409 `UNSAFE_CHANGE`** if the edit would bias a running test; add `?force=true` to apply it and start a new phase |
| `POST` | `/api/flags/:key/start` | Draft or stopped → running |
| `POST` | `/api/flags/:key/stop` | Running or rolled out → stopped (everyone gets the default) |
| `POST` | `/api/flags/:key/rollout` | `{ variant }` → everyone gets that variant, nobody is counted |
| `POST` | `/api/flags/:key/restart` | `{ reason }` → new phase, new salt, old data kept |
| `DELETE` | `/api/flags/:key` | Archive (not allowed while running) |
| `GET` | `/api/flags/:key/results` | Full report and verdict (`?phase=n` for an earlier phase) |
| `GET` | `/api/flags/:key/timeseries` | Cumulative lift over time (`?phase=n`) |
| `GET` | `/api/flags/:key/audit` | Change history |

Fields accepted on create and update, beyond the basics:

| Field | Meaning |
|---|---|
| `goal` | An event name, or `{ event, kind, direction, windowHours, denominatorEvent, capPercentile }`. `primaryMetric: "event"` is shorthand for a conversion goal |
| `guardrails` | A list of metrics in the same form |
| `minDetectableEffect`, `expectedBaseline`, `expectedBaselineSd` | Inputs to the sample plan. Changing any of them re-plans, and the change is logged |
| `minRuntimeDays` | Default 7 |
| `sequential`, `cuped` | Default `true` |
| `overrides` | `[{ conditions, variant }]`, checked in order before everything else |
| `exclusion` | `{ group, start, end }` in percent |
| `holdout` | Key of an existing holdout |
| `dimensions` | Up to 5 user attributes to store with each exposure |
| `environments` | Non-production environments where the flag is live |
| `variants[].value` | Optional payload returned by evaluation |

Unsafe edits on a flag with exposures: changing variants or weights, lowering the rollout, or changing targeting, the exclusion group or the holdout. Raising the rollout is allowed. A forced edit assigns a new salt and opens a new phase; the audit log records how many exposures stayed in the old one.

### Holdouts and SDK keys

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/holdouts` | Every holdout with its readout: held-back users vs everyone else on the holdout's metric |
| `POST` | `/api/holdouts` | `{ key, percent, metric }` |
| `GET` | `/api/holdouts/:key` | One holdout's readout |
| `GET` | `/api/sdk-keys` | List keys |
| `POST` | `/api/sdk-keys` | `{ environment }` → a new key |
| `DELETE` | `/api/sdk-keys/:key` | Revoke a key |

### Evaluation and ingestion

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/evaluate` | Evaluate a flag for a user and record the exposure (`?dryRun=true` to skip recording) |
| `GET` | `/api/sdk/config` | Flag configs for local evaluation: only the fields evaluation needs, as they behave in the caller's environment |
| `POST` | `/api/exposures` | Batch-ingest exposures. Returns `{ accepted, rejected, ignored }`; exposures from a closed phase are rejected, and non-production exposures are ignored |
| `POST` | `/api/track` | Record one event or a batch, each with an optional `idempotencyKey` |
| `POST` | `/api/identify` | `{ anonymousId, userId }`: link two ids as one user |

### Access

- Set `VERDICT_ADMIN_TOKEN` to require `Authorization: Bearer <token>` on flag, lifecycle and holdout changes, and on anything under `/api/sdk-keys`.
- Evaluation and ingestion are open until the first SDK key is created, so a fresh install needs no setup. After that they require a valid key in the `x-sdk-key` header. A dry-run evaluation never needs a key.
- A key belongs to an environment. Only `production` exposures and events are stored.

```bash
curl -X POST localhost:3000/api/evaluate \
  -H 'content-type: application/json' \
  -d '{"flagKey":"checkout-redesign","user":{"id":"user-42","attributes":{"country":"US"}}}'
# {"flagKey":"checkout-redesign","variant":"control","reason":"ASSIGNED","inExperiment":true,"bucket":3123,"unitId":"user-42","phase":1,"version":1,"holdout":{"key":"growth-2026","held":false}}
```

## SDK

```ts
import { VerdictClient } from './src/sdk';

const verdict = new VerdictClient({ baseUrl: 'https://verdict.example.com', sdkKey: process.env.VERDICT_SDK_KEY });
await verdict.refresh(); // fetch configs once; evaluation is then local and instant

// Pass the anonymous id once the user is known: the variant stays the same across login.
const user = { id: 'user-42', anonymousId: 'device-9f3', attributes: { country: 'US', plan: 'pro' } };
if (verdict.variant('checkout-redesign', user) === 'one-page') {
  renderOnePageCheckout();
}
const pageSize = verdict.value('page-size', user, 20); // a variant's payload, with a fallback

verdict.track('user-42', 'purchase', 49.99);
await verdict.flush(); // identity links, then exposures, then events
```

- Exposures carry the flag's declared dimensions, the phase, and the client timestamp.
- If a flush fails, everything unsent goes back in the queue. Events carry an idempotency key, so the retry cannot double-count.
- Holdout membership is logged automatically for flags behind a holdout.

### OpenFeature

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { VerdictClient } from './src/sdk';
import { VerdictProvider } from './src/sdk/openfeature';

await OpenFeature.setProviderAndWait(new VerdictProvider(new VerdictClient({ baseUrl })));
const client = OpenFeature.getClient();
const variant = await client.getStringValue('checkout-redesign', 'control', { targetingKey: 'user-42', plan: 'pro' });
```

`targetingKey` is the user id, `anonymousId` is passed through, and other primitive context fields become attributes. String evaluation returns the variant's string payload or its key; boolean evaluation returns a boolean payload, or `true` for any variant other than the control; number and object evaluation need a payload of that type.

## Testing

```bash
npm test          # 123 tests in ~1.5s
npm run typecheck
npm run peeking   # A/A simulation: false positives checking once, peeking, and peeking with the sequential test
```

- **Hashing:** verified against the reference MurmurHash3 test vectors, plus a uniformity check across 100,000 users.
- **Statistics:** normal, chi-square and t distributions against published table values; sample size against the textbook formulas; Welch's test against a worked example; sequential testing by A/A simulation; CUPED on data with a known effect.
- **Evaluation:** determinism, weight accuracy, targeting, ramp-up stability, salt independence, overrides, rollout, holdout consistency across flags, mutual exclusion, stability across login.
- **Counting rules:** exposure ordering, windows, open windows, double exposures, value and ratio metrics, capping, segments.
- **Decision engine:** one test for every verdict branch, including a goal win with a broken guardrail, a winner alongside a loser, the minimum runtime, an early sequential ship, a locked plan, and each trust check.
- **API:** validation, exposure deduplication, conversion ordering, idempotent events, identity linking, the 409 guardrail, phases, lifecycle, plan locking, exclusion conflicts, holdouts, SDK keys and environments, auth.
- **SDK:** end-to-end against a real HTTP server: local evaluation matches the server, retry without double-counting, and the provider driven through the real OpenFeature client.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs typecheck, tests, and the production build on every push to `main` and on pull requests.
