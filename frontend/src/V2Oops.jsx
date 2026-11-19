import { InstrumentSlot } from "./V2SideNav";
import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE_DEFAULT, SLIPPAGE, useBacktest } from "./V2BuyOnGap";
import DisasterStop from "./V2Disaster";

// Larry Williams' "Oops" gap reversal on v2 (v2oops.py): a stock opens below yesterday's low and is
// bought when it trades back up to that low; out at 15:15 or the next day's open, or at the 10% disaster stop.
// Futures prices (as the paper book): the future's own open and previous low; inside the day the share's
// 1-minute candles shifted to the future's level. Today's F&O stocks, 2015 on. Max open = the day's first N fills.


export default function V2Oops({ params }) {
  const [disaster, setDisaster] = useSetting("bt.oops.disaster", "on"); // the 10% disaster stop (no other stop, no trend filter)
  const exit = "nextopen"; // fixed: the book's "out on the opening tomorrow" (the 15:15 exit is no longer offered)
  const [slippage, setSlippage] = useSetting("bt.oops.slippage", SLIPPAGE_DEFAULT.oops);
  const [month, setMonth] = useState(null);

  const query = `stop=none&trend=any&slippage=${slippage}&max_open=${params.maxOpen}&exit=${exit}&disaster=${disaster}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/oops?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason === "disaster stop" ? "var(--negative)" : "var(--muted)" }) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Gap", cell: (t) => `${t.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: (t) => `Opened ${t.open}, yesterday's low ${t.prev_low}` },
    { h: "Entry", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Exit", cell: (t) => t.exit },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Charges", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <InstrumentSlot />
        <Field label="Exit at" hint="Fixed, as in the book (Williams: 'we buy today and are out on the opening tomorrow'): sold at the next trading day's open; a future that expires that day is sold at 15:15">
          <Segmented label="Exit at" options={[["nextopen", "Next open"]]} value="nextopen" onChange={() => {}} />
        </Field>
        <DisasterStop value={disaster} onChange={setDisaster} hits={disaster === "on" ? data?.summary?.disaster_hits : null} />
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && (
          <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
            Loading… (the first load builds the fills from the 1-minute candles, a minute or two)
          </span>
        )}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!error && data && !s && <p className="text-sm" style={{ color: "var(--muted)" }}>No trades for these settings.</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
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
          url={`/api/v2/backtest/oops/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note={`bought when the price trades back up to yesterday's low, out ${exit === "nextopen" ? "at the next day's open" : "at 15:15"} (or the 10% disaster stop, on the buy day)`}
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
