import { InstrumentSlot } from "./V2SideNav";
import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";
import DisasterStop from "./V2Disaster";

// Cross-sectional mean reversion (Chan, Algorithmic Trading ch. 4) on v2: long the stocks that lagged
// at the open, short the ones that led. Capital = gross exposure (half long, half short); Max open N =
// N/2 long + N/2 short; As per model = linear weights on every stock.

const VERSIONS = [
  ["intraday", "Intraday (book)"],
  ["daily", "Daily"],
];
const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];

export default function V2Xsmr({ params }) {
  const [version, setVersion] = useSetting("bt.xsmr.version", "intraday");
  const entry = "0915"; // the 09:15 auction price only (later entries lose most of the edge)
  const stop = "none"; // no stop, only the disaster stop
  const [disaster, setDisaster] = useSetting("bt.xsmr.disaster", "on");
  const [slippage, setSlippage] = useSetting("bt.xsmr.slippage", 0.02);
  const [month, setMonth] = useState(null);
  const [pairs, setPairs] = useSetting("bt.xsmr.pairs", 3);

  const stopAllowed = version === "intraday" && entry === "0915";
  // k long + k short, within Max open (2k <= max open); As per model is the book (every stock).
  const maxPairs = Math.min(5, Math.floor(params.maxOpen / 2));
  const k = params.maxOpen ? Math.max(1, Math.min(pairs, maxPairs || 1)) : null;
  const pairOptions = [1, 2, 3, 4, 5].map((n) => [
    n,
    `${n}+${n}`,
    !params.maxOpen || 2 * n > params.maxOpen,
    !params.maxOpen ? "As per model: every stock (the book)" : 2 * n > params.maxOpen ? `Needs Max open ${2 * n} or more` : undefined,
  ]);
  const query = `dataset=${params.universe}&version=${version}&entry=${entry}&stop=${stopAllowed ? stop : "none"}&slippage=${slippage}&max_open=${params.maxOpen}&pairs=${k || 1}&disaster=${disaster}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/xsmr?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    ...AT_COLUMNS,
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "Signal", cell: (t) => `${t.signal_pct > 0 ? "+" : ""}${t.signal_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: () => "The move the model fades (open vs previous close)" },
    { h: "Entry", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Exit", cell: (t) => (t.stopped ? `${t.exit} · stop` : t.exit), style: (t) => ({ color: t.stopped ? "var(--negative)" : undefined }) },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Cost", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <InstrumentSlot />
        <Field
          label="Pairs"
          hint="Long-short: k long + k short, each capital ÷ Max open (unused slots stay in cash). Only the ones that fit in Max open are enabled."
        >
          <Segmented label="Pairs" options={pairOptions} value={k} onChange={setPairs} />
        </Field>
        <Field label="Version" hint="Intraday: signal = previous close → open, held to 15:15 (the book). Daily: signal 15:15 → 15:15, held to the next 15:15.">
          <Segmented label="Version" options={VERSIONS} value={version} onChange={setVersion} />
        </Field>
        {version === "intraday" && (
          <Field label="Entry" hint="Fixed: the 09:15 auction price (the pre-open session), as in the book">
            <span className="block py-1.5 text-sm">09:15 (open)</span>
          </Field>
        )}
        {version === "intraday" && <DisasterStop value={disaster} onChange={setDisaster} hits={disaster === "on" ? data?.summary?.disaster_hits : null} />}
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
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years ·
            ~{s.avg_positions} positions a day · long {value(s.long_net_pct)}, short {value(s.short_net_pct)}
            {s.stopped_pct ? ` · ${s.stopped_pct}% stopped` : ""}
          </p>
          <Panel title="Net by month" right="click a month for its days and positions">
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
          url={`/api/v2/backtest/xsmr/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note={version === "daily" ? "each day's book, 15:15 to the next 15:15" : `in at ${entry.slice(0, 2)}:${entry.slice(2)}, out at 15:15${stop === "1sd" && stopAllowed ? " or the stop" : ""}`}
          onClose={closeMonth}
          groupByDay
        />
      )}
    </div>
  );
}
