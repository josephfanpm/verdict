---
title: I built an A/B testing platform that refuses to tell you what you want to hear
published: false
tags: typescript, webdev, productmanagement, statistics
cover_image: https://raw.githubusercontent.com/josephfanpm/verdict/main/docs/screenshot-list.png
---

# I built an A/B testing platform that refuses to tell you what you want to hear

If you've worked on a product team, you've probably seen this happen.

An experiment launches on Monday. On Wednesday someone opens the dashboard, sees the new variant up 9% with p = 0.03, and posts a celebration in Slack. The feature ships on Thursday. Three months later, nobody can find the 9% in the revenue numbers.

The dashboard didn't lie, exactly. It answered the question it was asked. The trouble is that "is this p-value below 0.05 right now?" is the wrong question, and most tools are happy to keep answering it.

I'm a product manager. I spend a lot of my time deciding what to build, and experiments are one of the main ways I find out whether I was right. I wanted to understand the machinery underneath them properly, all the way down to the hash function. So I built one: **[Verdict](https://github.com/josephfanpm/verdict)**, a self-hosted feature flag and A/B testing platform whose main job is to make the call for you, including telling you when you can't make one yet.

![The Verdict dashboard](https://raw.githubusercontent.com/josephfanpm/verdict/main/docs/screenshot-list.png)

Each experiment gets one of five verdicts: **Ship it**, **Don't ship**, **Keep running**, **No difference**, or **Investigate**. Every verdict comes with its reasons written out in plain English.

This post covers the four ways experiments usually go wrong, how Verdict guards against each one, and the engineering decisions behind it.

---

## Failure mode 1: Peeking

The Wednesday-afternoon ship is called *peeking*. A p-value threshold of 0.05 promises a 5% false-positive rate, but only if you look **once**, at a sample size you chose in advance. Every extra look is another chance for random noise to cross the line.

I didn't want to take that on faith, so I wrote a simulation. It runs 2,000 A/A tests, where both arms are identical and any "winner" is pure noise, and analyzes them three ways:

```
2,000 A/A tests (no real difference), 10,000 users per arm

Check once at the planned sample:        5.5% false positives
Check every 500 users, stop when p < 0.05: 25.1% false positives
Check every 500 users, sequential test:  1.7% false positives
```

Peeking turns a 1-in-20 false-positive rate into roughly **1 in 4**. You can reproduce it with `npm run peeking`.

My first version fought this the traditional way: compute a sample size up front, and refuse to call a win until every variant reaches it. That works, but it asks people not to look, and people look.

So the default is now a **sequential test**: a mixture sequential probability ratio test, which produces a p-value and confidence interval that stay valid no matter how often you check them. That's the third line above. You can open the dashboard every hour, and a result that crosses the line is real at the moment it crosses. Strong effects ship early, harm gets stopped early, and the price is a wider interval along the way. You can switch an experiment back to a fixed-horizon test if you'd rather have the tighter interval and promise to read it once.

Two more guards sit next to it:

- **A minimum runtime.** A high-traffic test can reach its sample in two days and only ever see a Tuesday and a Wednesday. Verdict won't call a win until users have been enrolled for 7 days by default, so weekday and weekend behavior are both in the data.
- **A locked sample plan.** My first version recomputed the target sample from the control's conversion rate on every read. That means the finish line moves with the data, which is peeking by another name. Now the plan is locked once, from a baseline you state at launch or from the control arm once it has 1,000 users, and every later change to it is logged.

There's one deliberate asymmetry. If a variant is significantly **worse**, Verdict says **Don't ship** right away, without waiting for the minimum runtime. Waiting for statistical purity while real users get a broken experience is a bad trade, and that's a product decision as much as a statistical one.

## Failure mode 2: Winning on the wrong metric

This one I added after using the first version for a while.

The demo includes a free-shipping banner. Orders go up 25.6%, with a confidence interval nowhere near zero. On its own, that's a ship. But refunds go up 81%, because the banner pulls in exactly the kind of orders that come back.

![A guardrail blocks a ship](https://raw.githubusercontent.com/josephfanpm/verdict/main/docs/screenshot-guardrail.png)

**How Verdict handles it:** every experiment has one **goal** metric that decides it, and any number of **guardrail** metrics that can veto it. Each metric knows which direction is good, so fewer refunds counts as an improvement and more refunds counts as harm. If any guardrail gets significantly worse, the verdict is **Don't ship**, and the reasons name the metric and the size of the damage.

Not every goal is yes/no, either. A bundle suggestion in the cart might not change how many people order, only how much they spend, so goals can also be a value per user (revenue) or a ratio (revenue per order). Those use Welch's t-test instead of a proportion test, and per-user values are capped at the 99th percentile by default so one enormous order can't decide the test on its own.

## Failure mode 3: A broken traffic split

This is the one I find most interesting, because the result can look great.

Say you configure an even split, but the new variant has a bug that crashes the page for some users before the "user saw this" event fires. Those users disappear from the data. The users who remain are disproportionately the ones whose browsers worked fine, and they probably convert better anyway. Your treatment now shows a lift, and that lift is an artifact of who got counted.

This is called a **Sample Ratio Mismatch (SRM)**. The check is a chi-square goodness-of-fit test that compares the observed split against the configured weights. Verdict runs it on every experiment *before* it looks at any lift, because if the split is broken, nothing downstream can be trusted.

The demo data includes this exact scenario. In the `onboarding-checklist` experiment, the video player crashes on Safari before the exposure is logged, so `video-tour` silently loses some of its Safari users:

![SRM detected](https://raw.githubusercontent.com/josephfanpm/verdict/main/docs/screenshot-srm.png)

`checklist` shows a **+9.7%** lift. A dashboard that only reported p-values would tell you to ship it. Verdict sees that `video-tour` received 31.0% of traffic when it should have received 33.0%. That's a gap of 2 percentage points, which sounds small, but at 26,000 users the chance of it happening randomly is p = 7.3 × 10⁻¹¹. The verdict is **Investigate**.

"The split is broken" isn't very actionable on its own, so Verdict also runs the check per day and per segment. Here the reasons say *start with browser = safari: the split is furthest off there.* If the break had started on a particular day, it would name the day instead, which usually points at a deploy.

Two more checks sit in the same gate: users who were logged in two variants (more than 1% of them means assignment is unstable), and a comparison of the groups' behavior *before* the experiment started. If the groups already differed before anyone saw anything, the treatment can't be what caused the difference.

I implemented the chi-square distribution myself (a regularized incomplete gamma function, using the series and continued-fraction methods from *Numerical Recipes*) rather than pulling in a stats library. Same for Student's t, through the incomplete beta function. I wanted every number on the screen traceable to a formula I could explain. The tests check each one against published table values.

## Failure mode 4: Editing a running experiment

Halfway through a test, someone decides an even split is too risky and changes it to 90/10. That sounds reasonable. But the users who arrived in week one were split differently from the users arriving in week two, and week-one users may behave differently from week-two users. The final numbers blend two different experiments into one.

**How Verdict handles it:** the API refuses.

```http
PATCH /api/flags/checkout-redesign
{"variants":[{"key":"control","weight":90},{"key":"one-page","weight":10}]}

409 Conflict
{
  "error": "UNSAFE_CHANGE",
  "message": "This experiment already has 37,990 exposures. Changing variants or weights mid-test
              moves users between arms and causes a sample ratio mismatch. Re-send with
              ?force=true to apply it and restart the experiment."
}
```

You can still make the change, but you have to say so explicitly. My first version then deleted the old data and started over. Now it opens a **new phase** with a fresh salt, so users are re-randomized, and the earlier phase stays readable. That matters most after fixing a bug: you want to compare what you had with what you have. Every change also goes into a versioned audit log, and starting, stopping, rolling out and archiving are all explicit, logged steps.

Not every change is dangerous, though. *Raising* a rollout from 10% to 50% is safe, and the reason why is the most interesting engineering detail in the project.

---

## Under the hood

### Deterministic bucketing with independent hashes

Verdict doesn't store "user 42 is in the treatment group." It *computes* it, by hashing the user ID with MurmurHash3 into one of 10,000 buckets. The same input always produces the same bucket, on any server and in any SDK, with no database lookup.

The detail that took me longest to get right: Verdict uses **two independent hashes**.

```ts
const rolloutBucket = bucketFor(`${flag.salt}:rollout:${unitId}`);
if (rolloutBucket >= percentToBuckets(flag.rolloutPercent)) {
  return serve(flag.defaultVariant, 'OUTSIDE_ROLLOUT');
}
const bucket = bucketFor(`${flag.salt}:variant:${unitId}`);
```

The first hash decides *whether* you're in the experiment. The second decides *which* variant you get. Because they're independent, raising the rollout from 10% to 50% only lets new people in. Everyone already enrolled keeps their bucket and their variant. There's a test that enrolls 20,000 users at 10%, raises the rollout to 50%, and checks that every originally enrolled user has the same variant afterward.

The same idea extends to everything that decides who is in a test. A **holdout** (a few percent of users kept on the default experience across many experiments, to measure what shipping added up to) hashes on the holdout's name only, so every experiment behind it holds back the same people. Experiments in a **mutual-exclusion group** share one hash and each own a slice of it, so no user is ever in two of them.

`unitId` is the other change. When a visitor signs up, they get a new id. If bucketing used the account id, logging in could move someone to the other variant mid-session. So Verdict buckets on the id that existed first, the anonymous one, and links the two so a purchase made under the account is credited to the exposure made before it.

### One core, three consumers

All the domain logic (hashing, evaluation, counting, statistics, the decision engine) lives in `src/core` as pure TypeScript with no I/O. The Fastify server imports it, the client SDK imports it, and the React dashboard imports it.

As a result, the SDK can evaluate flags locally with zero network latency, and it's guaranteed to agree with the server because it's the same code. An end-to-end test spins up a real HTTP server and asserts exactly that. The sample size planner in the dashboard likewise runs the same function the decision engine uses, so the planner can never disagree with the verdict. There's also an OpenFeature provider, so an app that already uses the vendor-neutral flag API can switch without touching its call sites.

### Counting conversions correctly

All the counting rules live in one pure function, which made them much easier to test:

1. **First exposure wins.** A user evaluated 10,000 times is counted once, in one variant. A user who shows up in two variants is dropped, and counted, because their result belongs to neither.
2. **Conversions must come after exposure.** A purchase someone made *before* seeing the new checkout can't have been caused by it.
3. **Conversions must land inside the window.** Without a window, users who joined in week one have had weeks to convert and users who joined yesterday have had a day. Users whose window is still open are left out until it closes.
4. **Events count once.** Every event the SDK sends carries an idempotency key, so a retried request after a network failure can't double-count a purchase.

The second rule caught a real bug in my own SDK. The SDK queued events with the client's timestamp but let the server timestamp exposures when they arrived. Since exposures are flushed in a batch *after* the user acts, every conversion appeared to happen before its exposure and was silently dropped. The fix was to timestamp exposures on the client too, and there's now a test for it.

### A rounding bug worth mentioning

Variant weights are percentages, and buckets are integers. My first version rounded each variant's bucket range separately: a 33.3/33.3/33.3 split became 3,333 + 3,333 + 3,333 = 9,999 buckets. One user in ten thousand fell off the end and hit an "unreachable" error. The fix is to round the *cumulative* boundary instead, so the last boundary is always exactly 10,000. It's a small bug, but it's the kind that only shows up in production at scale, so it now has its own regression test.

---

## Stack and scope

- **TypeScript** (strict) end to end
- **Fastify** API with **zod** request validation
- **SQLite** through Node 22's built-in `node:sqlite` driver, so there's nothing to install. Clone it, run it, done.
- **React + Vite** dashboard, with hand-rolled SVG for the confidence-interval chart
- **Vitest**: 123 tests covering hash test vectors, statistical accuracy against published tables, sequential testing by simulation, every verdict branch, the counting rules, API guardrails, and the SDK end to end
- **GitHub Actions** CI and a **Dockerfile** for one-command deploys

The trade-offs I chose deliberately, and what's still missing:

- **SQLite instead of Postgres**, because zero setup matters for a project people want to try. All SQL lives in one `Store` class, so swapping the database touches one file.
- **Results computed on read**, then cached until the next write. That's fine for a couple hundred thousand users; at real scale I'd pre-aggregate.
- **Guardrails aren't corrected for how many there are.** Each one you add is another 5% chance of a false veto. I chose to accept that, because shipping harm costs more than re-running a test, but it's the next thing I'd fix.
- **Segments are exploratory.** The dashboard breaks results down by country, plan or browser, but it never picks a winner from a segment. Slicing until something is significant is how false wins get shipped.

## What building it taught me as a PM

**The hard part of an experimentation platform isn't the statistics. It's choosing defaults.** The math for a z-test fits on an index card. The decisions that took real thought were product decisions: should harm short-circuit the waiting period? Should an unsafe edit be blocked, or warned about? Should a broken guardrail override a winning goal? Each of those is a judgment about which mistake is more expensive, and I'm now a lot more opinionated about each one.

**Making the tool say "I don't know yet" is a feature.** "Keep running: day 3 of 7" is less satisfying than a green checkmark, but it's the answer that protects the team from shipping noise.

**Design for how people actually behave.** My first version told people not to peek. The second one made peeking safe. The second is the better product, even though the first was the "correct" statistics.

**Tests are a spec.** Writing `it("says DON'T SHIP when the goal wins but a guardrail breaks")` forced me to state the product rule precisely before any code existed. That felt a lot like writing acceptance criteria, which is the part of PM work I already do every day.

## How I built it

I built Verdict with an AI coding agent (Claude Code) as a pair programmer. I set the product direction: the problem, the guardrails, the order of operations in the decision engine, and the bar that every statistical claim had to be tested against a published reference value or a simulation. Then I reviewed, questioned, and tested the implementation until I could explain every line. I think this is how a lot of software will get built, and I wanted to get good at doing it rigorously, not just quickly.

## Try it

```bash
git clone https://github.com/josephfanpm/verdict.git
cd verdict && npm install
npm run simulate   # 8 demo experiments and a holdout, ~206k simulated users, about a second
npm run dev        # http://localhost:5173
```

The code is on GitHub at **[josephfanpm/verdict](https://github.com/josephfanpm/verdict)**. If you work on experimentation and think I made the wrong call on one of those defaults, I'd genuinely like to hear the argument.
