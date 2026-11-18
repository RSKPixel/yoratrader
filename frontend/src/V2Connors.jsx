import DisasterStop from "./V2Disaster";
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
  ["0d", "Exit on strength"],
];
const INSTRUMENTS = [
  ["cash", "Spot"],
  ["futures", "Futures"],
];
const TIMINGS = [
  ["close", "At close"],
  ["closeopen", "At next open"],
];
const TAKES = [
  ["all", "All signals"],
  ["top5", "Lowest 5 RSI"],
  ["top3", "Lowest 3 RSI"],
];

export default function V2Connors({ params, onParams }) {
  const [savedSetup, setSetup] = useSetting("bt.connors.setup", "rsi2");
  // only the two book setups (more would be curve fitting); an older saved choice falls back to RSI(2)
  const setup = SETUPS.some(([k]) => k === savedSetup) ? savedSetup : "rsi2";
  const [savedHold, setHold] = useSetting("bt.connors.hold", "5d");
  const hold = savedHold === "0d" ? "0d" : "5d"; // 2 days is no longer offered: a saved one reads as 5 days
  const [savedTiming, setTiming] = useSetting("bt.connors.timing", "close");
  // Entry is always at the close; the exit at the close or at the next open (a saved 15:15 / next-open entry reads as the close)
  const timing = savedTiming === "closeopen" ? "closeopen" : "close";
  // No stop in the book; only the 10% disaster stop (as on the other pages): 10% under the buy, the day's low reaching it
  const [disaster, setDisaster] = useSetting("bt.connors.disaster", "on");
  const stop = disaster === "on" ? "10pc" : "none";
  const [take, setTake] = useSetting("bt.connors.take", "all");
  const side = "long"; // long only
  const [instrument, setInstrument] = useSetting("bt.connors.instrument", "cash");
  const [slippage, setSlippage] = useSetting("bt.connors.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const book = !params.maxOpen;
  const futOk = params.universe === "fno"; // futures prices: today's F&O stocks only (not survivorship-free, not the wider lists)
  const query = `dataset=${params.universe}&setup=${setup}&hold=${hold}&timing=${timing}&stop=${stop}&take=${book ? take : "all"}&slippage=${slippage}&max_open=${params.maxOpen}&side=${side}&instrument=${futOk ? instrument : "cash"}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/connors?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;
  const at = timing === "close" ? "the close" : timing === "nextopen" ? "the next open" : timing === "closeopen" ? "the close (sold at the next open)" : "15:15";

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => (t.reason?.startsWith("stop") ? `disaster ${t.reason}` : t.reason), style: (t) => ({ color: t.reason.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Days", cell: (t) => t.days, style: () => ({ color: "var(--muted)" }), },
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
        <Field label="Instrument" hint="Spot: the share's prices, bought and sold for delivery (STT 0.1% each side, stamp duty, DP charge), no rolls, from 2004. Futures: the signal and the fills on the near-month future's own prices (stored futures daily candles, adjusted at each expiry; 2011 on), futures charges, and a roll for a hold across a month end. Only today's F&O stocks have stored futures prices, so choosing Futures switches to today's F&O list (survivorship bias on); switching survivorship bias off goes back to Spot.">
          <Segmented
            label="Instrument"
            options={INSTRUMENTS}
            value={futOk ? instrument : "cash"}
            onChange={(v) => {
              setInstrument(v);
              // futures prices exist only for today's F&O stocks: switch to that list (survivorship bias on)
              if (v === "futures" && !futOk) onParams?.({ universe: "fno", survivor: "today" });
            }}
          />
        </Field>
        <Field label="Setup" hint="In a stock above its 200-day average. RSI(2): Connors & Sen's book; cumulative RSI(2): Connors & Alvarez (Short Term Trading Strategies That Work), today's + yesterday's 2-day RSI.">
          <Segmented label="Setup" options={SETUPS} value={setup} onChange={setSetup} />
        </Field>
        <Field label="Hold" hint="Sold this many trading days after the buy (5 = the book's week), or on strength: at the first close the 2-day RSI is above 65 (5 days at most)">
          <Segmented label="Hold" options={HOLDS} value={hold} onChange={setHold} />
        </Field>
        <Field label="Exit at" hint="Entry is always at the close (the official close; 15:15 in paper trading). The exit (5 days or on strength, as chosen) is decided at a close and done at that close, or at the next day's open.">
          <Segmented label="Exit at" options={TIMINGS} value={timing} onChange={setTiming} />
        </Field>
        <DisasterStop value={disaster} onChange={setDisaster} hits={disaster === "on" ? data?.summary?.disaster_hits : null} />
        {book && (
          <Field label="Take" hint="As per model: each day's picks share a fifth of capital. All signals, or only the day's lowest RSIs.">
            <Segmented label="Take" options={TAKES} value={take} onChange={setTake} />
          </Field>
        )}
        <Field label="Slippage" hint={`Per side, on top of the ${instrument === "cash" || !futOk ? "delivery" : "futures"} charges`}>
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
            {stop !== "none" ? ` · disaster stop on ${s.disaster_hits ?? 0} trades (${s.stopped_pct}%)` : ""}
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
