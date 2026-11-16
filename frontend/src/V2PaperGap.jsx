import { useMemo, useState } from "react";
import { Field, formatRs, Segmented } from "./V2Controls";
import { tone } from "./V2BacktestView";
import { SLIPPAGE, useBacktest, useLiveRefresh } from "./V2BuyOnGap";
import { DayLog, LotCards, lotColumns, lotMoney, netBoth, usePaperChart, Panel, PositionsTable, StatusLine } from "./V2PaperView";

// Buy/Sell on gap paper trading on v2: the picks the production scheduler records at 09:15 (every
// qualifying F&O stock), the max open biggest gaps, one lot each. Nothing here places orders.

const SIDES = [
  ["long", "Long (book)"],
  ["both", "Long & short"],
];
const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];

export default function V2PaperGap({ params }) {
  const [side, setSide] = useState("long");
  const [stop, setStop] = useState("none");
  const [slippage, setSlippage] = useState(0.02);
  const live = useLiveRefresh();
  const { data, error, loading } = useBacktest(`/api/v2/paper/gap?side=${side}&stop=${stop}&slippage=${slippage}&max_open=${params.maxOpen}`, { refreshMs: live });
  const money = useMemo(() => lotMoney(params.show), [params.show]);
  const lot = lotColumns(money);
  const chart = usePaperChart();

  const columns = [
    { h: "#", cell: (t) => t.rank, style: () => ({ color: "var(--faint)" }) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "Gap", cell: (t) => `${t.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: (t) => `1σ = ${t.sigma_pct}%` },
    { h: "Open", cell: (t) => t.entry, title: (t) => (t.entry_live ? `Live fill ${t.entry_live} at ${t.live_at}` : undefined) },
    lot.qty,
    { h: "Stop", cell: (t) => t.stop, style: () => ({ color: "var(--muted)" }) },
    { h: t_exit(), cell: (t) => t.exit ?? "—" },
    { h: "Reason", cell: (t) => t.reason ?? "—", style: (t) => ({ color: t.reason?.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Return", cell: (t) => (t.ret_pct == null ? "—" : `${t.ret_pct.toFixed(2)}%`), style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => (t.net_pct == null ? "—" : `${t.net_pct.toFixed(2)}%`), style: (t) => ({ color: tone(t.net_pct) }) },
    lot.value,
    lot.margin,
    lot.result,
  ];
  function t_exit() {
    return "Exit / last";
  }
  const today = data?.days.find((d) => d.day === data.today);
  const watchCols = [
    { h: "Stock", cell: (z) => <span className="font-medium">{z.symbol}</span> },
    { h: "Buy below", cell: (z) => z.buy_below ?? "—", style: () => ({ color: "var(--positive)" }), title: (z) => (z.buy_gap_pct ? `${z.buy_gap_pct}% below the close` : undefined) },
    ...(side === "both" ? [{ h: "Sell above", cell: (z) => z.sell_above ?? "—", style: () => ({ color: "var(--negative)" }), title: (z) => (z.sell_gap_pct ? `+${z.sell_gap_pct}% above the close` : undefined) }] : []),
    { h: "Prev close", cell: (z) => z.prev_close },
    { h: "Prev low / high", cell: (z) => `${z.prev_low} / ${z.prev_high}`, style: () => ({ color: "var(--muted)" }) },
    { h: "20-day avg", cell: (z) => z.ma20, style: () => ({ color: "var(--muted)" }) },
    { h: "1σ", cell: (z) => `${z.sigma_pct}%`, style: () => ({ color: "var(--muted)" }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      {chart.dialog}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Side" hint="Long: buy gaps down (the book). Long & short: also short the mirror image.">
          <Segmented label="Side" options={SIDES} value={side} onChange={setSide} />
        </Field>
        <Field label="Stop" hint="None: out at 15:15 (the book). 1σ: the recorded stop one 90-day standard deviation from the open.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {data && (
        <>
          <StatusLine>
            {data.today_recorded
              ? `Today (${data.today}) recorded from the 09:15 open${data.ltp_at ? ` · live prices at ${data.ltp_at}` : ""}`
              : data.market_open
              ? "Waiting for today's 09:15 open (the production scheduler records it)"
              : `Next session ${data.session} · picks are recorded from the 09:15 open on trading days`}
            {data.daily_as_of ? ` · daily candles to ${data.daily_as_of}` : ""} · costs {data.cost_per_side_bps} bps a side · nothing places orders
          </StatusLine>
          <LotCards s={{ ...data.summary, win_rate: data.summary.win_rate_lots, win_days: data.summary.win_days_lots }} money={money} />
          <Panel title={`Today · ${data.today}`} right={today ? `${today.status === "open" ? "open, live" : "closed"} · margin ${formatRs(today.margin_rs)} · net ${netBoth(today.net_rs, today.net_value_pct)}` : undefined}>
            <PositionsTable rows={today?.picks || []} columns={[chart.column, ...columns]} minWidth={1050} empty="No picks today." />
          </Panel>
          <Panel title={`Watchlist for ${data.session}`} right={`${data.watchlist.length} stocks · a pick if it opens past its level and stays on the right side of its 20-day average`}>
            <div className="max-h-96 overflow-auto">
              <PositionsTable rows={data.watchlist} columns={watchCols} minWidth={700} empty="No levels yet (daily candles refresh at 15:45)." />
            </div>
          </Panel>
          <Panel title="Paper log" right="a row a day · click for its positions">
            <DayLog days={data.days} columns={columns} dayValue={(d) => netBoth(d.net_rs, d.net_value_pct)} dayNote={(d) => `margin ${formatRs(d.margin_rs)}`} minWidth={1050} empty="Nothing recorded yet: the first paper day is the next trading day at 09:15 (Kite login needed)." />
          </Panel>
        </>
      )}
    </div>
  );
}
