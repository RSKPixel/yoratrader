import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Quantitative momentum (Gray & Vogel) on v2: long only, the smoothest of the top 10% by 12-to-1-month
// momentum, rebalanced at the end of Feb / May / Aug / Nov. Each row = one stock in one period.

const VERSIONS = [
  ["book", "Momentum + FIP (book)"],
  ["generic", "Momentum only"],
  ["monthly", "Monthly"],
  ["universe", "All stocks (benchmark)"],
];
const HEDGES = [
  ["none", "None (book)"],
  ["nifty", "Short Nifty"],
];

export default function V2Qmom({ params }) {
  const [version, setVersion] = useSetting("bt.qmom.version", "book");
  const [hedge, setHedge] = useSetting("bt.qmom.hedge", "none");
  const [slippage, setSlippage] = useSetting("bt.qmom.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const query = `dataset=${params.universe}&version=${version}&hedge=${hedge}&slippage=${slippage}&max_open=${params.maxOpen}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/qmom?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    ...AT_COLUMNS,
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    {
      h: "Next period",
      cell: (t) => (t.hedge ? "—" : t.kept ? "kept" : "sold"),
      style: (t) => ({ color: t.hedge ? "var(--faint)" : t.kept ? "var(--muted)" : "var(--negative)" }),
    },
    { h: "Momentum", cell: (t) => (t.mom_pct == null ? "—" : `+${t.mom_pct}%`), style: () => ({ color: "var(--muted)" }), title: () => "12-to-1-month return at the rebalance" },
    { h: "FIP", cell: (t) => t.fip ?? "—", style: () => ({ color: "var(--muted)" }), title: () => "Frog in the pan: lower = smoother climb" },
    { h: "Entry", cell: (t) => t.entry ?? "—" },
    {
      h: "Qty",
      cell: (t) => (t.entry ? Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN") : "—"),
      title: (t) => (t.entry ? `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}` : "Short Nifty futures worth the stocks' value"),
    },
    { h: "Exit", cell: (t) => t.exit ?? "—" },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }), title: () => "After the rebalance trades and the monthly futures rolls" },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Version" hint="Book: top 10% by 12-to-1-month return, the smoother half by FIP, quarterly. Momentum only: no FIP filter. Monthly: rebalanced every month. All stocks: the equal-weight benchmark (no max open).">
          <Segmented label="Version" options={VERSIONS} value={version} onChange={setVersion} />
        </Field>
        <Field label="Hedge" hint="Not in the book. Short Nifty: a Nifty futures short equal to the stocks' value, so the result is what they earn over the Nifty.">
          <Segmented label="Hedge" options={HEDGES} value={hedge} onChange={setHedge} />
        </Field>
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
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/
            {s.years} green years · ~{s.avg_held} stocks held · {s.kept_pct}% kept into the next period
            {s.hedge_net_pct != null ? ` · hedge ${value(s.hedge_net_pct)}` : ""}
          </p>
          <Panel title="Net by month" right="marked daily · trades and win rate by the rebalance that ends each holding · click a month for them">
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
          url={`/api/v2/backtest/qmom/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="each stock from one rebalance to the next"
          onClose={closeMonth}
          minWidth={1150}
        />
      )}
    </div>
  );
}
