import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Long Trend Low Volatility (Bensdorp; v2ltlv.py): while the Nifty is above its 200-day average, buy the
// calmest F&O stocks above their own 200-day average; each held until a 20% trailing stop.

const TRAILS = [
  ["20", "20% (book)"],
  ["15", "15%"],
  ["25", "25%"],
];

export default function V2Ltlv({ params }) {
  const [trail, setTrail] = useSetting("bt.ltlv.trail", "20");
  const [slippage, setSlippage] = useSetting("bt.ltlv.slippage", 0.02);
  const [month, setMonth] = useState(null);

  const pit = params.universe === "fnopit" || params.universe === "cash500";
  const top500 = params.universe === "cash500";
  const instrument = "cash"; // cash (delivery) only: positions last months, so futures would mean a roll every month
  const query = `max_open=${params.maxOpen}&trail=${trail}&slippage=${slippage}&instrument=${instrument}&dataset=${params.universe}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/ltlv?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.open ? "var(--accent)" : t.reason === "trailing stop" ? "var(--muted)" : "var(--warning)" }) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Days", cell: (t) => t.days_held, style: () => ({ color: "var(--muted)" }), title: (t) => (instrument === "cash" ? undefined : `${t.rolls} futures rolls`) },
    { h: "Entry", cell: (t) => t.entry },
    { h: "Exit", cell: (t) => (t.open ? `${t.exit} (last)` : t.exit) },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => (t.open ? "—" : value(-t.book_cost_pct, 3)), style: () => ({ color: "var(--negative)" }), title: () => (instrument === "cash" ? "Buy and sale (delivery charges)" : "Buy, sale and the monthly futures rolls") },
    { h: "Net result", cell: (t) => (t.open ? <span style={{ color: "var(--muted)" }}>open</span> : <span className="font-medium">{value(t.book_net_pct, 3)}</span>), style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Instrument" hint="Cash only: delivery (STT 0.1% each side, stamp duty, DP charge), no rolls. Positions are held for months, so futures would need a roll every month">
          <span className="block py-1.5 text-sm">Cash (delivery)</span>
        </Field>
        <Field label="Trailing stop" hint="Sold at the close that ends this far under the highest close since the buy">
          <Segmented label="Trailing stop" options={TRAILS} value={trail} onChange={setTrail} />
        </Field>
        <Field label="Slippage" hint={`Per side, on top of the ${instrument === "cash" ? "delivery" : "futures"} charges`}>
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years · max {s.max_open} open, {s.avg_open} on
            average · {s.avg_days} trading days a trade · {s.open_now} held now · {instrument === "cash" ? "cash, no rolls" : "futures, rolled monthly"} · costs {s.cost_per_side_bps} bps a side ·
            {pit
              ? top500
                ? "Top 500: the 500 stocks with the most traded value at each month-end (survivorship-free) · cash · 0.08% a side more slippage · no buys on circuit-locked days"
                : "survivorship bias off (each month's actual F&O list)"
              : "today's F&O stocks (survivorship bias on: set it Off for the honest numbers)"}
          </p>
          <Panel title={`Held now · ${s.open_positions.length} of ${s.max_open}`} right="still open: their gains and losses count in Net by month as they happen, but not in Trades until sold">
            {s.open_positions.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: 640 }}>
                  <thead>
                    <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
                      {["Stock", "Bought", "Entry", "Last", "Days", "Return", "Best so far", "Trailing stop"].map((h) => (
                        <th key={h} className="px-2 py-1.5 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.open_positions.map((o) => (
                      <tr key={o.symbol} className="border-t" style={{ borderColor: "var(--border)" }}>
                        <td className="px-2 py-1.5 font-medium">{o.symbol}</td>
                        <td className="px-2 py-1.5 tabular-nums">{o.entry_at.slice(0, 10)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{o.entry}</td>
                        <td className="px-2 py-1.5 tabular-nums">{o.last}</td>
                        <td className="px-2 py-1.5 tabular-nums">{o.days_held}</td>
                        <td className="px-2 py-1.5 tabular-nums font-medium" style={{ color: tone(o.ret_pct) }}>
                          {o.ret_pct > 0 ? "+" : ""}
                          {o.ret_pct}%
                        </td>
                        <td className="px-2 py-1.5 tabular-nums" style={{ color: "var(--muted)" }}>
                          +{o.peak_pct}%
                        </td>
                        <td className="px-2 py-1.5 tabular-nums" style={{ color: "var(--muted)" }}>
                          {o.to_stop_pct}% away
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing held now.</p>
            )}
          </Panel>
          <Panel title="Net by month" right="click a month for the trades closed in it">
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
          url={`/api/v2/backtest/ltlv/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="bought at the close, sold at the close that hits the trailing stop · still held = bought this month, not sold yet (not in the month's total)"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
