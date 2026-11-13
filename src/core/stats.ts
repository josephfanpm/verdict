/**
 * The statistics behind the verdict, implemented from first principles with
 * no dependencies so every number on the dashboard can be traced to a formula.
 */

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/** Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

/** P(Z <= z) for a standard normal Z. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Inverse of normalCdf (Acklam's algorithm, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be in (0, 1)');

  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];

  const tailCut = 0.02425;
  if (p < tailCut) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  if (p > 1 - tailCut) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) / (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
}

/** ln Γ(x) via the Lanczos approximation. */
function lnGamma(x: number): number {
  const coefficients = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const c of coefficients) series += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
function upperIncompleteGamma(a: number, x: number): number {
  if (x <= 0) return 1;
  const EPS = 1e-14;
  const TINY = 1e-300;
  const logPrefix = -x + a * Math.log(x) - lnGamma(a);

  if (x < a + 1) {
    // Series expansion converges quickly here; it computes P, so return 1 - P.
    let ap = a;
    let term = 1 / a;
    let sum = term;
    for (let i = 0; i < 1000; i++) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return 1 - sum * Math.exp(logPrefix);
  }

  // Continued fraction (modified Lentz) converges quickly for larger x.
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(logPrefix) * h;
}

/** P(X >= statistic) for a chi-square distribution with the given degrees of freedom. */
export function chiSquarePValue(statistic: number, degreesOfFreedom: number): number {
  return upperIncompleteGamma(degreesOfFreedom / 2, statistic / 2);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const EPS = 1e-14;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(a, b, x)) / a : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student's t distribution. */
