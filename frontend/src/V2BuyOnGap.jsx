import { useCallback, useEffect, useMemo, useState } from "react";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone } from "./V2BacktestView";

// Buy/Sell on gap (Chan, Algorithmic Trading ch. 4) on v2: the stored backtest trades sized by the
// common parameters (universe, capital, max open, % or ₹).

const SIDES = [
  ["long", "Long (book)"],
  ["both", "Long & short"],
];
const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];
export const SLIPPAGE = [
  [0, "0%"],
  [0.01, "0.01%"],
  [0.02, "0.02%"],
  [0.05, "0.05%"],
];

export function useBacktest(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(url, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success") setError(p.message || p.detail || "Could not load the backtest");
        else {
          setError("");
          setData(p);
        }
      })
      .catch((e) => e.name !== "AbortError" && setError("Could not reach the API"))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [url]);
  return { data, error, loading };
}

export default function V2BuyOnGap({ params }) {
  const [side, setSide] = useState("long");
  const [stop, setStop] = useState("none");
  const [slippage, setSlippage] = useState(0.02);
  const [month, setMonth] = useState(null);

  const query = `dataset=${params.universe}&side=${side}&stop=${stop}&slippage=${slippage}&max_open=${params.maxOpen}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/gap?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    { h: "Day", cell: (t) => t.day },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "Gap", cell: (t) => `${t.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: (t) => `Rank ${t.rank} that day` },
    { h: "Entry", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Stop", cell: (t) => t.stop, style: () => ({ color: "var(--muted)" }) },
    { h: "Exit", cell: (t) => t.exit },
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Side" hint="Long: buy gaps down (the book). Long & short: also short the mirror image.">
          <Segmented label="Side" options={SIDES} value={side} onChange={setSide} />
        </Field>
        <Field label="Stop" hint="None: out at 15:15 (the book). 1σ: a stop one 90-day standard deviation from the entry.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
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
      {!error && data && !s && <p className="text-sm" style={{ color: "var(--muted)" }}>No trades for these settings.</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years ·
            traded on {s.days_traded} of {s.days} days (intraday: capital sits idle on the rest)
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
          url={`/api/v2/backtest/gap/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="in at the 09:15 open, out at 15:15 (or the stop)"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
