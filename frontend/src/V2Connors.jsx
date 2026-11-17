import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Short-term mean reversion (Connors & Sen, How Markets Really Work) on v2: long only, F&O stocks above
// their 200-day average that are short-term oversold, held 5 (or 2) trading days.

const SETUPS = [
  ["rsi2", "RSI(2) < 10 (book)"],
  ["cumrsi2", "Cumulative RSI(2) < 35"],
];
const HOLDS = [
  ["5d", "5 days (book)"],
  ["2d", "2 days"],
  ["0d", "Exit on strength"],
];
const TIMINGS = [
  ["close", "Close (2004 on)"],
  ["1515", "15:15 (2015 on)"],
];
const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
  ["2sd", "2σ"],
  ["3pc", "3%"],
  ["5pc", "5%"],
  ["7pc", "7%"],
  ["10pc", "10%"],
];
const SIDES = [
  ["long", "Long (book)"],
  ["short", "Short"],
  ["both", "Long & short"],
];
const TAKES = [
  ["all", "All signals"],
  ["top5", "Lowest 5 RSI"],
  ["top3", "Lowest 3 RSI"],
];

export default function V2Connors({ params }) {
  const [savedSetup, setSetup] = useSetting("bt.connors.setup", "rsi2");
  // only the two book setups (more would be curve fitting); an older saved choice falls back to RSI(2)
  const setup = SETUPS.some(([k]) => k === savedSetup) ? savedSetup : "rsi2";
  const [hold, setHold] = useSetting("bt.connors.hold", "5d");
  const [timing, setTiming] = useSetting("bt.connors.timing", "close");
  const [stop, setStop] = useSetting("bt.connors.stop", "none");
  const [take, setTake] = useSetting("bt.connors.take", "all");
  const [side, setSide] = useSetting("bt.connors.side", "long");
  const [slippage, setSlippage] = useSetting("bt.connors.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const book = !params.maxOpen;
  const query = `dataset=${params.universe}&setup=${setup}&hold=${hold}&timing=${timing}&stop=${stop}&take=${book ? take : "all"}&slippage=${slippage}&max_open=${params.maxOpen}&side=${side}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/connors?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;
  const at = timing === "close" ? "the close" : "15:15";

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Days", cell: (t) => t.days, style: () => ({ color: "var(--muted)" }), title: (t) => (t.rolls ? `${t.rolls} futures roll` : undefined) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    ...(side !== "long"
      ? [{ h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) }]
      : []),
    { h: "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }), title: () => "2-day RSI on the day bought" },
    { h: "Buy", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    ...(stop !== "none" ? [{ h: "Stop", cell: (t) => t.stop ?? "—", style: () => ({ color: "var(--muted)" }) }] : []),
    { h: "Sell", cell: (t) => t.exit },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Setup" hint="In a stock above its 200-day average. RSI(2): Connors & Sen's book; cumulative RSI(2): Connors & Alvarez (Short Term Trading Strategies That Work), today's + yesterday's 2-day RSI.">
          <Segmented label="Setup" options={SETUPS} value={setup} onChange={setSetup} />
        </Field>
        <Field label="Hold" hint="Sold this many trading days after the buy (5 = the book's week), or on strength: at the first close the 2-day RSI is above 65 (5 days at most)">
          <Segmented label="Hold" options={HOLDS} value={hold} onChange={setHold} />
        </Field>
        <Field label="Prices" hint="Close: official closes for the signal, buy and sale (daily candles, 2004 on). 15:15: today's 15:15 price, what you can trade (15m candles, 2015 on); its first load takes ~45 s.">
          <Segmented label="Prices" options={TIMINGS} value={timing} onChange={setTiming} />
        </Field>
        <Field
          label="Side"
          hint="Long (the book): above the 200-day average, 2-day RSI below 10. Short: the mirror image, below the 200-day average with the 2-day RSI above 90, sold short and bought back after the hold. Long & short: either, the most extreme first."
        >
          <Segmented label="Side" options={SIDES} value={side} onChange={setSide} />
        </Field>
        <Field label="Stop" hint="Not in the book. 1σ / 2σ of the stock's last 90 daily returns below the buy price, or a fixed % below it.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
        </Field>
        {book && (
          <Field label="Take" hint="As per model: each day's picks share a fifth of capital. All signals, or only the day's lowest RSIs.">
            <Segmented label="Take" options={TAKES} value={take} onChange={setTake} />
          </Field>
        )}
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && (
          <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
            Loading…
          </span>
        )}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years ·
            held {s.avg_held_days} days · average RSI {s.avg_rsi}
            {stop !== "none" ? ` · ${s.stopped_pct}% stopped` : ""}
          </p>
          <Panel title="Net by month" right="marked daily · trades by sale day · click a month for its trades">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>
          <Panel title="Equity" right="marked daily, fixed capital, not compounded · accent = net, grey = gross">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
      {month && (
        <MonthTradesModal
          month={month}
          url={`/api/v2/backtest/connors/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note={`bought and sold at ${at}`}
          onClose={closeMonth}
          minWidth={1100}
        />
      )}
    </div>
  );
}