export function studentTCdf(t: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(degreesOfFreedom) || degreesOfFreedom > 1e6) return normalCdf(t);
  const tail = 0.5 * incompleteBeta(degreesOfFreedom / (degreesOfFreedom + t * t), degreesOfFreedom / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Inverse of studentTCdf, by bisection (the CDF is monotone, so this always converges). */
export function studentTQuantile(p: number, degreesOfFreedom: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be in (0, 1)');
  if (!Number.isFinite(degreesOfFreedom) || degreesOfFreedom > 1e6) return normalQuantile(p);
  if (p === 0.5) return 0;
  // The t quantile is always at least as far from zero as the normal quantile.
  let low = p > 0.5 ? 0 : -1;
  let high = p > 0.5 ? 1 : 0;
  if (p > 0.5) while (studentTCdf(high, degreesOfFreedom) < p) high *= 2;
  else while (studentTCdf(low, degreesOfFreedom) > p) low *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, degreesOfFreedom) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// Experiment statistics
// ---------------------------------------------------------------------------

export interface Arm {
  exposures: number;
  conversions: number;
}

export interface Comparison {
  controlRate: number;
  treatmentRate: number;
  absoluteLift: number;
  /** Relative lift (0.12 = +12%), null if the control converted no one. */
  relativeLift: number | null;
  /** Confidence interval for the relative lift. */
  relativeLiftInterval: [number, number] | null;
  /** Confidence interval for the absolute difference. */
  absoluteInterval: [number, number];
  zScore: number;
  pValue: number;
  significant: boolean;
  /** Which test produced the p-value and interval. */
  method: 'z' | 't' | 'sequential';
}

/**
 * Sequential testing. A fixed-horizon test is only valid if it is read once,
 * at the planned sample size. The always-valid version (a mixture sequential
 * probability ratio test with a normal mixing prior) stays valid no matter how
 * often it is read, at the cost of a wider interval.
 *
 * `tuning` is the total sample size at which the interval should be tightest;
 * the planned sample size is the natural choice.
 */
export interface SequentialOptions {
  tuning: number;
}

function mixingScale(alpha: number, tuning: number): number {
  const a = -2 * Math.log(alpha);
  return (a + Math.log(a + 1)) / Math.max(1, tuning);
}

/** The always-valid replacement for the z critical value at total sample size n. */
export function sequentialCritical(n: number, alpha: number, tuning: number): number {
  const nr = n * mixingScale(alpha, tuning);
  return Math.sqrt(((2 * (nr + 1)) / nr) * Math.log(Math.sqrt(nr + 1) / alpha));
}

/** Always-valid p-value for a z statistic observed at total sample size n. */
export function sequentialPValue(z: number, n: number, alpha: number, tuning: number): number {
  const nr = n * mixingScale(alpha, tuning);
  return Math.min(1, Math.sqrt(nr + 1) * Math.exp((-z * z * nr) / (2 * (nr + 1))));
}

interface Estimate {
  control: number;
  treatment: number;
  /** Standard error used for the test statistic. */
  testSe: number;
  /** Standard error of the absolute difference, used for its interval. */
  diffSe: number;
  /** Standard error of the relative lift (delta method), or null when control is not positive. */
  relativeSe: number | null;
  /** Total users across both arms. */
  n: number;
  /** Degrees of freedom for a t-test; omit for a z-test. */
  degreesOfFreedom?: number;
}

function conclude(e: Estimate, alpha: number, sequential?: SequentialOptions): Comparison {
  const diff = e.treatment - e.control;
  const zScore = e.testSe === 0 ? 0 : diff / e.testSe;

  let pValue: number;
  let critical: number;
  let method: Comparison['method'];
  if (sequential) {
    method = 'sequential';
    critical = sequentialCritical(e.n, alpha, sequential.tuning);
    pValue = e.testSe === 0 ? 1 : sequentialPValue(zScore, e.n, alpha, sequential.tuning);
  } else if (e.degreesOfFreedom !== undefined) {
    method = 't';
    critical = studentTQuantile(1 - alpha / 2, e.degreesOfFreedom);
    pValue = e.testSe === 0 ? 1 : 2 * (1 - studentTCdf(Math.abs(zScore), e.degreesOfFreedom));
  } else {
    method = 'z';
    critical = normalQuantile(1 - alpha / 2);
    pValue = e.testSe === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(zScore)));
  }

  const relativeLift = e.control > 0 ? e.treatment / e.control - 1 : null;
  return {
    controlRate: e.control,
    treatmentRate: e.treatment,
    absoluteLift: diff,
    relativeLift,
    relativeLiftInterval:
      relativeLift !== null && e.relativeSe !== null ? [relativeLift - critical * e.relativeSe, relativeLift + critical * e.relativeSe] : null,
    absoluteInterval: [diff - critical * e.diffSe, diff + critical * e.diffSe],
    zScore,
    pValue,
    significant: pValue < alpha,
    method,
  };
}

/**
 * Two-sided two-proportion z-test of treatment vs control.
 *
 * The test statistic uses the pooled standard error (the null hypothesis says
 * both arms share one rate). The relative-lift interval uses the delta method
 * on the ratio of rates, which accounts for noise in both arms.
 */
export function compareProportions(control: Arm, treatment: Arm, alpha = 0.05, sequential?: SequentialOptions): Comparison | null {
  if (control.exposures === 0 || treatment.exposures === 0) return null;

  const pC = control.conversions / control.exposures;
  const pT = treatment.conversions / treatment.exposures;
  const pooled = (control.conversions + treatment.conversions) / (control.exposures + treatment.exposures);
  const varC = (pC * (1 - pC)) / control.exposures;
  const varT = (pT * (1 - pT)) / treatment.exposures;

  return conclude(
    {
      control: pC,
      treatment: pT,
      testSe: Math.sqrt(pooled * (1 - pooled) * (1 / control.exposures + 1 / treatment.exposures)),
      diffSe: Math.sqrt(varC + varT),
      relativeSe: pC > 0 ? Math.sqrt(varT / pC ** 2 + (pT ** 2 * varC) / pC ** 4) : null,
      n: control.exposures + treatment.exposures,
    },
    alpha,
    sequential
  );
}

/** A per-user average and how much it varies from user to user. */
export interface Moments {
  n: number;
  mean: number;
  /** Sample variance of the per-user values. */
  variance: number;
}

