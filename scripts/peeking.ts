/**
 * Why peeking is dangerous, and what makes it safe: simulate A/A tests (both
 * arms identical, so every "win" is a false positive) and compare
 *   1. checking once at the planned sample size,
 *   2. checking after every batch of users with the same fixed-horizon test,
 *   3. checking after every batch with the sequential (always-valid) test.
 *
 *   npm run peeking
 */
import { compareProportions } from '../src/core/stats.js';

const EXPERIMENTS = 2_000;
const USERS_PER_ARM = 10_000;
const CHECK_EVERY = 500;
const RATE = 0.1;

let seed = 42;
function random(): number {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

let fixedHorizonWins = 0;
let peekingWins = 0;
let sequentialWins = 0;
const sequential = { tuning: USERS_PER_ARM * 2 };

for (let e = 0; e < EXPERIMENTS; e++) {
  let a = 0;
  let b = 0;
  let calledEarly = false;
  let calledSequentially = false;
  for (let n = 1; n <= USERS_PER_ARM; n++) {
    if (random() < RATE) a++;
    if (random() < RATE) b++;
    if (n % CHECK_EVERY === 0) {
      const control = { exposures: n, conversions: a };
      const treatment = { exposures: n, conversions: b };
      if (!calledEarly) calledEarly = compareProportions(control, treatment)!.significant;
      if (!calledSequentially) calledSequentially = compareProportions(control, treatment, 0.05, sequential)!.significant;
    }
  }
  if (calledEarly) peekingWins++;
  if (calledSequentially) sequentialWins++;
  if (compareProportions({ exposures: USERS_PER_ARM, conversions: a }, { exposures: USERS_PER_ARM, conversions: b })!.significant) {
    fixedHorizonWins++;
  }
}

const pct = (n: number) => `${((n / EXPERIMENTS) * 100).toFixed(1)}%`;
console.log(`${EXPERIMENTS.toLocaleString('en-US')} A/A tests (no real difference), ${USERS_PER_ARM.toLocaleString('en-US')} users per arm\n`);
console.log(`Check once at the planned sample:        ${pct(fixedHorizonWins)} false positives`);
console.log(`Check every ${CHECK_EVERY} users, stop when p < 0.05: ${pct(peekingWins)} false positives`);
console.log(`Check every ${CHECK_EVERY} users, sequential test:  ${pct(sequentialWins)} false positives`);
