/**
 * Calibration backtest for btc-15m-probability.ts.
 *
 *   node --experimental-strip-types webull/backtest.ts                 # synthetic data
 *   node --experimental-strip-types webull/backtest.ts btc_1m.csv      # your own 1m candles
 *   node --experimental-strip-types webull/backtest.ts btc_1m.csv 5    # check 5 min before close (default)
 *   node --experimental-strip-types webull/backtest.ts btc_1m.csv 5 --sweep   # grid-search the tuning knobs
 *
 * CSV: one row per 1-minute bar. With a header row, columns are matched by name
 * (time|open_time_ms|timestamp, open, high, low, close, volume). Without one
 * (Binance kline dumps), the first six columns are time, open, high, low, close,
 * volume. Times may be epoch ms, epoch microseconds, epoch seconds, or ISO strings.
 *
 * For each 15-minute candle the model is run with N minutes left, and the
 * prediction is scored against the actual close. A well-calibrated model has
 * "predicted" close to "actual" in every bucket. Brier score: lower is better,
 * 0.25 = coin flip.
 */
import { readFileSync } from 'node:fs';
import { computeProbability, type Bar, type Config, type ProbabilityResult } from './btc-15m-probability.ts';

const MIN = 60_000;
const INTERVAL = 15 * MIN;
const HISTORY = 1500; // bars passed to the model each time (~1 day + pivots)

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function parseTime(v: string): number {
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n > 1e14 ? Math.floor(n / 1000) : n;
  return Date.parse(v.endsWith('Z') || v.includes('+') ? v : v + 'Z');
}

function loadCsv(path: string): Bar[] {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  // Headerless files (e.g. Binance data.binance.vision klines): time, open, high, low, close, volume, ...
  if (Number.isFinite(Number(lines[0].split(',')[0]))) lines.unshift('time,open,high,low,close,volume');
  const head = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const col = (names: string[]) => {
    const i = head.findIndex((h) => names.includes(h));
    if (i < 0) throw new Error(`CSV is missing a column named one of: ${names.join(', ')}`);
    return i;
  };
  const t = col(['open_time_ms', 'time', 'timestamp', 'open_time', 'date', 'datetime']);
  const [o, h, l, c, v] = [col(['open']), col(['high']), col(['low']), col(['close']), col(['volume', 'vol'])];
  return lines
    .slice(1)
    .map((line) => line.split(','))
    .map((f) => ({ time: parseTime(f[t]), open: +f[o], high: +f[h], low: +f[l], close: +f[c], volume: +f[v] }))
    .filter((b) => Number.isFinite(b.time) && b.close > 0)
    .sort((a, b) => a.time - b.time);
}

/**
 * Synthetic BTC-like 1m bars: GARCH(1,1) volatility clustering, Student-t(4)
 * shocks, 30 sub-ticks per bar (so high/low behave like a real continuous
 * market), and volume that rises with volatility. There is no real
 * support/resistance or momentum in this data, so it tests the volatility and
 * time math. Only real data can test the level and drift effects.
 */
function synthetic(nBars: number, seed = 2026): Bar[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const studentT4 = () => {
    let chi = 0;
    for (let i = 0; i < 4; i++) chi += gauss() ** 2;
    return gauss() / Math.sqrt(chi / 4) / Math.SQRT2; // unit variance
  };

  const longRunVar = 0.0008 ** 2; // ~0.08% per minute
  const [w, alpha, beta] = [longRunVar * 0.04, 0.08, 0.88];
  let v = longRunVar;
  let p = 95_000;
  let prevR = 0;
  const SUB = 30;
  const bars: Bar[] = [];
  const start = Date.UTC(2026, 8, 1);
  for (let i = 0; i < nBars; i++) {
    v = w + alpha * prevR * prevR + beta * v;
    const sub = Math.sqrt(v / SUB);
    const open = p;
    let hi = p;
    let lo = p;
    for (let k = 0; k < SUB; k++) {
      p *= Math.exp(sub * studentT4());
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    prevR = Math.log(p / open);
    bars.push({ time: start + i * MIN, open, high: hi, low: lo, close: p, volume: (10 + 20 * rand()) * Math.sqrt(v / longRunVar) });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

interface Score {
  brier: number;
  logLoss: number;
  n: number;
  buckets: { n: number; p: number; hit: number }[];
}

function newScore(): Score {
  return { brier: 0, logLoss: 0, n: 0, buckets: Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 })) };
}

function add(s: Score, p: number, y: number): void {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  s.brier += (p - y) ** 2;
  s.logLoss += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  s.n++;
  const b = s.buckets[Math.min(9, Math.floor(p * 10))];
  b.n++;
  b.p += p;
  b.hit += y;
}

