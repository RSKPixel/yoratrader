import { useMemo } from "react";
import { useSetting } from "./settings";
import { Field, formatRs, Segmented } from "./V2Controls";
import { tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest, useLiveRefresh } from "./V2BuyOnGap";
import V2PnlChart from "./V2PnlChart";
import { DayLog, LotCards, lotColumns, lotMoney, netBoth, usePaperChart, Panel, PositionsTable, StatusLine } from "./V2PaperView";

// Oops gap reversal paper trading on v2 (oopswatch.py), on the current-month futures (every price is
// the future's): the production scheduler watches every F&O future that opened below yesterday's low and buys it when it trades back up to that low (the day's
// first N, N = max open); out at 15:15, with an optional stop below the day's low (off by default: the 1-minute
// backtest shows it's too tight). One lot each. Nothing places orders.

const STOPS = [
  ["none", "None (out at 15:15)"],
  ["low", "Below the day's low"],
];

export default function V2PaperOops({ params, stop, onStop, saving }) {
  const [slippage, setSlippage] = useSetting("paper.oops.slippage", 0.02);
  const live = useLiveRefresh();
  const { data, error, loading } = useBacktest(`/api/v2/paper/oops?slippage=${slippage}`, { refreshMs: live });
  const money = useMemo(() => lotMoney(params.show), [params.show]);
  const lot = lotColumns(money);
  const chart = usePaperChart();

  const columns = [
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span>, title: (t) => t.fut || "" },
    { h: "Gap", cell: (t) => `${t.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: (t) => `Opened ${t.open}, yesterday's low ${t.prev_low}` },
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason === "stop" ? "var(--negative)" : "var(--muted)" }) },
    { h: "Entry", cell: (t) => t.entry, title: () => "Yesterday's low (a buy-stop order there)" },
    lot.qty,
    { h: "Stop", cell: (t) => t.stop ?? "—", style: () => ({ color: "var(--muted)" }), title: (t) => (t.stop == null ? "Bought with no stop" : "0.1% below the day's low at the buy") },
    { h: "Exit / last", cell: (t) => t.exit ?? "—" },
    { h: "Return", cell: (t) => (t.ret_pct == null ? "—" : `${t.ret_pct.toFixed(2)}%`), style: (t) => ({ color: tone(t.ret_pct) }) },
    lot.value,
    lot.margin,
    lot.result,
  ];
  const today = data?.days.find((d) => d.day === data.today);
  const watchCols = [
    { h: "Stock", cell: (w) => <span className="font-medium">{w.symbol}</span> },
    { h: "Opened", cell: (w) => w.open },
    { h: "Gap", cell: (w) => `${w.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--negative)" }) },
    { h: "Buy at (yesterday's low)", cell: (w) => w.prev_low, style: () => ({ color: "var(--positive)" }) },
    { h: "Last", cell: (w) => w.ltp ?? "—" },
    {
      h: "To trigger",
      cell: (w) => (w.bought ? "bought" : w.to_trigger_pct == null ? "—" : `+${w.to_trigger_pct.toFixed(2)}%`),
      style: (w) => ({ color: w.bought ? "var(--positive)" : w.to_trigger_pct != null && w.to_trigger_pct < 0.5 ? "var(--warning)" : "var(--muted)" }),
      title: () => "How far the price must still rise to reach yesterday's low",
    },
  ];
  const logCols = [
    { h: "Day", cell: (d) => d.day },
    { h: "At", cell: (d) => d.recorded_at, style: () => ({ color: "var(--muted)" }) },
    { h: "Quoted", cell: (d) => d.quoted ?? "—" },
    { h: "Opened below yesterday's low", cell: (d) => d.gapped ?? "—" },
    { h: "Note", cell: (d) => d.note ?? "", style: () => ({ color: "var(--muted)" }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      {chart.dialog}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        {stop && (
          <Field label="Stop" hint="For the next buys (shared, saved on the server). Below the day's low: 0.1% under the day's low at the buy; the 1-minute backtest shows it's too tight (about 4% a year against 24% without).">
            <Segmented label="Stop" options={STOPS} value={stop} onChange={(v) => !saving && onStop(v)} />
          </Field>
        )}
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {data && (
        <>
          <StatusLine>
            Futures prices · watched tick by tick from 09:15{data.stream?.connected ? " (stream connected)" : ""}, with a minute check as backup: a future that opened below yesterday's low is bought when it trades back up to it (the day's first{" "}
            {data.max_open}), {data.stop_mode === "low" ? "stop 0.1% below the day's low at the buy, " : "no stop, "}out at 15:15{data.ltp_at ? ` · live prices at ${data.ltp_at}` : ""} · costs{" "}
            {data.cost_per_side_bps} bps a side · nothing places orders
          </StatusLine>
          <LotCards s={{ ...data.summary, win_rate: data.summary.win_rate_lots, win_days: data.summary.win_days_lots }} money={money} />
          <Panel
            title={`Today · ${data.today}`}
            right={today ? `${today.status === "open" ? "open, live" : "closed"} · margin ${formatRs(today.margin_rs)} · net ${netBoth(today.net_rs, today.net_value_pct)}` : undefined}
          >
            {today && (
              <div className="mb-3">
                <V2PnlChart url={`/api/v2/paper/oops/pnl?day=${today.day}&slippage=${slippage}`} refreshMs={today.status === "open" ? live : 0} />
              </div>
            )}
            <PositionsTable rows={today?.picks || []} columns={[chart.column, ...columns]} minWidth={1000} empty="No buys yet today." />
          </Panel>
          <Panel title={`Watching today · ${data.watchlist.length} futures opened below yesterday's low`} right="bought when the price trades back up to the buy level">
            <div className="max-h-96 overflow-auto">
              <PositionsTable rows={data.watchlist} columns={watchCols} minWidth={640} empty={data.market_open ? "None opened below yesterday's low today." : "The watchlist is made at 09:15 on trading days."} />
            </div>
          </Panel>
          <Panel title="Paper log" right="a row a day · click for its positions">
            <DayLog
              days={data.days}
              columns={columns}
              extra={(d) => <V2PnlChart url={`/api/v2/paper/oops/pnl?day=${d.day}&slippage=${slippage}`} compact />}
              dayValue={(d) => netBoth(d.net_rs, d.net_value_pct)}
              dayNote={(d) => `margin ${formatRs(d.margin_rs)}`}
              minWidth={1000}
              empty="Nothing recorded yet: the first paper day is the next trading day from 09:15 (Kite login needed)."
            />
          </Panel>
          <Panel title="Daily record" right="the 09:15 watchlist">
            <PositionsTable rows={data.log} columns={logCols} minWidth={600} empty="Nothing yet." />
          </Panel>
        </>
      )}
    </div>
  );
}
