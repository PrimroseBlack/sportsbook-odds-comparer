/**
 * Demo + sanity checks for btc-15m-probability.ts using synthetic 1-minute BTC bars.
 * (Calibration lives in backtest.ts.)
 *
 *   node --experimental-strip-types webull/demo.ts
 */
import { computeProbability, normCdf, type Bar, type Config } from './btc-15m-probability.ts';

const MIN = 60_000;

/** Deterministic RNG (mulberry32) + Box-Muller so runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Random-walk 1m bars with ~0.08%/min volatility and 30 sub-ticks per bar for high/low. */
function makeBars(n: number, seed: number, start = Date.UTC(2026, 10, 14), startPrice = 95_000, driftPerMin = 0): Bar[] {
  const r = rng(seed);
  const bars: Bar[] = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    const open = p;
    let hi = p;
    let lo = p;
    for (let k = 0; k < 30; k++) {
      p *= Math.exp(driftPerMin / 30 + (0.0008 / Math.sqrt(30)) * gaussian(r));
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    bars.push({ time: start + i * MIN, open, high: hi, low: lo, close: p, volume: 20 + 15 * r() });
  }
  return bars;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// 1. Live-style readout
// ---------------------------------------------------------------------------
const bars = makeBars(2 * 1440, 7);
// "now" = 6.5 minutes into the most recent 15m interval.
const lastOpen = bars[bars.length - 1].time;
const intervalStart = Math.floor(lastOpen / (15 * MIN)) * 15 * MIN;
const live = bars.filter((b) => b.time < intervalStart + 7 * MIN);
const now = intervalStart + 6.5 * MIN;
const res = computeProbability(live, now);
console.log('\n=== Example readout ===\n' + res.summary + '\n');
console.log('Levels considered:');
for (const l of res.levels) {
  console.log(`  ${l.role.padEnd(10)} ${l.price.toFixed(2).padStart(10)}  hold ${(l.holdProb * 100).toFixed(0).padStart(2)}%  ${l.distanceSigmas.toFixed(2).padStart(6)}σ  ${l.label}`);
}

// ---------------------------------------------------------------------------
// 2. Factor sanity checks
// ---------------------------------------------------------------------------
console.log('\n=== Sanity checks ===');
const price = live[live.length - 1].close;
const neutral: Partial<Config> = {
  pivotPeriodsMinutes: [],
  maxSwingsPerSide: 0,
  usePrevIntervalLevels: false,
  driftShrink: 0,
  volumeDeltaWeight: 0,
  structureWeight: 0,
};

const atTheMoney = computeProbability(live, now, { ...neutral, targetPrice: price });
check('target == price, no drift/levels -> 50%', Math.abs(atTheMoney.pAbove - 0.5) < 0.01, `${(atTheMoney.pAbove * 100).toFixed(2)}%`);

const above = price * 1.001;
const early = computeProbability(live, intervalStart + 1 * MIN, { ...neutral, targetPrice: above });
const late = computeProbability(live, intervalStart + 14 * MIN, { ...neutral, targetPrice: above });
check('less time left -> lower chance to reach a target above', late.pAbove < early.pAbove, `14m left ${(early.pAbove * 100).toFixed(1)}% vs 1m left ${(late.pAbove * 100).toFixed(1)}%`);

const target = price * (1 + res.volatility.remainingPct / 100); // target 1 sigma above
const noRes = computeProbability(live, now, { ...neutral, targetPrice: target });
const resBetween = computeProbability(live, now, {
  ...neutral,
  targetPrice: target,
  customLevels: [{ price: price + (target - price) * 0.5, label: 'test R', strength: 0.5 }],
});
check('resistance between price and target lowers P(above)', resBetween.pAbove < noRes.pAbove - 0.02, `${(noRes.pAbove * 100).toFixed(1)}% -> ${(resBetween.pAbove * 100).toFixed(1)}%`);

const resBeyond = computeProbability(live, now, {
  ...neutral,
  targetPrice: target,
  customLevels: [{ price: target + (target - price) * 0.5, label: 'R beyond target', strength: 0.5 }],
});
check('resistance just beyond target: P(above) falls less than resistance in the way', resBeyond.pAbove < noRes.pAbove && resBeyond.pAbove > resBetween.pAbove, `${(resBeyond.pAbove * 100).toFixed(1)}%`);

const below = price * (1 - res.volatility.remainingPct / 100);
const noSup = computeProbability(live, now, { ...neutral, targetPrice: below });
const supBetween = computeProbability(live, now, {
  ...neutral,
  targetPrice: below,
  customLevels: [{ price: price - (price - below) * 0.5, label: 'test S', strength: 0.5 }],
});
check('support between price and target lowers P(below)', supBetween.pBelow < noSup.pBelow - 0.02, `${(noSup.pBelow * 100).toFixed(1)}% -> ${(supBetween.pBelow * 100).toFixed(1)}%`);

const trending = makeBars(2 * 1440, 11, Date.UTC(2026, 10, 14), 95_000, 0.0003);
const tStart = Math.floor(trending[trending.length - 1].time / (15 * MIN)) * 15 * MIN;
const tLive = trending.filter((b) => b.time < tStart + 7 * MIN);
const tPrice = tLive[tLive.length - 1].close;
const trendRes = computeProbability(tLive, tStart + 6.5 * MIN, { pivotPeriodsMinutes: [], maxSwingsPerSide: 0, usePrevIntervalLevels: false, targetPrice: tPrice });
check('uptrend (slope/structure/volume) -> P(above) > 50% at target == price', trendRes.pAbove > 0.5, `${(trendRes.pAbove * 100).toFixed(1)}%, ${trendRes.structure.label}`);

// The Pine port uses a closed-form formula for one resistance + one support.
// Check it matches the engine's grid when there is a single level per side.
function closedForm(price: number, target: number, sRem: number, mu: number, T: number, R?: { p: number; h: number }, S?: { p: number; h: number }): number {
  const [lnP, lnK] = [Math.log(price), Math.log(target)];
  const m = lnP + mu * T;
  const above = (x: number) => 1 - normCdf((x - m) / sRem);
  let p = above(lnK);
  if (R) {
    const lr = Math.log(R.p);
    p -= R.h * (lnK >= lr ? above(lnK) : above(2 * lr - lnK));
  }
  if (S) {
    const ls = Math.log(S.p);
    p += S.h * (lnK <= ls ? 1 - above(lnK) : 1 - above(2 * ls - lnK));
  }
  return p;
}
const sR = res.volatility.remainingPct / 100;
for (const [name, tgt, lvlR, lvlS] of [
  ['R between price and target', price * (1 + sR), price * (1 + sR / 2), undefined],
  ['R beyond target', price * (1 + sR / 2), price * (1 + sR), undefined],
  ['S between price and target', price * (1 - sR), undefined, price * (1 - sR / 2)],
  ['R + S, target below price', price * (1 - sR / 3), price * (1 + sR / 2), price * (1 - sR / 1.5)],
] as const) {
  const levels = [lvlR, lvlS].filter((x): x is number => x !== undefined).map((p) => ({ price: p, strength: 0.4 }));
  const e = computeProbability(live, now, { ...neutral, targetPrice: tgt, customLevels: levels });
  const hR = e.levels.find((l) => l.role === 'resistance');
  const hS = e.levels.find((l) => l.role === 'support');
  const cf = closedForm(price, tgt, sR, 0, 8.5, hR && { p: hR.price, h: hR.holdProb }, hS && { p: hS.price, h: hS.holdProb });
  // With levels on BOTH sides the engine also re-reflects mass bounced from one level
  // onto the other; the closed form ignores that second-order bounce, so allow 1%.
  const tolerance = lvlR !== undefined && lvlS !== undefined ? 0.01 : 0.002;
  check(`Pine closed form matches engine: ${name}`, Math.abs(cf - e.breakdown.withLevels) < tolerance, `engine ${(e.breakdown.withLevels * 100).toFixed(2)}% vs closed form ${(cf * 100).toFixed(2)}%`);
}

console.log('\nFor calibration on synthetic or real candles run: node --experimental-strip-types webull/backtest.ts');
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