export function runBacktest(bars: Bar[], minutesLeft = 5, log = true, config: Partial<Config> = {}): Record<string, Score> {
  const stages: Record<string, (r: ProbabilityResult) => number> = {
    'volatility + time only': (r) => r.breakdown.volatilityOnly,
    '+ slope/volume/structure': (r) => r.breakdown.withDrift,
    '+ support/resistance (final)': (r) => r.pAbove,
  };
  const scores: Record<string, Score> = Object.fromEntries(Object.keys(stages).map((k) => [k, newScore()]));

  const byTime = new Map<number, number>();
  bars.forEach((b, i) => byTime.set(b.time, i));

  const first = Math.ceil(bars[Math.min(HISTORY, bars.length - 1)].time / INTERVAL) * INTERVAL;
  const last = bars[bars.length - 1].time;
  let skipped = 0;
  for (let start = first; start + INTERVAL <= last; start += INTERVAL) {
    const now = start + INTERVAL - minutesLeft * MIN;
    const cut = byTime.get(now); // first bar we are NOT allowed to see
    const closeIdx = byTime.get(start + INTERVAL - MIN);
    const openIdx = byTime.get(start);
    if (cut === undefined || closeIdx === undefined || openIdx === undefined) {
      skipped++;
      continue;
    }
    const hist = bars.slice(Math.max(0, cut - HISTORY), cut);
    const r = computeProbability(hist, now, config);
    if (r.targetSource !== 'intervalOpen') {
      skipped++;
      continue;
    }
    const finalClose = bars[closeIdx].close;
    if (finalClose === r.target) continue; // exact tie: neither above nor below
    const y = finalClose > r.target ? 1 : 0;
    for (const [k, f] of Object.entries(stages)) add(scores[k], f(r), y);
  }

  if (log) {
    console.log(`Checked with ${minutesLeft} min left; skipped ${skipped} intervals with missing bars.\n`);
    for (const [k, s] of Object.entries(scores)) {
      console.log(`${k}:  Brier ${(s.brier / s.n).toFixed(4)}  logLoss ${(s.logLoss / s.n).toFixed(4)}  (n=${s.n})`);
      console.log('   predicted   actual      n');
      for (const b of s.buckets) {
        if (b.n) console.log(`   ${((b.p / b.n) * 100).toFixed(1).padStart(7)}%  ${((b.hit / b.n) * 100).toFixed(1).padStart(6)}%  ${String(b.n).padStart(5)}`);
      }
      console.log('');
    }
  }
  return scores;
}

/** Grid-search levelStrength x driftShrink and print the final-stage Brier score of each combo. */
function sweep(bars: Bar[], minutesLeft: number): void {
  const FINAL = '+ support/resistance (final)';
  const levelStrengths = [0, 0.5, 1, 1.5, 2];
  const drifts = [0, 0.15, 0.25, 0.5];
  console.log(`Brier score (lower is better), ${minutesLeft} min left. Rows: levelStrength, columns: driftShrink`);
  console.log('        ' + drifts.map((d) => `drift ${d}`.padStart(11)).join(''));
  let best = { brier: Infinity, levelStrength: 0, driftShrink: 0 };
  for (const levelStrength of levelStrengths) {
    const row: string[] = [];
    for (const driftShrink of drifts) {
      // driftShrink 0 also turns off the volume-delta and structure drift terms.
      const cfg: Partial<Config> = driftShrink === 0 ? { levelStrength, driftShrink, volumeDeltaWeight: 0, structureWeight: 0 } : { levelStrength, driftShrink };
      const s = runBacktest(bars, minutesLeft, false, cfg)[FINAL];
      const brier = s.brier / s.n;
      if (brier < best.brier) best = { brier, levelStrength, driftShrink };
      row.push(brier.toFixed(4).padStart(11));
    }
    console.log(`lvl ${String(levelStrength).padEnd(4)}` + row.join(''));
  }
  console.log(`\nBest: levelStrength=${best.levelStrength}, driftShrink=${best.driftShrink} (Brier ${best.brier.toFixed(4)})`);
  console.log('Put those values in your config. Prefer the simpler setting unless the gain is clear.');
}

const args = process.argv.slice(2);
const doSweep = args.includes('--sweep');
const [csvPath, minsArg] = args.filter((a) => !a.startsWith('--'));
const isMain = process.argv[1]?.endsWith('backtest.ts');
if (isMain) {
  const bars = csvPath ? loadCsv(csvPath) : synthetic(3000 * 15 + HISTORY);
  console.log(`${csvPath ? `Loaded ${bars.length} bars from ${csvPath}` : `Synthetic data: ${bars.length} bars`}`);
  const mins = minsArg ? Number(minsArg) : 5;
  if (doSweep) sweep(bars, mins);
  else runBacktest(bars, mins);
}
