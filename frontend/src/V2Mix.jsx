import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { MonthGrid, MonthTradesModal, Panel, SummaryCards, makeValue, tone, AT_COLUMNS } from "./V2BacktestView";
import { useBacktest } from "./V2BuyOnGap";

// Books + gold (v2mix.py): RSI(2) and low volatility on (100 - gold)% of capital, half each (fixed: no
// other split is offered, so it can't be tuned to the past), and
// 30% (or none) in GOLDBEES, held and rebalanced at each month-end. All in cash.

// gold: none or 30% (nothing in between, so nothing to fit); the books half each of the rest
const GOLD = [
  ["0", "None"],
  ["30", "30%"],
];
const allocation = (gold) => [
  ["RSI(2)", (100 - gold) / 2, "Short-term mean reversion: up to 3 stocks, held 5 days"],
  ["Low volatility", (100 - gold) / 2, "Long trend low volatility: up to 10 stocks, 20% trailing stop"],
  ["Gold", gold, gold ? `GOLDBEES, held; topped up or trimmed back to ${gold}% at each month-end` : "No gold"],
];

const rupees = (v) => `₹${Math.round(v).toLocaleString("en-IN")}`;

export default function V2Mix({ params }) {
  const [gold, setGold] = useSetting("bt.mix.gold", "30");
  const [month, setMonth] = useState(null);
  const pit = params.universe === "fnopit";
  const query = `gold=${gold === "0" ? 0 : 30}&instrument=cash&dataset=${pit ? "fnopit" : "fno"}`;
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
        <Field label="Gold" hint="Share of capital held in GOLDBEES, rebalanced at each month-end; the books share the rest equally">
          <Segmented label="Gold" options={GOLD} value={gold === "0" ? "0" : "30"} onChange={setGold} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {allocation(gold === "0" ? 0 : 30).map(([label, pct, hint]) => (
          <div key={label} className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }} title={hint}>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {label}
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {pct}% <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>· {rupees((params.capital * pct) / 100)}</span>
            </p>
          </div>
        ))}
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }} title="Delivery: STT 0.1% each side, stamp duty, DP charge; no futures, no rolls">
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Traded in
          </p>
          <p className="text-lg font-semibold">
            Cash {loading && <span className="text-xs font-normal" style={{ color: "var(--faint)" }}>· loading…</span>}
          </p>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years · RSI(2) {s.split.rsi2}% · low
            volatility {s.split.lv}% · gold {s.split.gold}% · cash, no rolls · gold costs {value(-s.gold_cost_pct, 3)} ·
            books and gold moved together {s.corr_books_gold} (monthly) · trades are the books' (gold is held) ·{" "}
            {pit
              ? "survivorship bias off (each month's actual F&O list)"
              : "today's F&O stocks (survivorship bias on: set it Off for the honest numbers)"}
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
