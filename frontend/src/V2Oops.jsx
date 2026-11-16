import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Larry Williams' "Oops" gap reversal on v2 (v2oops.py): a stock opens below yesterday's low and is
// bought when it trades back up to that low; out at 15:15, or at the stop below the day's low so far.
// 15-minute candles, today's F&O stocks, 2015 on. Max open = the day's first N fills.

const STOPS = [
  ["low", "Below the day's low"],
  ["none", "None"],
];
const TRENDS = [
  ["any", "Any"],
  ["up", "Above 200-day avg"],
];

export default function V2Oops({ params }) {
  const [stop, setStop] = useSetting("bt.oops.stop", "low");
  const [trend, setTrend] = useSetting("bt.oops.trend", "any");
  const [slippage, setSlippage] = useSetting("bt.oops.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const query = `stop=${stop}&trend=${trend}&slippage=${slippage}&max_open=${params.maxOpen}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/oops?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    { h: "Day", cell: (t) => t.day },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Gap", cell: (t) => `${t.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: (t) => `Opened ${t.open}, yesterday's low ${t.prev_low}` },
    { h: "Filled", cell: (t) => t.fill_at, style: () => ({ color: "var(--muted)" }), title: () => "The 15-minute candle that traded back up to yesterday's low" },
    { h: "Entry", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Stop", cell: (t) => t.stop ?? "—", style: () => ({ color: "var(--muted)" }) },
    { h: "Exit", cell: (t) => t.exit },
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason === "stop" ? "var(--negative)" : "var(--muted)" }) },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Stop" hint="Below the day's low: 0.1% under the day's low at the moment of the buy, checked on every later 15-minute candle. None: out at 15:15 only.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
        </Field>
        <Field label="Trend" hint="Any stock, or only those whose close was above their 200-day average yesterday">
          <Segmented label="Trend" options={TRENDS} value={trend} onChange={setTrend} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && (
          <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
            Loading… (the first load builds the fills from the 15-minute candles, about a minute)
          </span>
        )}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!error && data && !s && <p className="text-sm" style={{ color: "var(--muted)" }}>No trades for these settings.</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years · traded on{" "}
            {s.days_traded} of {s.days} days, {s.avg_positions} a day on average · {s.stopped_pct}% stopped · half the fills by {s.median_fill_at} ·
            today's F&O stocks (15-minute data)
          </p>
          <Panel title="Net by month" right="click a month for its trades">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>
          <Panel title="Equity" right="cumulative, fixed capital, not compounded · accent = net, grey = gross">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
      {month && (
        <MonthTradesModal
          month={month}
          url={`/api/v2/backtest/oops/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="bought when the price trades back up to yesterday's low, out at 15:15 (or the stop)"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
