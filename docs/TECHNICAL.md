# Verdict technical reference

Setup, code layout, bucketing, API, SDK and tests. For the product summary, see the [README](../README.md).

## Quick start

Requires **Node.js 22.13+**. There is no database to install: Verdict uses Node's built-in SQLite.

```bash
git clone https://github.com/josephfanpm/verdict.git
cd verdict
npm install
npm run simulate   # seed 5 demo experiments (~100k simulated users, < 1s)
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

## Code layout

```
src/
  core/      Pure domain logic. No dependencies, fully unit-tested.
    hash.ts       MurmurHash3 + bucketing
    evaluate.ts   Targeting, rollout, variant assignment, validation
    stats.ts      Normal/chi-square distributions, z-test, CIs, sample size, SRM
    analyze.ts    Decision engine: counts → verdict + reasons
    timeseries.ts Cumulative exposures and lift over time
  server/    Fastify API + SQLite store + demo data generator
  sdk/       Client SDK with local evaluation and batched ingestion
web/         React dashboard (Vite, Tailwind v4, Radix, Motion, Recharts, visx)
test/        51 tests: unit, API integration, SDK end-to-end
scripts/     simulate.ts (demo data), peeking.ts (A/A peeking simulation)
```

`src/core` is pure TypeScript with no I/O. The server, the SDK, and the dashboard all import the same hashing, evaluation, and statistics code. A user is bucketed identically whether the server or the SDK makes the decision, and the dashboard's sample size planner runs the exact formula the decision engine uses. The SDK test asserts that local evaluation matches the server's answer.

## Bucketing in detail

```ts
rolloutBucket = murmur3(`${salt}:rollout:${userId}`) % 10_000
variantBucket = murmur3(`${salt}:variant:${userId}`) % 10_000
```

Two **independent** hashes are used. The first decides *whether* a user is in the experiment, and the second decides *which* variant they get. Because they're independent, a ramp-up from 10% to 50% admits new users without reshuffling anyone already enrolled. Each flag has its own salt, so a user's bucket in one experiment says nothing about their bucket in another. Variant boundaries are rounded cumulatively, so a 33.3/33.3/33.3 split still covers all 10,000 buckets.

## Statistics

All in [`src/core/stats.ts`](../src/core/stats.ts), no stats library.

| Piece | Method |
|---|---|
| Significance | Two-sided two-proportion z-test, pooled standard error |
| Relative lift CI | Delta method on the ratio of rates (noise in both arms) |
| Multiple treatments | Bonferroni: alpha = 0.05 / number of treatments |
| Sample size | Standard two-proportion formula from baseline rate, MDE, alpha, 80% power |
| Planning floor | No sample size is planned until control has 100 exposures |
| SRM | Chi-square goodness-of-fit vs configured weights, p < 0.001 |
| Distributions | Normal CDF/quantile; chi-square via regularized incomplete gamma (series + continued fraction) |

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/flags` | List flags with a verdict summary |
| `POST` | `/api/flags` | Create a flag (starts disabled) |
| `GET` | `/api/flags/:key` | Get a flag |
| `PATCH` | `/api/flags/:key` | Update a flag. Returns **409 `UNSAFE_CHANGE`** if the edit would bias a running test; add `?force=true` to apply it and restart the experiment |
| `GET` | `/api/flags/:key/results` | Full statistical report and verdict |
| `GET` | `/api/flags/:key/audit` | Change history |
| `POST` | `/api/evaluate` | Evaluate a flag for a user and record the exposure (`?dryRun=true` to skip recording) |
| `GET` | `/api/sdk/config` | All flag configs, for local evaluation in the SDK |
| `POST` | `/api/exposures` | Batch-ingest exposures from an SDK |
| `POST` | `/api/track` | Record one conversion event or a batch |

Unsafe edits on a flag with exposures: changing variants or weights, lowering the rollout, or changing targeting. Raising the rollout is allowed. A forced edit assigns a new salt and discards prior exposures, and the audit log records how many.

Set `VERDICT_ADMIN_TOKEN` to require `Authorization: Bearer <token>` on flag changes. Evaluation and tracking stay open, as they would be for a client-side SDK key.

```bash
curl -X POST localhost:3000/api/evaluate \
  -H 'content-type: application/json' \
  -d '{"flagKey":"checkout-redesign","user":{"id":"user-42","attributes":{"country":"US"}}}'
# {"flagKey":"checkout-redesign","version":1,"variant":"control","reason":"ASSIGNED","inExperiment":true,"bucket":3123}
```

## SDK

```ts
import { VerdictClient } from './src/sdk';

const verdict = new VerdictClient({ baseUrl: 'https://verdict.example.com' });
await verdict.refresh(); // fetch configs once; evaluation is then local and instant

const user = { id: 'user-42', attributes: { country: 'US', plan: 'pro' } };
if (verdict.variant('checkout-redesign', user) === 'one-page') {
  renderOnePageCheckout();
}

verdict.track('user-42', 'purchase');
await verdict.flush(); // exposures are sent before events, so conversions are never orphaned
```

## Testing

```bash
npm test          # 51 tests in ~1s
npm run typecheck
npm run peeking   # A/A simulation: false-positive rate with and without peeking
```

- **Hashing:** verified against the reference MurmurHash3 test vectors, plus a uniformity check across 100,000 users.
- **Statistics:** checked against published normal and chi-square table values and the textbook sample size formula.
- **Evaluation:** determinism, weight accuracy, targeting, ramp-up stability, salt independence.
- **Decision engine:** one test for every verdict branch, including "significant but under-powered" and "great lift but broken split".
- **API:** validation, exposure deduplication, conversion ordering, the 409 guardrail, forced restarts, auth.
- **SDK:** an end-to-end test against a real HTTP server, asserting that local evaluation matches the server.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs typecheck, tests, and the production build on every push to `main` and on pull requests.
