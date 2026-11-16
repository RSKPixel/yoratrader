import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Key Breakout Dow Theory on v2: the stored backtest trades (both sides: buy the key break up, sell
// the break down; one position per symbol) sized by the common parameters.

const HOLDS = [
  ["1d", "1 day"],
  ["3d", "3 days"],
  ["5d", "5 days (default)"],
];
const STOP_MODES = [
  ["model", "Model (prev day)"],
  ["fixed", "Fixed %"],
  ["cap", "Model, capped %"],
];
const STOP_PCTS = [
  [0.5, "0.5%"],
  [0.75, "0.75%"],
  [1, "1%"],
  [1.5, "1.5%"],
  [2, "2%"],
];

export default function V2Kbdt({ params }) {
  const [hold, setHold] = useSetting("bt.kbdt.hold", "5d");
  const [stopMode, setStopMode] = useSetting("bt.kbdt.stopMode", "model");
  const [stopPct, setStopPct] = useSetting("bt.kbdt.stopPct", 1);
  const [slippage, setSlippage] = useSetting("bt.kbdt.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const query = `dataset=${params.universe}&hold=${hold}&stop_mode=${stopMode}&stop_pct=${stopPct}&slippage=${slippage}&max_open=${params.maxOpen}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/kbdt?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Symbol", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "Entry", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Stop", cell: (t) => t.stop, style: () => ({ color: "var(--muted)" }) },
    { h: "Exit", cell: (t) => t.exit },
    { h: "R", cell: (t) => t.r.toFixed(2), style: (t) => ({ color: tone(t.r) }) },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }), title: (t) => (t.rolls ? `Includes ${t.rolls} futures roll` : undefined) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Exit" hint="Out at 15:15 on this trading day (entry day = day 1), unless the stop is hit first">
          <Segmented label="Exit" options={HOLDS} value={hold} onChange={setHold} />
        </Field>
        <Field label="Stop" hint="Model: the previous day's low (longs) or high (shorts). Fixed: this % from the entry instead. Capped: the model stop, but never further than this %.">
          <Segmented label="Stop" options={STOP_MODES} value={stopMode} onChange={setStopMode} />
        </Field>
        {stopMode !== "model" && (
          <Field label="Stop %">
            <Segmented label="Stop %" options={STOP_PCTS} value={stopPct} onChange={setStopPct} />
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

      {params.maxOpen === 0 && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          As per model: every trade risks 1% of capital at its stop (1R = 1%), at most 3 new trades a day
          {s?.avg_size_pct ? `; positions average ${s.avg_size_pct}% of capital, and several can be open at once` : ""}.
        </p>
      )}
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!error && data && !s && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          No trades stored for this universe and setting yet.
        </p>
      )}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years ·
            avg {s.avg_r} R a trade · {s.long_share}% long · {s.stopped_pct}% stopped · held {s.avg_held_days} calendar days · ~
            {s.avg_open} open on an average day
          </p>
          <Panel title="Net by month" right="results count on the exit day · click a month for its trades">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>
          <Panel title="Equity" right="cumulative realised, fixed capital, not compounded · accent = net, grey = gross">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
      {month && (
        <MonthTradesModal
          month={month}
          url={`/api/v2/backtest/kbdt/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="entry at the key-break level, out at 15:15 on the exit day or at the stop"
          onClose={closeMonth}
          minWidth={1100}
        />
      )}
    </div>
  );
}
