import { useMemo, useState } from "react";
import { Field, formatRs, Segmented } from "./V2Controls";
import { tone } from "./V2BacktestView";
import { SLIPPAGE, useBacktest, useLiveRefresh } from "./V2BuyOnGap";
import { UNIVERSES } from "./V2BacktestParams";
import { LotCards, lotColumns, lotMoney, netBoth, Panel, usePaperChart, PositionsTable, StatusLine } from "./V2PaperView";

// Short-term mean reversion paper trading on v2: what the production scheduler records at 15:15 (2-day
// RSI below 10, above the 200-day average, hold 5 trading days, at most N open; N is a server setting
// the 15:15 run reads each day). One F&O lot a position; the capital required is the most margin held
// on any day. Stock and futures prices are recorded at the same moment. Nothing places orders.

const PRICES = [
  ["stock", "Stock prices"],
  ["fut", "Futures prices"],
];

export default function V2PaperConnors({ params, version = 0 }) {
  const [slippage, setSlippage] = useState(0.02);
  const [prices, setPrices] = useState("stock");
  const live = useLiveRefresh();
  const { data, error, loading } = useBacktest(`/api/connors/paper?slippage=${slippage}&v=${version}`, { refreshMs: live });
  const money = useMemo(() => lotMoney(params.show), [params.show]);
  const fut = prices === "fut";
  const key = fut ? "fut" : "stock";
  const maxOpen = data?.max_open ?? 3;
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
    { h: "Bought", cell: (t) => `${t.buy_day} ${t.buy_at}` },
    { h: "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }) },
    { h: fut ? "Future" : "Buy", cell: (t) => (fut ? `${t.fut ?? "—"} @ ${t.fut_buy ?? "—"}` : t.buy) },
    lot.qty,
    { h: "Last", cell: (t) => (fut ? t.fut_ltp : t.ltp) ?? "—" },
    { h: "Day", cell: (t) => `${t.day_of_hold} / ${data.hold}`, style: () => ({ color: "var(--muted)" }) },
    lot.value,
    lot.margin,
    { ...lot.result, h: "Net now" },
  ];
  const closedCols = [
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Bought", cell: (t) => t.buy_day },
    { h: "Sold", cell: (t) => t.sell_day, style: () => ({ color: "var(--muted)" }) },
    { h: "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }) },
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
        <Field label="Prices" hint="Each trade is recorded at both the stock's and its future's price at the same moment (the future expiring at least 10 days out, so a hold never crosses expiry).">
          <Segmented label="Prices" options={PRICES} value={prices} onChange={setPrices} />
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
            Recorded at 15:15 each trading day: sell positions on their {data.hold}th trading day, then buy the most oversold signals
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
            right={`sold at 15:15 on the ${data.hold}th trading day${data.ltp_at ? ` · live prices at ${data.ltp_at}` : ""}${open.length ? ` · net now ${netBoth(open.reduce((a, t) => a + (t.net_rs || 0), 0), null)}` : ""}`}
          >
            <PositionsTable rows={open.map((t) => ({ ...t, entry: t.buy, exit: t.ltp }))} columns={[chart.column, ...openCols]} minWidth={760} empty="No open positions." />
          </Panel>
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