/**
 * Welch's t-test for metrics that are not yes/no: revenue per user, events per
 * user, or anything else with a per-user value. Unlike the pooled test it does
 * not assume both arms vary by the same amount.
 */
export function compareMeans(control: Moments, treatment: Moments, alpha = 0.05, sequential?: SequentialOptions): Comparison | null {
  if (control.n < 2 || treatment.n < 2) return null;

  const varC = control.variance / control.n;
  const varT = treatment.variance / treatment.n;
  const se = Math.sqrt(varC + varT);
  const denominator = varC ** 2 / (control.n - 1) + varT ** 2 / (treatment.n - 1);

  return conclude(
    {
      control: control.mean,
      treatment: treatment.mean,
      testSe: se,
      diffSe: se,
      relativeSe: control.mean > 0 ? Math.sqrt(varT / control.mean ** 2 + (treatment.mean ** 2 * varC) / control.mean ** 4) : null,
      n: control.n + treatment.n,
      degreesOfFreedom: denominator > 0 ? (varC + varT) ** 2 / denominator : control.n + treatment.n - 2,
    },
    alpha,
    sequential
  );
}

/**
 * Everything needed to analyze one metric in one arm, kept as running sums so
 * arms can be added together and no per-user data has to be retained.
 *   y = the user's metric value, d = the user's denominator (ratio metrics),
 *   x = the user's value for the same metric before the experiment (CUPED).
 */
export interface ArmStats {
  n: number;
  /** Users whose value is above zero. */
  converters: number;
  sum: number;
  sumSq: number;
  dSum: number;
  dSumSq: number;
  ydSum: number;
  xSum: number;
  xSumSq: number;
  xySum: number;
}

export function emptyArmStats(): ArmStats {
  return { n: 0, converters: 0, sum: 0, sumSq: 0, dSum: 0, dSumSq: 0, ydSum: 0, xSum: 0, xSumSq: 0, xySum: 0 };
}

export function addObservation(stats: ArmStats, y: number, d = 0, x = 0): void {
  stats.n += 1;
  if (y > 0) stats.converters += 1;
  stats.sum += y;
  stats.sumSq += y * y;
  stats.dSum += d;
  stats.dSumSq += d * d;
  stats.ydSum += y * d;
  stats.xSum += x;
  stats.xSumSq += x * x;
  stats.xySum += x * y;
}

/** Arm stats for a yes/no metric, from plain counts. */
export function armFromCounts(exposures: number, conversions: number): ArmStats {
  return { ...emptyArmStats(), n: exposures, converters: conversions, sum: conversions, sumSq: conversions };
}

export function meanMoments(s: ArmStats): Moments {
  const mean = s.n === 0 ? 0 : s.sum / s.n;
  return { n: s.n, mean, variance: s.n < 2 ? 0 : Math.max(0, (s.sumSq - s.n * mean * mean) / (s.n - 1)) };
}

/**
 * A ratio of two per-user totals (revenue per order, clicks per session). The
 * numerator and denominator come from the same users, so they move together;
 * the delta method folds that correlation into one per-user variance.
 */
export function ratioMoments(s: ArmStats): Moments {
  if (s.n < 2 || s.dSum === 0) return { n: s.n, mean: 0, variance: 0 };
  const yBar = s.sum / s.n;
  const dBar = s.dSum / s.n;
  const ratio = s.sum / s.dSum;
  const varY = (s.sumSq - s.n * yBar * yBar) / (s.n - 1);
  const varD = (s.dSumSq - s.n * dBar * dBar) / (s.n - 1);
  const cov = (s.ydSum - s.n * yBar * dBar) / (s.n - 1);
  return { n: s.n, mean: ratio, variance: Math.max(0, (varY - 2 * ratio * cov + ratio * ratio * varD) / (dBar * dBar)) };
}

export interface CupedResult {
  /** How strongly pre-experiment behavior predicts in-experiment behavior. */
  theta: number;
  adjusted: Moments[];
  /** Share of variance removed (0.3 = the test needs about 30% fewer users). */
  varianceReduction: number;
}

