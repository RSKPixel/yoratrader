import { InstrumentSlot } from "./V2SideNav";
import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Turn of the month (v2tom.py): long the index future around each month end, from the close a few days
// before it to the close of the 3rd trading day of the next month; out of the market the rest of the time.

const INDICES = [
  ["nifty", "Nifty 50"],
  ["banknifty", "Nifty Bank"],
];
const WINDOWS = [
  ["4", "Last 4 days → 3rd"],
  ["1", "Last day → 3rd"],
];

export default function V2Tom({ params }) {
  const [index, setIndex] = useSetting("bt.tom.index", "nifty");
  const [win, setWin] = useSetting("bt.tom.window", "4");
  const [slippage, setSlippage] = useSetting("bt.tom.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const query = `index=${index}&window=${win}&slippage=${slippage}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/tom?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: () => ({ color: "var(--muted)" }) },
    { h: "Index", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Days", cell: (t) => t.days_held, style: () => ({ color: "var(--muted)" }) },
    { h: "Entry", cell: (t) => t.entry },
    { h: "Exit", cell: (t) => t.exit },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }), title: () => "Buy, sale and one futures roll" },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <InstrumentSlot />
        <Field label="Index" hint="Traded as the near-month future; tested on the index closes">
          <Segmented label="Index" options={INDICES} value={index} onChange={setIndex} />
        </Field>
        <Field label="Window" hint="Bought at the close before the month's last 4 days (or its last day), sold at the close of the next month's 3rd trading day">
          <Segmented label="Window" options={WINDOWS} value={win} onChange={setWin} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years · in the market{" "}
            {s.in_market_pct}% of days, {s.avg_days} days a trade · holding the index all the time: {value(s.buy_hold_year_pct)} a year · one position, 1x
            the capital · costs include a futures roll each trade
          </p>
          <Panel title="Net by month" right="click a month for its trade">
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
          url={`/api/v2/backtest/tom/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="bought before the month end, sold at the close of the 3rd trading day"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
