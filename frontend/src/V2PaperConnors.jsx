import { useMemo, useState } from "react";
import { useSetting } from "./settings";
import V2CandleChart from "./V2CandleChart";
import V2PnlChart from "./V2PnlChart";
import { Field, formatRs, Segmented } from "./V2Controls";
import { tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE, useBacktest, useLiveRefresh } from "./V2BuyOnGap";
import { UNIVERSES } from "./V2BacktestParams";
import { LotCards, lotColumns, lotMoney, netBoth, Panel, usePaperChart, PositionsTable, StatusLine } from "./V2PaperView";

// Short-term mean reversion paper trading on v2: what the production scheduler records at 15:15 (2-day
// RSI below 10, above the 200-day average, hold 5 trading days, at most N open; N is a server setting
// the 15:15 run reads each day). One F&O lot a position; the capital required is the most margin held
// on any day. Shown at futures prices (stock prices are recorded at the same moment). Nothing places orders.

const EXITS = [
  ["hold", "5 days"],
  ["strength", "Exit on strength"],
];

// Today's candidates, live: every stock above its 200-day average by its 2-day RSI (with the price now
// as today's close, as the 15:15 run computes it). The lowest RSIs below 10 fill the free slots at 15:15.
function Candidates({ live, book }) {
  const { data, error } = useBacktest(`/api/connors/paper/watchlist?book=${book}`, { refreshMs: live });
  const [all, setAll] = useState(false);
  const [chart, setChart] = useState(null);
  if (error) return <Panel title="Today's candidates"><p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p></Panel>;
  if (!data) return <Panel title="Today's candidates"><p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p></Panel>;
  const held = new Set(data.held || []);
  let slot = 0;
  const rows = (data.stocks || []).map((x) => {
    let status = "watch";
    if (held.has(x.symbol)) status = "held";
    else if (x.signal) status = slot++ < data.free_slots ? "buy" : "signal";
    return { ...x, status };
  });
  const shown = all ? rows : rows.filter((x, i) => x.signal || i < 15);
  const STATUS = {
    buy: ["Buy at 15:15", "var(--positive)"],
    signal: ["Signal · no free slot", "var(--warning)"],
    held: ["Held", "var(--muted)"],
    watch: ["", "var(--faint)"],
  };
  const cum = data.setup === "cumrsi2";
  const columns = [
    {
      h: "",
      cell: (x) => (
        <button
          type="button"
          onClick={() => setChart(x)}
          className="grid h-6 w-6 place-items-center rounded border transition-colors hover:bg-[var(--surface-2)]"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          title={`${x.symbol}: daily chart with the 200-day average and RSI(2)`}
          aria-label={`${x.symbol} chart`}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M2 13h12M4 10V6M7 11V4M10 9V5M13 8V3" />
          </svg>
        </button>
      ),
    },
    { h: "Stock", cell: (x) => <span className="font-medium">{x.symbol}</span> },
    { h: "Price", cell: (x) => x.price },
    { h: "Today", cell: (x) => (x.change_pct == null ? "—" : `${x.change_pct > 0 ? "+" : ""}${x.change_pct}%`), style: (x) => ({ color: tone(x.change_pct) }) },
    {
      h: "RSI(2)",
      cell: (x) => <span className="font-semibold">{x.rsi.toFixed(1)}</span>,
      style: (x) => ({ color: cum ? "var(--muted)" : x.rsi < data.rsi_max ? "var(--positive)" : x.rsi < 2 * data.rsi_max ? "var(--warning)" : "var(--muted)" }),
      title: () => (cum ? "Wilder's 2-day RSI, the price now as today's close" : `Below ${data.rsi_max} = a signal (Wilder's 2-day RSI, the price now as today's close)`),
    },
    ...(cum
      ? [
          {
            h: "Cum RSI(2)",
            cell: (x) => <span className="font-semibold">{x.cum == null ? "—" : x.cum.toFixed(1)}</span>,
            style: (x) => ({ color: x.cum != null && x.cum < data.cum_max ? "var(--positive)" : x.cum != null && x.cum < 2 * data.cum_max ? "var(--warning)" : "var(--muted)" }),
            title: () => `Today's + yesterday's 2-day RSI; below ${data.cum_max} = a signal`,
          },
        ]
      : []),
    { h: "200-day avg", cell: (x) => x.sma200 ?? "—", style: () => ({ color: "var(--muted)" }) },
    { h: "Above avg", cell: (x) => (x.above_pct == null ? "—" : `+${x.above_pct}%`), style: () => ({ color: "var(--muted)" }) },
    { h: "Status", cell: (x) => STATUS[x.status][0], style: (x) => ({ color: STATUS[x.status][1], fontWeight: x.status === "buy" ? 600 : 400 }) },
  ];
  return (
    <Panel
      title="Today's candidates"
      right={
        data.note ||
        `${data.signals} signals of ${data.above} stocks above their 200-day average · ${data.free_slots} free slot${data.free_slots === 1 ? "" : "s"} · live at ${data.at} · bought at 15:15`
      }
    >
      {chart && (
        <V2CandleChart
          row={{ symbol: chart.symbol, exchange: "NSE" }}
          source="kite"
          initialInterval="day"
          initialDays={180}
          indicators={{ sma: data.sma_days, rsi: { period: 2, level: data.rsi_max } }}
          onClose={() => setChart(null)}
        />
      )}
      <PositionsTable rows={shown} columns={columns} minWidth={760} empty={data.note || "No stock is above its 200-day average."} />
      {rows.length > shown.length || all ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-xs underline" style={{ color: "var(--muted)" }}>
          {all ? "Show signals and the closest 15" : `Show all ${rows.length} above their 200-day average`}
        </button>
      ) : null}
    </Panel>
  );
}