/**
 * CUPED: subtract the part of each user's result that their pre-experiment
 * behavior already predicted. Randomization makes that part equal across arms
 * on average, so removing it leaves the treatment effect untouched while
 * shrinking the noise around it.
 */
export function cuped(arms: ArmStats[]): CupedResult | null {
  const total = arms.reduce((s, a) => s + a.n, 0);
  if (total < 2 || arms.some((a) => a.n < 2)) return null;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  const within = arms.map((a) => {
    const xBar = a.xSum / a.n;
    const yBar = a.sum / a.n;
    const part = { xx: a.xSumSq - a.n * xBar * xBar, xy: a.xySum - a.n * xBar * yBar, yy: a.sumSq - a.n * yBar * yBar, xBar, yBar };
    sxx += part.xx;
    sxy += part.xy;
    syy += part.yy;
    return part;
  });
  if (sxx <= 0 || syy <= 0) return null;

  const theta = sxy / sxx;
  const xBarAll = arms.reduce((s, a) => s + a.xSum, 0) / total;
  const adjusted = arms.map((a, i) => {
    const w = within[i]!;
    return {
      n: a.n,
      mean: w.yBar - theta * (w.xBar - xBarAll),
      variance: Math.max(0, (w.yy - 2 * theta * w.xy + theta * theta * w.xx) / (a.n - 1)),
    };
  });
  return { theta, adjusted, varianceReduction: Math.max(0, (sxy * sxy) / (sxx * syy)) };
}

/** Users needed per variant to detect a relative lift of `mde` in a per-user average. */
export function requiredSampleSizeMean(mean: number, standardDeviation: number, mde: number, alpha = 0.05, power = 0.8): number {
  const delta = Math.abs(mean * mde);
  if (!(delta > 0) || !(standardDeviation > 0)) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil((2 * z * z * standardDeviation * standardDeviation) / (delta * delta));
}

/**
 * Users needed *per variant* to detect a relative lift of `mde` over
 * `baselineRate` with the given false-positive rate (alpha) and power.
 */
export function requiredSampleSize(baselineRate: number, mde: number, alpha = 0.05, power = 0.8): number {
  const p1 = baselineRate;
  const p2 = baselineRate * (1 + mde);
  if (!(p1 > 0 && p1 < 1) || !(p2 > 0 && p2 < 1) || p1 === p2) return Number.POSITIVE_INFINITY;

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  const numerator = zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(numerator ** 2 / (p2 - p1) ** 2);
}

export interface SrmResult {
  statistic: number;
  pValue: number;
  /** True when the observed split is too far from the configured weights to be chance. */
  mismatch: boolean;
  expectedShares: number[];
  observedShares: number[];
}

/**
 * Sample Ratio Mismatch check: a chi-square goodness-of-fit test of observed
 * exposure counts against the configured weights. A tiny p-value means users
 * are being lost or double-counted somewhere, and the results cannot be
 * trusted no matter how good they look. The 0.001 threshold is the common
 * industry default because this check runs constantly and must rarely cry wolf.
 */
export function sampleRatioMismatch(observed: number[], weights: number[], threshold = 0.001): SrmResult {
  const total = observed.reduce((s, n) => s + n, 0);
  const weightTotal = weights.reduce((s, w) => s + w, 0);
  const expectedShares = weights.map((w) => w / weightTotal);
  const observedShares = observed.map((n) => (total === 0 ? 0 : n / total));

  if (total === 0) {
    return { statistic: 0, pValue: 1, mismatch: false, expectedShares, observedShares };
  }

  let statistic = 0;
  let degreesOfFreedom = -1;
  observed.forEach((n, i) => {
    const expected = total * expectedShares[i]!;
    if (expected > 0) {
      statistic += (n - expected) ** 2 / expected;
      degreesOfFreedom += 1;
    }
  });

  const pValue = degreesOfFreedom > 0 ? chiSquarePValue(statistic, degreesOfFreedom) : 1;
  return { statistic, pValue, mismatch: pValue < threshold, expectedShares, observedShares };
}
