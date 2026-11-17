import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { MonthGrid, MonthTradesModal, Panel, SummaryCards, makeValue, tone, AT_COLUMNS } from "./V2BacktestView";
import { useBacktest } from "./V2BuyOnGap";

// Books + gold (v2mix.py): RSI(2) and low volatility on (100 - gold)% of capital, half each (fixed: no
// other split is offered, so it can't be tuned to the past), and
// gold% in GOLDBEES, held and rebalanced to gold% at each month-end. Books in cash or futures.

const GOLD = [
  ["0", "None"],
  ["20", "20%"],
  ["30", "30%"],
  ["40", "40%"],
];
const INSTRUMENTS = [
  ["cash", "Cash"],
  ["futures", "F&O"],
];
// survivorship-free (each month's actual F&O list), 2008-2026, books 50 / 50
const HONEST = {
  cash: "books only made 11.0% a year with a worst drop of −31%; with 30% gold 11.7% and −13%",
  futures: "books only made 14.5% a year with a worst drop of −26%; with 30% gold 14.1% and −12%",
};

export default function V2Mix({ params }) {
  const [gold, setGold] = useSetting("bt.mix.gold", "30");
  const [instrument, setInstrument] = useSetting("bt.mix.instrument", "cash");
  const [month, setMonth] = useState(null);
  const query = `gold=${gold}&instrument=${instrument}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/mix?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const p = s?.parts;

  const compare = s && [
    [`The mix (RSI(2) ${s.split.rsi2}% · low volatility ${s.split.lv}% · gold ${s.split.gold}%)`, p.mix, true],
    ["Books only", p.books],
    ["Gold only", p.gold],
    ["RSI(2) only", p.rsi2],
    ["Low volatility only", p.lv],
  ];

  const columns = [
    ...AT_COLUMNS,
    { h: "Book", cell: (t) => t.book, style: (t) => ({ color: t.book === "Gold" ? "var(--warning)" : "var(--muted)" }) },
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.open ? "var(--accent)" : "var(--muted)" }) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Days", cell: (t) => t.days ?? "—", style: () => ({ color: "var(--muted)" }) },
    { h: "Entry", cell: (t) => t.entry ?? "—" },
    { h: "Exit", cell: (t) => (t.exit == null ? "—" : t.open ? `${t.exit} (last)` : t.exit) },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => (t.open ? "—" : value(-t.book_cost_pct, 3)), style: () => ({ color: "var(--negative)" }) },
    {
      h: "Net result",
      cell: (t) => (t.open ? <span style={{ color: "var(--muted)" }}>open</span> : <span className="font-medium">{value(t.book_net_pct, 3)}</span>),
      style: (t) => ({ color: tone(t.book_net_pct) }),
    },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Gold allocation" hint="Share of capital held in GOLDBEES, rebalanced at each month-end; the rest goes to the books">
          <Segmented label="Gold allocation" options={GOLD} value={gold} onChange={setGold} />
        </Field>
        <Field label="Price" hint="Cash: delivery, no rolls (STT 0.1% each side, stamp duty, DP charge). F&O: futures charges and a roll at each month end">
          <Segmented label="Price" options={INSTRUMENTS} value={instrument} onChange={setInstrument} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years · RSI(2) {s.split.rsi2}% · low
            volatility {s.split.lv}% · gold {s.split.gold}% · {instrument === "cash" ? "cash, no rolls" : "futures, rolled monthly"} · gold costs {value(-s.gold_cost_pct, 3)} ·
            books and gold moved together {s.corr_books_gold} (monthly) · trades are the books' (gold is held) · today's F&O stocks (survivorship-biased: with each month's actual
            F&O list, {HONEST[instrument]})
          </p>
          <Panel title="Net by month" right="click a month for its trades and the gold">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>
          <Panel title="Equity" right="cumulative, fixed capital, not compounded · accent = the mix, grey = books only">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
          <Panel title="Compared" right="the same months">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: 560 }}>
                <thead>
                  <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
                    {["", "A year", "Sharpe", "Max drawdown", "Green years", "Worst year"].map((h) => (
                      <th key={h} className="px-2 py-1.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {compare.map(([label, x, main]) => (
                    <tr key={label} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className={`px-2 py-1.5 ${main ? "font-semibold" : ""}`}>{label}</td>
                      <td className="px-2 py-1.5 tabular-nums" style={{ color: tone(x.net_year_pct) }}>
                        {value(x.net_year_pct)}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">{x.sharpe ?? "—"}</td>
                      <td className="px-2 py-1.5 tabular-nums" style={{ color: "var(--negative)" }}>
                        {value(x.max_dd_pct)}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {x.green_years}/{x.years}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums" style={{ color: "var(--muted)" }}>
                        {x.worst_year} {value(x.worst_year_pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="By year" right="the mix; then books, RSI(2), low volatility and gold each on full capital">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: 560 }}>
                <thead>
                  <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
                    {["Year", "Mix", "Books", "RSI(2)", "Low volatility", "Gold"].map((h) => (
                      <th key={h} className="px-2 py-1.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...data.years].reverse().map((y) => (
                    <tr key={y.year} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="px-2 py-1.5 font-medium">{y.year}</td>
                      {[y.net_pct, y.books_pct, y.rsi2_pct, y.lv_pct, y.gold_pct].map((v, i) => (
                        <td key={i} className={`px-2 py-1.5 tabular-nums ${i === 0 ? "font-semibold" : ""}`} style={{ color: tone(v) }}>
                          {value(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
      {month && (
        <MonthTradesModal
          month={month}
          url={`/api/v2/backtest/mix/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="each trade sized to its book's share of capital · bought and sold at the close · the gold row is the month's move on the gold slice · still held = bought this month, not sold yet"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
