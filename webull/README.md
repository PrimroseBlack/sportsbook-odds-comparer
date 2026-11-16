# BTC 15-Minute Close Probability

At the start of every 15-minute candle, the script sets a **target price** (by default, that candle's open). It then estimates the probability that the candle **closes above or below** the target, and updates the estimate on every bar or tick until the candle closes.

| File | What it is |
|---|---|
| `btc-15m-probability.ts` | The full model in dependency-free TypeScript. It exports `computeProbability()` and a streaming `Btc15mProbabilityTracker`. |
| `btc-15m-probability.pine` | A Pine-style port for Webull's **Script Editor** (it also works in TradingView). Paste it in and run it on a 1-minute BTC chart. |
| `demo.ts` | An example readout plus sanity checks for each factor. |
| `backtest.ts` | A calibration backtest and parameter sweep. It runs on synthetic data or on your own CSV of 1m candles. |

```bash
node --experimental-strip-types webull/demo.ts
```

```bash
node --experimental-strip-types webull/backtest.ts path/to/btc_1m.csv 5 --sweep
```

## The model

1. **Volatility.** A per-minute sigma, made from an EWMA of 1-minute log returns blended with the Parkinson high/low estimator.
2. **Time left.** The remaining move is `sigma * sqrt(minutes left)`. With 1 minute left, a target $50 away is far less reachable than with 12 minutes left.
3. **Slope.** The linear-regression slope of log price over the last 20 bars. It is multiplied by R² (trend quality) and by a shrink factor (`driftShrink`, default 0.25), because short-term momentum mostly fades.
4. **Volume.** Relative volume (last 5 bars vs. the 50-bar average) sets how much the slope is trusted. The up-bar vs. down-bar volume delta adds directional pressure.
5. **Market structure.** Swing pivots give HH/HL = bullish and LH/LL = bearish. Breaking the last swing high or low adds to the score.
6. **Pivots and support/resistance.** The model uses classic floor pivots (P, R1, R2, S1, S2) from the previous 1h, 4h and 1D periods, the previous 15m high/low, recent swing highs/lows, and your own custom levels (for example a round number).

Items 3–5 combine into a **drift**. That drift is capped at `maxDriftSigmas` (0.5σ of the remaining move), so the trend can tilt the odds but can't dominate them.

### How support and resistance change the probability

The terminal price distribution is built from the volatility, time left and drift. Every level then acts as a partial **reflecting barrier**: a share of the probability mass that would finish beyond the level is bounced back (a rejection). That share is the level's **hold probability**:

- **Higher** for stronger pivots (R2/S2 > R1/S1 > P, and 1D > 4h > 1h), for levels with several rejection touches, for high-volume levels, and for clusters of nearby levels (confluence).
- **Lower** when momentum and a volume surge are pushing price into the level (breakout pressure).

The effect is what you described:

| Situation | Effect |
|---|---|
| Target is **above** a resistance (price must break through it) | P(above) drops by about the hold %. |
| Resistance sits just **above** the target | P(above) drops only slightly, because price can still close between the target and the level. |
| Target is **below** a support | P(below) drops, the mirror image. |
| Support between price and a target above it | It catches downside, which slightly helps P(above). |

Levels are classified relative to the **current price**. A broken R1 below price acts as support (a role flip).

The readout shows each stage, so you can see what moved the number:

```
P(close ABOVE) 18.7%   P(close BELOW) 81.3%
  vol+time only 34.9% -> +drift 29.2% -> +levels 18.7%
  nearest R: 102,830.85 [prev 15m low + swing low + swing low + 1h S1] hold 45%
```

## Using it

### In Webull (Script Editor)
1. Open a BTC chart on the **1-minute** timeframe.
2. Open the Script Editor, create a new indicator, and paste in `btc-15m-probability.pine`.
3. A table in the top right shows the target, the time left, P(above)/P(below), and the factor values. A yellow line marks the target. Dashed lines mark the nearest resistance (red) and support (green), labelled with their hold %.

Webull's editor runs a restricted Pine dialect, and I couldn't test this port inside Webull. If it rejects a function (for example `request.security`, `table.new` or arrays), send me the error and I'll swap in a workaround. To drop a factor quickly, turn off the 1D/4h/1h pivot inputs.

### In TypeScript
```ts
import { computeProbability, Btc15mProbabilityTracker } from './btc-15m-probability.ts';

const r = computeProbability(oneMinuteBars, Date.now(), {
  customLevels: [{ price: 100_000, label: 'round number', strength: 0.25 }],
  // targetPrice: 99_850,   // optional fixed target instead of the 15m open
});
console.log(r.summary, r.pAbove, r.pBelow, r.levels);

// Streaming: the target resets automatically at each new 15m interval
const t = new Btc15mProbabilityTracker();
t.seed(historyBars);
onNewBarOrTick((bar) => console.log(t.update(bar).summary));
```
Bars are `{ time (bar open, ms), open, high, low, close, volume }`, oldest first. Give it about 1 day of 1m history so the daily pivots exist.

## Calibrate it on real data (recommended)

On synthetic random-walk data, the volatility + time-left core is well calibrated (predicted ≈ actual in every bucket, Brier 0.132 vs 0.25 for a coin flip). The slope, volume, structure and S/R layers have nothing real to capture in a random walk, so there they only add noise. Whether they help on real BTC is an empirical question.

Get 1-minute BTC candles as CSV and run the command below. Either format works: a header row with `time, open, high, low, close, volume`, or Binance's headerless monthly kline files from data.binance.vision.

```bash
node --experimental-strip-types webull/backtest.ts btc_1m.csv 5 --sweep
```

The sweep grid-searches `levelStrength` × `driftShrink` and prints the best setting. Copy that into the config (TS) or the inputs (Pine). Re-run with `2` or `10` instead of `5` to check other amounts of time left.

## Caveats
- This is a statistical estimate, not a forecast, and not financial advice.
- If you're comparing it against a prediction market (for example a "BTC up or down in 15 min" contract), check that market's exact settlement source and target definition. Set `targetPrice` if it differs from the exchange's 15m open.