export default function V2PaperConnors({ params, version = 0, book = "rsi2", exit, onExit, saving }) {
  const [slippage, setSlippage] = useSetting(book === "rsi2" ? "paper.connors.slippage" : `paper.connors.${book}.slippage`, 0.02);
  const live = useLiveRefresh();
  const { data, error, loading } = useBacktest(`/api/connors/paper?slippage=${slippage}&v=${version}&book=${book}`, { refreshMs: live });
  const money = useMemo(() => lotMoney(params.show), [params.show]);
  const fut = true; // futures prices only (the stock's price is recorded too, but not shown)
  const key = fut ? "fut" : "stock";
  const maxOpen = data?.max_open ?? 3;
  const strength = (exit || data?.exit) === "strength";
  const cum = data?.setup === "cumrsi2";
  // each trade's one-lot fields for the chosen prices (stock_* or fut_*), under the shared names
  const pick = (t) => ({ ...t, qty: t[`${key}_qty`], margin_rs: t[`${key}_margin_rs`], contract_rs: t[`${key}_contract_rs`], pnl_rs: t[`${key}_pnl_rs`], cost_rs: t[`${key}_cost_rs`], net_rs: t[`${key}_net_rs`], net_margin_pct: t[`${key}_net_margin_pct`], net_value_pct: t[`${key}_net_value_pct`] });
  const lot = lotColumns(money);
  const chart = usePaperChart({ days: 5 });
  const open = (data?.open || []).map(pick);
  const closed = (data?.closed || []).map(pick).map((t) => ({ ...t, net: fut ? t.fut_net_pct : t.net_pct }));
  const L = data?.lots?.[key] || {};
  const estimate = data?.lots?.avg_lot_margin_rs ? maxOpen * data.lots.avg_lot_margin_rs : null;
  const summary = {
    capital_rs: L.capital_rs || estimate,
    capital_estimate: !L.capital_rs && !!estimate,
    days: (data?.days || []).filter((d) => !d.note?.startsWith("market closed")).length,
    trades: L.trades,
    win_rate: L.win_rate,
    net_rs: L.net_rs,
    net_margin_pct: L.net_margin_pct,
    net_value_pct: L.net_value_pct,
    avg_day_rs: null,
    cost_rs: L.cost_rs,
    cost_value_pct: L.cost_value_pct,
    margins_as_of: data?.lots?.margins_as_of,
  };

  const openCols = [
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    AT_COLUMNS[0],
    { h: cum ? "Cum RSI" : "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }), title: () => (cum ? "The cumulative 2-day RSI it was bought at" : "The 2-day RSI it was bought at") },
    { h: fut ? "Future" : "Buy", cell: (t) => (fut ? `${t.fut ?? "—"} @ ${t.fut_buy ?? "—"}` : t.buy) },
    lot.qty,
    { h: "Last", cell: (t) => (fut ? t.fut_ltp : t.ltp) ?? "—" },
    {
      h: "Day",
      cell: (t) => `${t.day_of_hold} / ${data.hold}`,
      style: () => ({ color: "var(--muted)" }),
      title: () => (strength ? `Sold at the first 15:15 its 2-day RSI is above ${data.exit_rsi}, or on day ${data.hold}` : `Sold on day ${data.hold}`),
    },
    lot.value,
    lot.margin,
    { ...lot.result, h: "Net now" },
  ];
  const closedCols = [
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason ?? "time", style: (t) => ({ color: t.reason === "strength" ? "var(--positive)" : "var(--muted)" }) },
    { h: cum ? "Cum RSI" : "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }) },
    { h: "Buy", cell: (t) => (fut ? t.fut_buy ?? "—" : t.buy) },
    lot.qty,
    { h: "Sell", cell: (t) => (fut ? t.fut_sell ?? "—" : t.sell) },
    { h: "Gross", cell: (t) => { const g = fut ? t.fut_gross_pct : t.gross_pct; return g == null ? "—" : `${g.toFixed(2)}%`; }, style: (t) => ({ color: tone(fut ? t.fut_gross_pct : t.gross_pct) }) },
    { h: "Net", cell: (t) => (t.net == null ? "—" : `${t.net.toFixed(2)}%`), style: (t) => ({ color: tone(t.net) }) },
    lot.value,
    lot.margin,
    lot.result,
  ];
  const dayCols = [
    { h: "Day", cell: (d) => d.day },
    { h: "At", cell: (d) => d.recorded_at, style: () => ({ color: "var(--muted)" }) },
    { h: "Universe", cell: (d) => (d.universe ? UNIVERSES[d.universe] || d.universe : "—"), style: () => ({ color: "var(--muted)" }) },
    { h: "Above 200-day", cell: (d) => d.above_average ?? "—" },
    { h: "Signals", cell: (d) => d.signals ?? "—" },
    { h: "Sold", cell: (d) => d.sold ?? "—" },
    { h: "Bought", cell: (d) => d.bought ?? "—" },
    { h: "Note", cell: (d) => d.note ?? "", style: () => ({ color: "var(--muted)" }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      {chart.dialog}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Setup" hint="Fixed for this book: in a stock above its 200-day average">
          <span className="inline-block rounded-md border px-3 py-1.5 text-sm font-medium" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            {book === "cum" ? "Cumulative RSI(2) < 35" : "RSI(2) < 10"}
          </span>
        </Field>
        <Field label="Exit" hint="Read by the 15:15 run, from the next run (open positions too): sold on the 5th trading day, or on strength (the first 15:15 the 2-day RSI is above 65, the 5th day at the latest)">
          <Segmented label="Exit" options={EXITS.map(([v, t]) => [v, t, saving])} value={exit || data?.exit || (book === "cum" ? "strength" : "hold")} onChange={onExit} />
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
            Recorded at 15:15 each trading day:{" "}
            {strength ? `sell positions whose 2-day RSI is above ${data.exit_rsi} (or on their ${data.hold}th trading day)` : `sell positions on their ${data.hold}th trading day`}
            {cum ? ", then buy the lowest cumulative RSI(2) signals below 35 " : ", then buy the most oversold signals (2-day RSI below 10) "}
            into the free slots (at most {maxOpen} open, {UNIVERSES[data.universe] || data.universe}, from the next run) · one lot each · backtest {data.backtest_variant} · costs {data.summary.cost_per_side_bps} bps a side ·
            nothing places orders
          </StatusLine>
          <LotCards
            s={summary}
            money={money}
            extra={[{ label: "Open", value: `${data.open.length} / ${maxOpen}`, hint: L.capital_rs ? undefined : `Capital required is an estimate until trades are recorded: ${maxOpen} × the average lot margin (${formatRs(data.lots?.avg_lot_margin_rs)})` }]}
          />
          <Panel
            title="Open positions"
            right={`${strength ? `sold at 15:15 once RSI(2) > ${data.exit_rsi} (day ${data.hold} at most)` : `sold at 15:15 on the ${data.hold}th trading day`}${data.ltp_at ? ` · live prices at ${data.ltp_at}` : ""}${open.length ? ` · net now ${netBoth(open.reduce((a, t) => a + (t.net_rs || 0), 0), null)}` : ""}`}
          >
            {open.length > 0 && (
              <div className="mb-3">
                <V2PnlChart url={`/api/connors/paper/pnl?slippage=${slippage}&book=${book}&n=${open.map((t) => t.symbol).join(",")}`} refreshMs={live} />
              </div>
            )}
            <PositionsTable rows={open.map((t) => ({ ...t, entry: t.buy, exit: t.ltp }))} columns={[chart.column, ...openCols]} minWidth={760} empty="No open positions." />
          </Panel>
          <Candidates live={live} book={book} />
          <Panel title="Closed trades" right="after charges and slippage on both sides">
            <PositionsTable rows={closed} columns={closedCols} minWidth={900} empty="No closed trades yet." />
          </Panel>
          <Panel title="Daily log" right="recorded at 15:15 by the production scheduler">
            <PositionsTable rows={data.days} columns={dayCols} minWidth={760} empty="Nothing recorded yet: the first run is the next trading day at 15:15 (Kite login needed)." />
          </Panel>
        </>
      )}
    </div>
  );
}
