/**
 * BTC 15-Minute Close Probability
 * --------------------------------
 * At the start of every 15-minute candle the TARGET is set (by default the
 * candle's open price). From then on, every time a new bar or tick arrives, the
 * script estimates the probability that the 15-minute candle CLOSES above or
 * below that target.
 *
 * Factors in the model:
 *   1. Volatility   - EWMA of 1-bar log returns blended with the Parkinson
 *                     high/low range estimator.
 *   2. Time left    - the remaining move scales with sqrt(minutes left), so
 *                     probabilities get more extreme as the candle nears its close.
 *   3. Slope        - linear-regression slope of log price, weighted by R^2
 *                     (trend quality) and shrunk toward zero, because
 *                     short-term momentum is weak.
 *   4. Volume       - relative volume (recent vs. average) scales how much the
 *                     slope is trusted; signed volume delta (up-bar volume minus
 *                     down-bar volume) adds directional pressure.
 *   5. Market       - swing highs/lows -> HH/HL (bullish), LH/LL (bearish),
 *      structure      plus break-of-structure.
 *   6. Pivot points - classic floor pivots (P, R1, R2, S1, S2) from the
 *      & S/R levels   previous 1h / 4h / 1D periods, previous 15m high/low,
 *                     recent swing pivots, and any custom levels you add.
 *
 * How the support/resistance logic works:
 *   The terminal price distribution (log-normal with drift) is built on a grid.
 *   Every resistance level above the current price REFLECTS part of the
 *   probability mass that would finish beyond it back below it ("rejection").
 *   Support levels below the price do the same from underneath. The share of
 *   mass reflected is the level's "hold probability". It is higher for stronger
 *   pivots, levels tested many times, high-volume levels, and clusters of
 *   nearby levels. It is lower when momentum and volume are driving price
 *   into the level (breakout pressure).
 *
 *   Effect: if the target is ABOVE a resistance (price must break the level to
 *   finish above the target), P(above) falls. If a resistance sits just above
 *   the target, price can still finish above the target, but the far upper
 *   tail gets cut off. The same applies in mirror for support and P(below).
 *
 * This file is plain, dependency-free TypeScript (no enums, namespaces or
 * decorators). It runs in any TS/JS runtime, including `node --experimental-strip-types`.
 * Use it on 1-minute bars (best) or any timeframe that divides 15 minutes.
 *
 * Not financial advice. This is a statistical estimate, not a forecast.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Bar {
  /** Bar OPEN time in milliseconds since epoch (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type LevelSource = 'pivot' | 'swing' | 'prevInterval' | 'custom';

export interface CustomLevel {
  price: number;
  label?: string;
  /** Base hold probability 0..1 (default 0.20). */
  strength?: number;
}

export interface Config {
  /** Candle length you are predicting, in minutes. */
  intervalMinutes: number;
  /** Fixed target price. Leave undefined to use the open of the current interval. */
  targetPrice?: number;
  /** Bars used for the regression slope / volume delta. */
  slopeLookback: number;
  /** Bars used for the volatility estimate. */
  volLookback: number;
  /** EWMA decay for squared returns (RiskMetrics uses 0.94). */
  ewmaLambda: number;
  /** Bars used for the average-volume baseline. */
  volumeLookback: number;
  /** Bars treated as "recent" for relative volume. */
  recentVolumeBars: number;
  /** Bars on each side required to confirm a swing high/low. */
  swingStrength: number;
  /** How far back (bars) to look for swings and level touches. */
  levelLookback: number;
  /** Max swing highs and max swing lows to use as levels. */
  maxSwingsPerSide: number;
  /** Use the previous 15m candle's high/low as levels. */
  usePrevIntervalLevels: boolean;
  /** Higher-timeframe periods (minutes) for classic floor pivots. */
  pivotPeriodsMinutes: number[];
  /** Extra levels you want considered (e.g. a round number like 100000). */
  customLevels: CustomLevel[];
  /** Multiplier on the regression slope (0 = ignore slope, 1 = full extrapolation). */
  driftShrink: number;
  /** Cap on total drift over the remaining time, in sigmas of the remaining move. */
  maxDriftSigmas: number;
  /** Weight of the volume-delta term (in sigma-per-minute units). */
  volumeDeltaWeight: number;
  /** Weight of the market-structure term (in sigma-per-minute units). */
  structureWeight: number;
  /** Ignore levels farther than this many sigmas of the remaining move. */
  levelZoneSigmas: number;
  /** Global multiplier on every level's hold probability (0 = ignore levels). Tune with backtest.ts. */
  levelStrength: number;
  /** Max share of mass a single level/cluster can reflect. */
  maxHoldProb: number;
  /** Probabilities are clamped to [floor, 1 - floor]. */
  probFloor: number;
}

