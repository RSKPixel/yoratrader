import { useCallback, useMemo } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { Card, makeValue, MonthGrid, Panel, tone } from "./V2BacktestView";
import { useBacktest } from "./V2BuyOnGap";

// Books + gold (v2mix.py): RSI(2) and low volatility on (100 - gold)% of capital, half each, and gold%
// in GOLDBEES, held and rebalanced to gold% at each month-end.

const GOLD = [
  ["0", "None"],
  ["20", "20%"],
  ["30", "30%"],
  ["40", "40%"],
];

export default function V2Mix({ params }) {
  const [gold, setGold] = useSetting("bt.mix.gold", "30");
  const { data, error, loading } = useBacktest(`/api/v2/backtest/mix?gold=${gold}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const noop = useCallback(() => {}, []);
  const s = data?.summary;
  const p = s?.parts;
  const g = Number(gold);
  const book = (100 - g) / 2;

  const compare = s && [
    [`Books ${100 - g}% + gold ${g}%`, s, true],
    ["Books only", p.books],
    ["Gold only", p.gold],
    ["RSI(2) only", p.rsi2],
    ["Low volatility only", p.lv],
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Gold" hint="Share of capital held in GOLDBEES, rebalanced at each month-end; the rest is split equally between the two books">
          <Segmented label="Gold" options={GOLD} value={gold} onChange={setGold} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Card label="Net" value={value(s.net_pct)} color={tone(s.net_pct)} hint={`${s.from} → ${s.to}`} />
            <Card label="A year" value={value(s.net_year_pct)} color={tone(s.net_year_pct)} hint="Average net a year, not compounded" />
            <Card label="Sharpe" value={s.sharpe ?? "—"} hint="From monthly results" />
            <Card label="Max drawdown" value={value(s.max_dd_pct)} color="var(--negative)" hint="Largest fall in cumulative net, at a fixed capital" />
            <Card label="Green years" value={`${s.green_years}/${s.years}`} hint={`Worst: ${s.worst_year} ${value(s.worst_year_pct)}`} />
            <Card label="Gold costs" value={value(-s.gold_cost_pct, 3)} color="var(--negative)" hint="Buying the gold and the monthly rebalancing (delivery charges)" />
          </div>
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Capital split: RSI(2) {book}% · low volatility {book}% · gold {g}% · books and gold moved together {s.corr_books_gold} (monthly correlation) · the books are
            their own backtests on today's F&O stocks (survivorship-biased: with each month's actual F&O list, books only made 14.5% a year with a worst drop of −26%, and with 30%
            gold 14.1% and −12%)
          </p>
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
                      <td className="px-2 py-1.5 tabular-nums" style={{ color: tone(x.net_year_pct) }}>{value(x.net_year_pct)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{x.sharpe ?? "—"}</td>
                      <td className="px-2 py-1.5 tabular-nums" style={{ color: "var(--negative)" }}>{value(x.max_dd_pct)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{x.green_years}/{x.years}</td>
                      <td className="px-2 py-1.5 tabular-nums" style={{ color: "var(--muted)" }}>
                        {x.worst_year} {value(x.worst_year_pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="By year" right="Books, RSI(2), low volatility and gold each on full capital">
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
          <Panel title="Net by month" right="the mix">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={noop} />
          </Panel>
          <Panel title="Equity" right="cumulative, fixed capital, not compounded · accent = the mix, grey = books only">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
    </div>
  );
}
