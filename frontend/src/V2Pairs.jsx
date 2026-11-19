import { InstrumentSlot } from "./V2SideNav";
import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE_DEFAULT, SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Pairs trading (Chan, Algorithmic Trading ch. 2-4) on v2: same-industry F&O pairs that passed a
// cointegration test on the year before, traded this year. Pairs k = at most k pairs open at once
// (each pair is two legs, so 2k <= Max open); As per model = every selected pair (the book).

const METHODS = [
  ["bollinger", "Bollinger (book)"],
  ["kalman", "Kalman filter"],
];
const FILLS = [
  ["close", "Signal close (book)"],
  ["next", "Next close"],
];

export default function V2Pairs({ params }) {
  const [method, setMethod] = useSetting("bt.pairs.method", "bollinger");
  const [fill, setFill] = useSetting("bt.pairs.fill", "close");
  const [slippage, setSlippage] = useSetting("bt.pairs.slippage", SLIPPAGE_DEFAULT.pairs);
  const [pairs, setPairs] = useSetting("bt.pairs.pairs", 3);
  const [month, setMonth] = useState(null);

  const maxPairs = Math.min(5, Math.floor(params.maxOpen / 2));
  const k = params.maxOpen ? Math.max(1, Math.min(pairs, maxPairs || 1)) : null;
  const pairOptions = [1, 2, 3, 4, 5].map((n) => [
    n,
    `${n}+${n}`,
    !params.maxOpen || 2 * n > params.maxOpen,
    !params.maxOpen ? "As per model: every selected pair (the book)" : 2 * n > params.maxOpen ? `Needs Max open ${2 * n} or more` : `${n} pair${n > 1 ? "s" : ""} open at once`,
  ]);
  const query = `method=${method}&fill=${fill}&slippage=${slippage}&max_open=${params.maxOpen}&pairs=${k || 1}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/pairs?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  // Shares of each leg: 1 of y against h of x (Bollinger's fixed hedge), so qty_y = value / (y + h x).
  const legs = (t) => {
    if (method !== "bollinger" || !t.y_entry || !t.x_entry || t.hedge == null) return null;
    const v = (t.weight_pct / 100) * capital;
    const qy = v / (t.y_entry + t.hedge * t.x_entry);
    return [Math.round(qy), Math.round(qy * t.hedge)];
  };
  const longY = (t) => t.side === "long";
  const columns = [
    ...AT_COLUMNS,
    { h: "Days", cell: (t) => t.days, style: () => ({ color: "var(--muted)" }) },
    { h: "Pair (y / x)", cell: (t) => <span className="font-medium">{t.y} / {t.x}</span>, title: (t) => `${t.industry} · rank ${t.rank} in its year · hedge ${t.hedge}` },
    { h: "Side", cell: (t) => (longY(t) ? `long ${t.y}, short ${t.x}` : `short ${t.y}, long ${t.x}`), style: (t) => ({ color: longY(t) ? "var(--positive)" : "var(--negative)" }) },
    { h: "y in → out", cell: (t) => (t.y_entry ? `${t.y_entry} → ${t.y_exit ?? "—"}` : "—") },
    { h: "x in → out", cell: (t) => (t.x_entry ? `${t.x_entry} → ${t.x_exit ?? "—"}` : "—") },
    {
      h: "Qty y / x",
      cell: (t) => {
        const q = legs(t);
        return q ? `${q[0].toLocaleString("en-IN")} / ${q[1].toLocaleString("en-IN")}` : "—";
      },
      title: (t) => (method === "bollinger" ? `${t.weight_pct}% of ${formatRs(capital)} across both legs: 1 share of ${t.y} per ${t.hedge} of ${t.x}` : "The Kalman filter re-hedges daily: no single quantity"),
    },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }), title: () => "On the pair's gross value (both legs)" },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }), title: () => "Both legs" },
    { h: "Charges", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <InstrumentSlot />
        <Field label="Pairs" hint="At most this many pairs open at once; each pair is two legs (long one stock, short the other), so it needs 2 Max open slots.">
          <Segmented label="Pairs" options={pairOptions} value={k} onChange={setPairs} />
        </Field>
        <Field label="Method" hint="Bollinger: fixed hedge, z-score over the half-life (the book). Kalman filter: hedge re-estimated daily.">
          <Segmented label="Method" options={METHODS} value={method} onChange={setMethod} />
        </Field>
        <Field label="Fill" hint="The book trades at the close the signal comes from; next close is the fill check">
          <Segmented label="Fill" options={FILLS} value={fill} onChange={setFill} />
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
          url={`/api/v2/backtest/pairs/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note={fill === "next" ? "traded one close after the signal" : "traded at the signal close"}
          onClose={closeMonth}
          minWidth={1200}
        />
      )}
    </div>
  );
}