export const DEFAULT_CONFIG: Config = {
  intervalMinutes: 15,
  targetPrice: undefined,
  slopeLookback: 20,
  volLookback: 60,
  ewmaLambda: 0.94,
  volumeLookback: 50,
  recentVolumeBars: 5,
  swingStrength: 3,
  levelLookback: 240,
  maxSwingsPerSide: 3,
  usePrevIntervalLevels: true,
  pivotPeriodsMinutes: [60, 240, 1440],
  customLevels: [],
  driftShrink: 0.25,
  maxDriftSigmas: 0.5,
  volumeDeltaWeight: 0.08,
  structureWeight: 0.06,
  levelZoneSigmas: 4,
  levelStrength: 1,
  maxHoldProb: 0.45,
  probFloor: 0.01,
};

export interface LevelReport {
  price: number;
  label: string;
  role: 'resistance' | 'support';
  /** Probability the level/cluster rejects price that reaches it (0..1). */
  holdProb: number;
  /** Rejection touches in the lookback window. */
  touches: number;
  /** Distance from current price in sigmas of the remaining move. */
  distanceSigmas: number;
}

export interface ProbabilityResult {
  now: number;
  intervalStart: number;
  intervalEnd: number;
  secondsLeft: number;
  price: number;
  target: number;
  targetSource: 'override' | 'intervalOpen' | 'lastClose';
  /** Final probability the 15m candle closes ABOVE the target. */
  pAbove: number;
  /** Final probability the 15m candle closes BELOW the target. */
  pBelow: number;
  /** P(above) at each stage, so you can see what moved the number. */
  breakdown: {
    /** Volatility + time left only (no drift, no levels). */
    volatilityOnly: number;
    /** + slope, volume, market structure. */
    withDrift: number;
    /** + support / resistance / pivots (equals pAbove before clamping). */
    withLevels: number;
  };
  volatility: {
    /** 1-minute sigma, percent. */
    perMinutePct: number;
    /** Sigma of the move over the time left, percent. */
    remainingPct: number;
    /** One-sigma move over the time left, in price units. */
    remainingPrice: number;
  };
  slope: { perMinutePct: number; r2: number };
  volume: { relative: number; delta: number };
  structure: { score: number; label: string };
  /** Expected log drift per minute used by the model, percent. */
  driftPerMinutePct: number;
  levels: LevelReport[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

const MS_PER_MIN = 60_000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Last n items; unlike arr.slice(-n), returns [] when n is 0. */
function lastN<T>(arr: T[], n: number): T[] {
  return n > 0 ? arr.slice(-n) : [];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function medianBarMs(bars: Bar[]): number {
  const diffs: number[] = [];
  for (let i = Math.max(1, bars.length - 200); i < bars.length; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return MS_PER_MIN;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// ---------------------------------------------------------------------------
// Factor calculations
// ---------------------------------------------------------------------------

/** Per-bar sigma of log returns: blend of EWMA close-to-close and Parkinson range. */
function estimateSigmaPerBar(bars: Bar[], cfg: Config): number {
  const window = bars.slice(-Math.max(cfg.volLookback + 1, 3));
  let ewVar = NaN;
  for (let i = 1; i < window.length; i++) {
    const r = Math.log(window[i].close / window[i - 1].close);
    ewVar = Number.isNaN(ewVar) ? r * r : cfg.ewmaLambda * ewVar + (1 - cfg.ewmaLambda) * r * r;
  }
  if (Number.isNaN(ewVar)) ewVar = 0;

  const hl2 = window
    .filter((b) => b.high > 0 && b.low > 0)
    .map((b) => {
      const x = Math.log(b.high / b.low);
      return x * x;
    });
  const parkVar = mean(hl2) / (4 * Math.LN2);

  // Floor at 0.5 bp per bar so a flat feed never produces 0% / 100%.
  return Math.max(Math.sqrt(0.5 * ewVar + 0.5 * parkVar), 0.00005);
}

/** OLS slope of log(close) per bar, plus R^2. */
function regressionSlope(bars: Bar[], lookback: number): { slope: number; r2: number } {
  const w = bars.slice(-lookback);
  const n = w.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const ys = w.map((b) => Math.log(b.close));
  const xMean = (n - 1) / 2;
  const yMean = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    const dy = ys[i] - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, r2 };
}

function volumeStats(bars: Bar[], cfg: Config): { relative: number; delta: number; avg: number } {
  const recent = lastN(bars, cfg.recentVolumeBars);
  const base = bars.slice(Math.max(0, bars.length - cfg.volumeLookback - cfg.recentVolumeBars), bars.length - cfg.recentVolumeBars);
  const avg = mean(base.map((b) => b.volume));
  const relative = avg > 0 ? mean(recent.map((b) => b.volume)) / avg : 1;

  let signed = 0;
  let total = 0;
  for (const b of bars.slice(-cfg.slopeLookback)) {
    const dir = b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
    signed += dir * b.volume;
    total += b.volume;
  }
  return { relative, delta: total > 0 ? signed / total : 0, avg: avg || mean(recent.map((b) => b.volume)) };
}

interface Swing {
  index: number;
  price: number;
}

function findSwings(bars: Bar[], k: number): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k && (isHigh || isLow); j++) {
      if (j === i) continue;
      // Strict on the left, non-strict on the right, so a flat top is counted once.
      if (j < i ? bars[j].high >= bars[i].high : bars[j].high > bars[i].high) isHigh = false;
      if (j < i ? bars[j].low <= bars[i].low : bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high });
    if (isLow) lows.push({ index: i, price: bars[i].low });
  }
  return { highs, lows };
}

/** Market structure score in [-1, 1]: HH+HL = bullish, LH+LL = bearish, +/- break of structure. */
function marketStructure(
  swings: { highs: Swing[]; lows: Swing[] },
  price: number,
): { score: number; label: string } {
  const { highs, lows } = swings;
  if (highs.length < 2 || lows.length < 2) return { score: 0, label: 'insufficient swings' };
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const hh = h2.price > h1.price;
  const hl = l2.price > l1.price;
  let score = (hh ? 0.5 : -0.5) + (hl ? 0.5 : -0.5);
  let label = hh && hl ? 'uptrend (HH/HL)' : !hh && !hl ? 'downtrend (LH/LL)' : 'range / mixed';
  if (price > h2.price) {
    score += 0.5;
    label += ', broke above last swing high';
  } else if (price < l2.price) {
    score -= 0.5;
    label += ', broke below last swing low';
  }
  return { score: clamp(score, -1, 1), label };
}

interface RawLevel {
  price: number;
  label: string;
  source: LevelSource;
  base: number;
}

function floorPivots(bars: Bar[], now: number, periodMin: number, barMs: number): RawLevel[] {
  const periodMs = periodMin * MS_PER_MIN;
  const curStart = Math.floor(now / periodMs) * periodMs;
  const prevStart = curStart - periodMs;
  const prev = bars.filter((b) => b.time >= prevStart && b.time < curStart);
  // Require at least half the expected bars, otherwise the pivots are meaningless.
  if (prev.length < Math.max(1, Math.floor(periodMs / barMs / 2))) return [];
  const H = Math.max(...prev.map((b) => b.high));
  const L = Math.min(...prev.map((b) => b.low));
  const C = prev[prev.length - 1].close;
  const P = (H + L + C) / 3;
  const tf = periodMin >= 1440 ? `${periodMin / 1440}D` : periodMin >= 60 ? `${periodMin / 60}h` : `${periodMin}m`;
  const w = periodMin >= 1440 ? 1 : periodMin >= 240 ? 0.85 : 0.7;
  return [
    { price: P, label: `${tf} P`, source: 'pivot', base: 0.12 * w },
    { price: 2 * P - L, label: `${tf} R1`, source: 'pivot', base: 0.16 * w },
    { price: 2 * P - H, label: `${tf} S1`, source: 'pivot', base: 0.16 * w },
    { price: P + (H - L), label: `${tf} R2`, source: 'pivot', base: 0.18 * w },
    { price: P - (H - L), label: `${tf} S2`, source: 'pivot', base: 0.18 * w },
  ];
}

function collectLevels(
  bars: Bar[],
  now: number,
  intervalStart: number,
  intervalMs: number,
  barMs: number,
  swings: { highs: Swing[]; lows: Swing[] },
  cfg: Config,
): RawLevel[] {
  const levels: RawLevel[] = [];

  for (const p of cfg.pivotPeriodsMinutes) levels.push(...floorPivots(bars, now, p, barMs));

  const prevInt = bars.filter((b) => b.time >= intervalStart - intervalMs && b.time < intervalStart);
  if (cfg.usePrevIntervalLevels && prevInt.length) {
    levels.push({ price: Math.max(...prevInt.map((b) => b.high)), label: 'prev 15m high', source: 'prevInterval', base: 0.12 });
    levels.push({ price: Math.min(...prevInt.map((b) => b.low)), label: 'prev 15m low', source: 'prevInterval', base: 0.12 });
  }

  const minIdx = bars.length - cfg.levelLookback;
  for (const s of lastN(swings.highs.filter((s) => s.index >= minIdx), cfg.maxSwingsPerSide)) {
    levels.push({ price: s.price, label: 'swing high', source: 'swing', base: 0.14 });
  }
  for (const s of lastN(swings.lows.filter((s) => s.index >= minIdx), cfg.maxSwingsPerSide)) {
    levels.push({ price: s.price, label: 'swing low', source: 'swing', base: 0.14 });
  }

  for (const c of cfg.customLevels) {
    levels.push({ price: c.price, label: c.label ?? 'custom', source: 'custom', base: c.strength ?? 0.2 });
  }
  return levels.filter((l) => Number.isFinite(l.price) && l.price > 0);
}

// ---------------------------------------------------------------------------
// Terminal distribution with support / resistance reflection
// ---------------------------------------------------------------------------

interface Barrier {
  logPrice: number;
  hold: number;
}

/**
 * P(log terminal price > logTarget) for a normal(m, s) distribution where each
 * barrier reflects `hold` of the mass that would end beyond it back to the other
 * side (mirror image about the barrier). Resistances are applied nearest-first
 * going up; supports nearest-first going down.
 */
function probAboveWithBarriers(
  m: number,
  s: number,
  logPrice: number,
  logTarget: number,
  barriers: Barrier[],
): number {
  const N = 1601;
  const span = 8 * s;
  const x0 = m - span;
  const dx = (2 * span) / (N - 1);
  const mass = new Float64Array(N);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const z = (x0 + i * dx - m) / s;
    mass[i] = Math.exp(-0.5 * z * z);
    total += mass[i];
  }
  for (let i = 0; i < N; i++) mass[i] /= total;

