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
  zScore: number;
  pValue: number;
  significant: boolean;
}

/**
 * Two-sided two-proportion z-test of treatment vs control.
 *
 * The test statistic uses the pooled standard error (the null hypothesis says
 * both arms share one rate). The relative-lift interval uses the delta method
 * on the ratio of rates, which accounts for noise in both arms.
 */
export function compareProportions(control: Arm, treatment: Arm, alpha = 0.05): Comparison | null {
  if (control.exposures === 0 || treatment.exposures === 0) return null;

  const pC = control.conversions / control.exposures;
  const pT = treatment.conversions / treatment.exposures;
  const pooled = (control.conversions + treatment.conversions) / (control.exposures + treatment.exposures);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / control.exposures + 1 / treatment.exposures));

  const zScore = pooledSe === 0 ? 0 : (pT - pC) / pooledSe;
  const pValue = pooledSe === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(zScore)));

  let relativeLift: number | null = null;
  let relativeLiftInterval: [number, number] | null = null;
  if (pC > 0) {
    const ratio = pT / pC;
    relativeLift = ratio - 1;
    const varC = (pC * (1 - pC)) / control.exposures;
    const varT = (pT * (1 - pT)) / treatment.exposures;
    const ratioSe = Math.sqrt(varT / pC ** 2 + (pT ** 2 * varC) / pC ** 4);
    const zCrit = normalQuantile(1 - alpha / 2);
    relativeLiftInterval = [relativeLift - zCrit * ratioSe, relativeLift + zCrit * ratioSe];
  }

  return {
    controlRate: pC,
    treatmentRate: pT,
    absoluteLift: pT - pC,
    relativeLift,
    relativeLiftInterval,
    zScore,
    pValue,
    significant: pValue < alpha,
  };
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
