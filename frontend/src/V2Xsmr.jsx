import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE_DEFAULT, SLIPPAGE, useBacktest } from "./V2BuyOnGap";
import DisasterStop from "./V2Disaster";

// Cross-sectional mean reversion (Chan, Algorithmic Trading ch. 4) on v2: long the stocks that lagged
// at the open, short the ones that led. Capital = gross exposure (half long, half short); Max open N =
// N/2 long + N/2 short; As per model = linear weights on every stock.

const INSTRUMENTS = [
  ["spot", "Spot"],
  ["futures", "Futures"],
];

const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];

export default function V2Xsmr({ params }) {
  const version = "intraday"; // fixed: the book's intraday version (the daily version is no longer offered)
  const entry = "0915"; // the 09:15 auction price only (later entries lose most of the edge)
  const stop = "none"; // no stop, only the disaster stop
  const [disaster, setDisaster] = useSetting("bt.xsmr.disaster", "off");
  const exit = "1515"; // fixed: the book's same-day exit (the next-day-open test is no longer offered)
  const [slippage, setSlippage] = useSetting("bt.xsmr.slippage", SLIPPAGE_DEFAULT.xsmr);
  const [month, setMonth] = useState(null);
  const [pairs, setPairs] = useSetting("bt.xsmr.pairs", 3);
  const [savedInstrument, setInstrument] = useSetting("bt.xsmr.instrument", "futures");
  const futOk = params.universe === "fno"; // futures prices exist only for today's F&O stocks
  const instrument = futOk ? (savedInstrument === "spot" ? "spot" : "futures") : "spot";
  const pit = params.universe === "fnopit"; // survivorship-free: NSE's daily files, so out at the official close

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
  const query = `dataset=${params.universe}&version=${version}&entry=${entry}&stop=${stopAllowed ? stop : "none"}&slippage=${slippage}&max_open=${params.maxOpen}&pairs=${k || 1}&disaster=${disaster}&exit=${exit}&instrument=${instrument}`;
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
    { h: "Charges", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Instrument" hint="Futures: the signal, fill and exit on the near-month future's prices, futures charges. Spot: the shares themselves, bought and shorted intraday (a short in shares can't be held overnight, so out the same day at 15:15), at the share's 09:15 open and 15:15 price, with intraday equity charges (brokerage 0.03%, STT 0.025% on sells, exchange, stamp, GST). Futures prices exist only for today's F&O stocks, so other universes are Spot only.">
          <Segmented
            label="Instrument"
            options={INSTRUMENTS.map(([v, t]) => [v, t, v === "futures" && !futOk, v === "futures" && !futOk ? "Futures prices exist only for today's F&O stocks" : undefined])}
            value={instrument}
            onChange={setInstrument}
          />
        </Field>
        <Field
          label="Pairs"
          hint="Long-short: k long + k short, each capital ÷ Max open (unused slots stay in cash). Only the ones that fit in Max open are enabled."
        >
          <Segmented label="Pairs" options={pairOptions} value={k} onChange={setPairs} />
        </Field>
        <Field label="Entry" hint="Fixed: the 09:15 opening auction price, as in the book">
          <Segmented label="Entry" options={[["0915", "09:15 open"]]} value="0915" onChange={() => {}} />
        </Field>
        <Field label="Exit at" hint="Fixed, as in the book: sold the same day at 15:15 (the close of the 15:00 candle)">
          <Segmented label="Exit at" options={[["1515", "15:15 same day"]]} value="1515" onChange={() => {}} />
        </Field>
        <DisasterStop value={disaster} onChange={setDisaster} hits={disaster === "on" ? data?.summary?.disaster_hits : null} />
        <Field label="Slippage" hint={`Per side, on top of the ${instrument === "spot" ? "intraday equity" : "NSE futures"} charges`}>
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && (
          <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
            Loading…
          </span>
        )}
      </div>

      {pit && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Survivorship bias off: each month's real F&O list, stocks dropped since included, from 2015 (as with it on: older opening prices aren't reliable). Dropped stocks have only daily prices, so this version enters at the official open (the 09:15 auction price) and exits at the official close instead of 15:15, in the shares (spot).
        </p>
      )}
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
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
          note={version === "daily" ? "each day's book, 15:15 to the next 15:15" : `in at ${entry.slice(0, 2)}:${entry.slice(2)}, out ${exit === "nextopen" ? "at the next day's open" : pit ? "at the official close" : "at 15:15"}${stop === "1sd" && stopAllowed ? " or the stop" : ""}`}
          onClose={closeMonth}
          groupByDay
        />
      )}
    </div>
  );
}
