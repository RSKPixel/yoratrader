import { InstrumentSlot } from "./V2SideNav";
import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Cross-sectional momentum (Chan, Algorithmic Trading ch. 6) on v2: rank by 12-month return, long the
// strongest, short the weakest, hold 25 trading days. Pairs k: the k + k book re-ranked every 25 days;
// As per model: Chan's book (25 overlapping slices of the top and bottom 10%).

const FILLS = [
  ["close", "Signal close (book)"],
  ["next", "Next close"],
];

export default function V2Xsmom({ params }) {
  const [fill, setFill] = useSetting("bt.xsmom.fill", "close");
  const [slippage, setSlippage] = useSetting("bt.xsmom.slippage", 0.02);
  const [pairs, setPairs] = useSetting("bt.xsmom.pairs", 3);
  const [month, setMonth] = useState(null);

  const book = !params.maxOpen;
  const maxPairs = Math.min(5, Math.floor(params.maxOpen / 2));
  const k = book ? null : Math.max(1, Math.min(pairs, maxPairs || 1));
  const pairOptions = [1, 2, 3, 4, 5].map((n) => [
    n,
    `${n}+${n}`,
    book || 2 * n > params.maxOpen,
    book ? "As per model: Chan's book (top and bottom 10%, 25 overlapping slices)" : 2 * n > params.maxOpen ? `Needs Max open ${2 * n} or more` : undefined,
  ]);
  const query = `dataset=${params.universe}&fill=${fill}&slippage=${slippage}&max_open=${params.maxOpen}&pairs=${k || 1}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/xsmom?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const tradeColumns = [
    ...AT_COLUMNS,
    { h: "Days", cell: (t) => t.days, style: () => ({ color: "var(--muted)" }), title: (t) => (t.rolls ? `${t.rolls} futures roll${t.rolls > 1 ? "s" : ""}` : undefined) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "12-m return", cell: (t) => `${t.signal_pct > 0 ? "+" : ""}${t.signal_pct}%`, style: () => ({ color: "var(--muted)" }), title: () => "When it was ranked in" },
    { h: "Entry px", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Exit px", cell: (t) => t.exit },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];
  const dayColumns = [
    { h: "Day", cell: (t) => t.day },
    { h: "Stocks held", cell: (t) => t.stocks, style: () => ({ color: "var(--muted)" }) },
    { h: "Long", cell: (t) => value(t.long_pct, 3), style: (t) => ({ color: tone(t.long_pct) }) },
    { h: "Short", cell: (t) => value(t.short_pct, 3), style: (t) => ({ color: tone(t.short_pct) }) },
    { h: "Gross", cell: (t) => value(t.ret_pct, 3), style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <InstrumentSlot />
        <Field label="Pairs" hint="k strongest long + k weakest short, re-ranked every 25 trading days; each position capital ÷ Max open. Only those that fit in Max open are enabled.">
          <Segmented label="Pairs" options={pairOptions} value={k} onChange={setPairs} />
        </Field>
        <Field label="Fill" hint="The book trades at the close the ranking comes from; next close is the fill check">
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
          <Panel title="Net by month" right={book ? "click a month for its days" : "marked daily · trades by exit day · click a month for its trades"}>
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
          url={`/api/v2/backtest/xsmom/month?month=${month}&${query}`}
          columns={book ? dayColumns : tradeColumns}
          value={value}
          note={book ? "the book's days: 25 overlapping slices" : "positions held from one 25-day ranking to the one it drops out at"}
          onClose={closeMonth}
          minWidth={book ? 700 : 1150}
        />
      )}
    </div>
  );
}
