import { useEffect, useState } from "react";
// The rules each model keeps fixed (not settings on its page), shown under Instrument on every backtest
// and paper page so the whole model is visible. Values mirror the backend constants (backtest.py GAP_*,
// xsmr.py, connors.py, v2oops.py, v2ltlv.py, qmom.py, xsmom.py, pairs.py, v2tom.py, v2mix.py).

const RSI_COMMON = [
  ["Trend filter", "close above its 200-day average"],
  ["RSI", "Wilder's 2-day RSI"],
  ["Ranking", "most oversold first, into free slots"],
  ["Longest hold", "5 trading days"],
  ["Entry / exit", "at the close (or 15:15, as chosen)"],
  ["Data check", "90% of the last 200 closes; a daily move over 20% earns nothing"],
];

const RULES = {
  "buy-on-gap": [
    ["Signal", "open below the previous low by more than 1σ (short side: above the previous high)"],
    ["σ", "standard deviation of the last 90 daily returns"],
    ["Trend filter", "open above the 20-day average (short side: below)"],
    ["Ranking", "biggest gaps first"],
    ["Entry", "the 09:15 open"],
    ["Exit", "15:15 the same day"],
  ],
  "gap-momentum": [
    ["Signal", "open above the previous high by more than 0.1σ (short: below the previous low)"],
    ["σ", "standard deviation of the last 90 daily returns"],
    ["Filter / ranking", "none: every qualifying symbol trades"],
    ["Entry", "the 09:15 open"],
    ["Exit", "15:15 the same day"],
  ],
  "xs-mean-reversion": [
    ["Signal", "open vs the previous close"],
    ["Picks", "furthest below the day's average move bought, furthest above shorted"],
    ["Size", "equal value a position, as many shorts as longs"],
    ["Entry", "at the open (09:15 unless chosen later)"],
    ["Exit", "15:15 the same day"],
    ["Data check", "moves over 20% left out; days with under 20 priced stocks skipped"],
  ],
  oops: [
    ["Signal", "open below the previous day's low"],
    ["Entry", "a buy-stop at the previous low: bought when the price climbs back to it"],
    ["Order", "first to touch, first bought"],
    ["Side / trend", "long only, any trend"],
    ["Data", "futures since 2015"],
  ],
  "short-term-reversion": [["Setup", "2-day RSI below 10"], ...RSI_COMMON, ["Exit on strength", "first close with RSI(2) above 65"]],
  "cumulative-rsi": [["Setup", "today's + yesterday's 2-day RSI below 35"], ...RSI_COMMON, ["Exit on strength", "first close with RSI(2) above 65"]],
  "low-volatility": [
    ["Market filter", "Nifty 50 above its 200-day average (else no new buys)"],
    ["Setup", "close above its own 200-day average"],
    ["Ranking", "lowest volatility first (standard deviation of the last 100 daily returns)"],
    ["Entry / exit", "at the close"],
    ["Side", "long only"],
  ],
  "quant-momentum": [
    ["Momentum", "return from 12 months ago to 1 month ago"],
    ["Selection", "top 10%, then the smoother half (frog-in-the-pan)"],
    ["Rebalance", "end of Feb, May, Aug and Nov"],
    ["Side", "long only"],
  ],
  "xs-momentum": [
    ["Rank", "return over the last 252 trading days"],
    ["Picks", "long the strongest, short the weakest"],
    ["Hold", "25 trading days"],
    ["Data check", "253 straight closes; daily moves over 20% earn nothing"],
  ],
  pairs: [
    ["Pairs", "two stocks of the same NSE industry"],
    ["Formation", "the previous calendar year: Engle-Granger cointegration test on daily closes"],
    ["Entry", "spread's z-score beyond ±1"],
    ["Exit", "z-score crosses 0"],
    ["Lookback", "the spread's half-life"],
    ["Prices", "the close the signal is computed from"],
  ],
  kbdt: [
    ["Entry", "at the key-breakout level, on 15-minute candles"],
    ["Exit", "15:15 on the last holding day"],
    ["Limit", "one position per symbol at a time"],
  ],
  "turn-of-month": [
    ["Sell", "close of the 3rd trading day of the next month"],
    ["Size", "one position, the whole capital"],
    ["Side", "long only"],
  ],
  "books-gold": [
    ["Split", "the books' share half RSI(2), half low volatility"],
    ["RSI(2) book", "F&O, max 3, 5-day hold, at the close"],
    ["Low volatility book", "max 10, 20% trailing stop"],
    ["Gold", "GOLDBEES, topped up or trimmed back each month-end"],
  ],
};

// A "Rules" button (next to the page title) that opens the model's fixed rules in a dialog.
export default function FixedRules({ id, paper = false, label = "" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  let rules = RULES[id];
  if (!rules) return null;
  if (paper) // the paper books trade at the 15:15 run
    rules = rules.map(([k, v]) => (k === "Entry / exit" ? [k, "15:15 (the paper run)"] : [k, v]));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        title="The model's fixed rules (not settings)"
      >
        Rules
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4 pt-16" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${label} fixed rules`}
            className="w-full max-w-xl rounded-lg border p-4"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">{label || "Rules"}</h2>
                <p className="text-xs" style={{ color: "var(--muted)" }}>Fixed rules: the model's own, not settings, so nothing here can be tuned</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border px-3 py-1 text-sm transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--border)" }}
              >
                Close
              </button>
            </div>
            <dl className="flex flex-col">
              {rules.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-3 border-t py-2 text-sm first:border-t-0" style={{ borderColor: "var(--border)" }}>
                  <dt style={{ color: "var(--muted)" }}>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