  const idx = (x: number) => clamp(Math.round((x - x0) / dx), 0, N - 1);

  const res = barriers.filter((b) => b.logPrice > logPrice).sort((a, b) => a.logPrice - b.logPrice);
  const sup = barriers.filter((b) => b.logPrice < logPrice).sort((a, b) => b.logPrice - a.logPrice);

  for (const r of res) {
    const ri = idx(r.logPrice);
    for (let i = ri + 1; i < N; i++) {
      if (mass[i] === 0) continue;
      const moved = mass[i] * r.hold;
      mass[i] -= moved;
      mass[idx(2 * r.logPrice - (x0 + i * dx))] += moved;
    }
  }
  for (const sp of sup) {
    const si = idx(sp.logPrice);
    for (let i = si - 1; i >= 0; i--) {
      if (mass[i] === 0) continue;
      const moved = mass[i] * sp.hold;
      mass[i] -= moved;
      mass[idx(2 * sp.logPrice - (x0 + i * dx))] += moved;
    }
  }

  // Sum mass above the target; each cell spans [x - dx/2, x + dx/2].
  let p = 0;
  for (let i = 0; i < N; i++) {
    const above = clamp((x0 + i * dx + dx / 2 - logTarget) / dx, 0, 1);
    if (above > 0) p += mass[i] * above;
  }
  return clamp(p, 0, 1);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param bars  Bars sorted oldest -> newest. 1-minute bars recommended, with at
 *              least ~1 day of history so the daily pivots exist. The last bar
 *              may be the live (still forming) bar.
 * @param now   Current time in ms. Defaults to Date.now(). Pass it explicitly
 *              when backtesting.
 */
export function computeProbability(
  bars: Bar[],
  now: number = Date.now(),
  config: Partial<Config> = {},
): ProbabilityResult {
  const cfg: Config = { ...DEFAULT_CONFIG, ...config };
  if (bars.length < 10) throw new Error('Need at least 10 bars');

  const barMs = medianBarMs(bars);
  const barMin = barMs / MS_PER_MIN;
  const intervalMs = cfg.intervalMinutes * MS_PER_MIN;
  const intervalStart = Math.floor(now / intervalMs) * intervalMs;
  const intervalEnd = intervalStart + intervalMs;
  const secondsLeft = Math.max((intervalEnd - now) / 1000, 1);
  const T = secondsLeft / 60; // minutes left

  const price = bars[bars.length - 1].close;

  // ---- Target --------------------------------------------------------------
  let target = price;
  let targetSource: ProbabilityResult['targetSource'] = 'lastClose';
  if (cfg.targetPrice !== undefined && cfg.targetPrice > 0) {
    target = cfg.targetPrice;
    targetSource = 'override';
  } else {
    const first = bars.find((b) => b.time >= intervalStart && b.time < intervalEnd);
    if (first) {
      target = first.open;
      targetSource = 'intervalOpen';
    }
  }

  // ---- Volatility (per minute) --------------------------------------------
  const sigmaBar = estimateSigmaPerBar(bars, cfg);
  const sigmaMin = sigmaBar / Math.sqrt(barMin);
  const sRem = sigmaMin * Math.sqrt(T); // sigma of log move over the time left

  // ---- Slope, volume, structure -> drift -----------------------------------
  const reg = regressionSlope(bars, cfg.slopeLookback);
  const slopeMin = reg.slope / barMin;
  const vol = volumeStats(bars, cfg);
  const volumeConfidence = clamp(Math.sqrt(vol.relative), 0.6, 1.5);
  const swings = findSwings(bars.slice(-cfg.levelLookback - cfg.swingStrength), cfg.swingStrength);
  // Re-index swings to the full bar array.
  const offset = Math.max(0, bars.length - cfg.levelLookback - cfg.swingStrength);
  for (const s of swings.highs) s.index += offset;
  for (const s of swings.lows) s.index += offset;
  const structure = marketStructure(swings, price);

  let mu =
    slopeMin * reg.r2 * cfg.driftShrink * volumeConfidence +
    sigmaMin * (cfg.volumeDeltaWeight * vol.delta * volumeConfidence + cfg.structureWeight * structure.score);
  // Cap the total expected move to maxDriftSigmas of the remaining sigma.
  const maxMu = (cfg.maxDriftSigmas * sRem) / T;
  mu = clamp(mu, -maxMu, maxMu);

  const logP = Math.log(price);
  const logK = Math.log(target);
  const m = logP + mu * T;

  // ---- Levels -------------------------------------------------------------
  const raw = collectLevels(bars, now, intervalStart, intervalMs, barMs, swings, cfg);
  const touchBars = bars.slice(-cfg.levelLookback);
  const tol = price * sigmaBar * 0.5;
  const driftSigmas = Math.abs(mu * T) / sRem;
  const momentum = clamp(driftSigmas / cfg.maxDriftSigmas, 0, 1);

  interface Scored extends RawLevel {
    hold: number;
    touches: number;
    role: 'resistance' | 'support';
  }
  const scored: Scored[] = [];
  for (const l of raw) {
    if (Math.abs(Math.log(l.price / price)) > cfg.levelZoneSigmas * sRem) continue;
    const role: Scored['role'] = l.price > price ? 'resistance' : 'support';

    // Rejection touches: bar reached the level but closed back on our side of it.
    let touches = 0;
    let touchVol = 0;
    for (const b of touchBars) {
      const hit =
        role === 'resistance' ? b.high >= l.price - tol && b.close < l.price : b.low <= l.price + tol && b.close > l.price;
      if (hit) {
        touches++;
        touchVol += b.volume;
      }
    }
    const volFactor = touches && vol.avg > 0 ? clamp(Math.sqrt(touchVol / touches / vol.avg), 0.85, 1.25) : 1;

    let hold = l.base * cfg.levelStrength * (1 + 0.1 * Math.min(touches, 4)) * volFactor;
    const towards = (role === 'resistance' && mu > 0) || (role === 'support' && mu < 0);
    if (towards) {
      hold *= 1 - 0.4 * momentum; // momentum into the level -> breakout more likely
      if (vol.relative > 1.5) hold *= 0.85; // volume surge into the level
    } else {
      hold *= 1 + 0.15 * momentum; // price moving away -> level more likely to hold on a retest
    }
    scored.push({ ...l, hold: clamp(hold, 0, cfg.maxHoldProb), touches, role });
  }

  // Merge nearby levels (confluence): combined hold = 1 - prod(1 - h_i).
  scored.sort((a, b) => a.price - b.price);
  const clusterTol = Math.max(price * 0.0005, 0.25 * sRem * price);
  const clusters: LevelReport[] = [];
  let group: Scored[] = [];
  const flush = () => {
    if (!group.length) return;
    const wSum = group.reduce((a, g) => a + g.hold, 0) || 1;
    const p = group.reduce((a, g) => a + g.price * g.hold, 0) / wSum;
    const hold = clamp(1 - group.reduce((a, g) => a * (1 - g.hold), 1), 0, cfg.maxHoldProb);
    clusters.push({
      price: p,
      label: group.map((g) => g.label).join(' + '),
      role: p > price ? 'resistance' : 'support',
      holdProb: hold,
      touches: group.reduce((a, g) => a + g.touches, 0),
      distanceSigmas: Math.log(p / price) / sRem,
    });
    group = [];
  };
  for (const l of scored) {
    if (group.length && (l.price - group[group.length - 1].price > clusterTol || l.role !== group[0].role)) flush();
    group.push(l);
  }
  flush();

  // ---- Probabilities -------------------------------------------------------
  const volatilityOnly = 1 - normCdf((logK - logP) / sRem);
  const withDrift = 1 - normCdf((logK - m) / sRem);
  const withLevels = probAboveWithBarriers(
    m,
    sRem,
    logP,
    logK,
    clusters.map((c) => ({ logPrice: Math.log(c.price), hold: c.holdProb })),
  );
  const pAbove = clamp(withLevels, cfg.probFloor, 1 - cfg.probFloor);

  const result: ProbabilityResult = {
    now,
    intervalStart,
    intervalEnd,
    secondsLeft,
    price,
    target,
    targetSource,
    pAbove,
    pBelow: 1 - pAbove,
    breakdown: { volatilityOnly, withDrift, withLevels },
    volatility: { perMinutePct: sigmaMin * 100, remainingPct: sRem * 100, remainingPrice: price * sRem },
    slope: { perMinutePct: slopeMin * 100, r2: reg.r2 },
    volume: { relative: vol.relative, delta: vol.delta },
    structure,
    driftPerMinutePct: mu * 100,
    levels: clusters,
    summary: '',
  };
  result.summary = formatSummary(result);
  return result;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function pct(x: number, d = 1): string {
  return `${(x * 100).toFixed(d)}%`;
}

function money(x: number): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatSummary(r: ProbabilityResult): string {
  const mm = Math.floor(r.secondsLeft / 60);
  const ss = Math.floor(r.secondsLeft % 60)
    .toString()
    .padStart(2, '0');
  const nearestR = r.levels.filter((l) => l.role === 'resistance').sort((a, b) => a.price - b.price)[0];
  const nearestS = r.levels.filter((l) => l.role === 'support').sort((a, b) => b.price - a.price)[0];
  const lines = [
    `BTC 15m | target ${money(r.target)} (${r.targetSource}) | price ${money(r.price)} | ${mm}:${ss} left`,
    `P(close ABOVE) ${pct(r.pAbove)}   P(close BELOW) ${pct(r.pBelow)}`,
    `  vol+time only ${pct(r.breakdown.volatilityOnly)} -> +drift ${pct(r.breakdown.withDrift)} -> +levels ${pct(r.breakdown.withLevels)}`,
    `  sigma(remaining) ${r.volatility.remainingPct.toFixed(3)}% (~${money(r.volatility.remainingPrice)})`,
    `  slope ${r.slope.perMinutePct.toFixed(4)}%/min (R2 ${r.slope.r2.toFixed(2)}) | relVol ${r.volume.relative.toFixed(2)}x | volDelta ${r.volume.delta.toFixed(2)}`,
    `  structure: ${r.structure.label} (${r.structure.score.toFixed(2)})`,
  ];
  if (nearestR) lines.push(`  nearest R: ${money(nearestR.price)} [${nearestR.label}] hold ${pct(nearestR.holdProb, 0)}`);
  if (nearestS) lines.push(`  nearest S: ${money(nearestS.price)} [${nearestS.label}] hold ${pct(nearestS.holdProb, 0)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Streaming helper: feed bars/ticks as they arrive
// ---------------------------------------------------------------------------

/**
 * Keeps a rolling bar buffer and recomputes on every update. The target resets
 * automatically when a new 15-minute interval begins.
 *
 *   const tracker = new Btc15mProbabilityTracker();
 *   tracker.seed(historicalOneMinuteBars);
 *   onBarUpdate(bar => console.log(tracker.update(bar).summary));
 */
export class Btc15mProbabilityTracker {
  private bars: Bar[] = [];
  private readonly cfg: Partial<Config>;
  private readonly maxBars: number;

  constructor(config: Partial<Config> = {}, maxBars = 2000) {
    this.cfg = config;
    this.maxBars = maxBars;
  }

  seed(bars: Bar[]): void {
    this.bars = bars.slice(-this.maxBars);
  }

  /** Add a new bar, or replace the last one if it has the same open time (live bar update). */
  update(bar: Bar, now: number = Date.now()): ProbabilityResult {
    const last = this.bars[this.bars.length - 1];
    if (last && last.time === bar.time) this.bars[this.bars.length - 1] = bar;
    else this.bars.push(bar);
    if (this.bars.length > this.maxBars) this.bars.shift();
    return computeProbability(this.bars, now, this.cfg);
  }
}
