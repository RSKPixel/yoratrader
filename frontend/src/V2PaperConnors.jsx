import { useMemo, useState } from "react";
import { Field, formatRs, Segmented } from "./V2Controls";
import { makeValue, tone } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";
import { LiveMaxOpen } from "./V2BacktestParams";
import { Panel, PaperCards, PositionsTable, StatusLine } from "./V2PaperView";

// Short-term mean reversion paper trading on v2: what the production scheduler records at 15:15 (2-day
// RSI below 10, above the 200-day average, hold 5 trading days, at most N open). N is a server
// setting the 15:15 run reads each day; each trade keeps the N it was bought under (its size is 1/N of
// capital). Stock and futures prices are recorded at the same moment. Nothing places orders.

const PRICES = [
  ["stock", "Stock prices"],
  ["fut", "Futures prices"],
];

export default function V2PaperConnors({ params }) {
  const [slippage, setSlippage] = useState(0.02);
  const [prices, setPrices] = useState("stock");
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const { data, error, loading } = useBacktest(`/api/connors/paper?slippage=${slippage}&v=${version}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const capital = params.capital;
  const fut = prices === "fut";
  const maxOpen = data?.max_open ?? 3;
  const sw = (t) => 100 / (t.slots || maxOpen); // a trade's share of capital, %: 1 / the max open it was bought under

  const saveMaxOpen = async (n) => {
    setSaving(true);
    setSaveError("");
    try {
      const r = await fetch("/api/connors/paper/max_open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_open: n }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) setSaveError(body.detail || `Could not save (${r.status})`);
      else setVersion((v) => v + 1);
    } catch (e) {
      setSaveError(String(e?.message || e));
    }
    setSaving(false);
  };

  const closed = (data?.closed || []).map((t) => {
    const net = fut ? t.fut_net_pct : t.net_pct;
    return { ...t, net, book_net_pct: net == null ? null : (sw(t) * net) / 100 };
  });
  const nets = closed.filter((t) => t.net != null);
  const summary = {
    days: (data?.days || []).filter((d) => !d.note?.startsWith("market closed")).length,
    trades: nets.length,
    win_rate: nets.length ? Math.round((1000 * nets.filter((t) => t.net > 0).length) / nets.length) / 10 : null,
    win_days: null,
    net_pct: nets.reduce((a, t) => a + t.book_net_pct, 0),
    avg_day_pct: null,
    // charges + slippage on both sides: each trade's gross minus its net, at its slot's share of capital
    cost_pct: nets.reduce((a, t) => {
      const g = fut ? t.fut_gross_pct : t.gross_pct;
      return a + (g == null ? 0 : (sw(t) * (g - t.net)) / 100);
    }, 0),
  };
  const qty = (t) => {
    const p = fut ? t.fut_buy : t.buy;
    return p ? Math.round(((sw(t) / 100) * capital) / p).toLocaleString("en-IN") : "—";
  };

  const openCols = [
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Bought", cell: (t) => `${t.buy_day} ${t.buy_at}` },
    { h: "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }) },
    { h: fut ? "Future" : "Buy", cell: (t) => (fut ? `${t.fut ?? "—"} @ ${t.fut_buy ?? "—"}` : t.buy) },
    { h: "Qty", cell: qty, title: (t) => `${sw(t).toFixed(1)}% of ${formatRs(capital)} ÷ the buy price` },
    { h: "Day", cell: (t) => `${t.day_of_hold} / ${data.hold}`, style: () => ({ color: "var(--muted)" }) },
    { h: "Size", cell: (t) => value(sw(t)), style: () => ({ color: "var(--muted)" }), title: (t) => `1 / ${t.slots || maxOpen} of capital (the max open when bought)` },
  ];
  const closedCols = [
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Bought", cell: (t) => t.buy_day },
    { h: "Sold", cell: (t) => t.sell_day, style: () => ({ color: "var(--muted)" }) },
    { h: "RSI", cell: (t) => t.rsi, style: () => ({ color: "var(--muted)" }) },
    { h: "Buy", cell: (t) => (fut ? t.fut_buy ?? "—" : t.buy) },
    { h: "Qty", cell: qty },
    { h: "Sell", cell: (t) => (fut ? t.fut_sell ?? "—" : t.sell) },
    { h: "Gross", cell: (t) => { const g = fut ? t.fut_gross_pct : t.gross_pct; return g == null ? "—" : `${g.toFixed(2)}%`; }, style: (t) => ({ color: tone(fut ? t.fut_gross_pct : t.gross_pct) }) },
    { h: "Net", cell: (t) => (t.net == null ? "—" : `${t.net.toFixed(2)}%`), style: (t) => ({ color: tone(t.net) }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{t.book_net_pct == null ? "—" : value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];
  const dayCols = [
    { h: "Day", cell: (d) => d.day },
    { h: "At", cell: (d) => d.recorded_at, style: () => ({ color: "var(--muted)" }) },
    { h: "Above 200-day", cell: (d) => d.above_average ?? "—" },
    { h: "Signals", cell: (d) => d.signals ?? "—" },
    { h: "Sold", cell: (d) => d.sold ?? "—" },
    { h: "Bought", cell: (d) => d.bought ?? "—" },
    { h: "Note", cell: (d) => d.note ?? "", style: () => ({ color: "var(--muted)" }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Max open" hint="How many positions the 15:15 run may hold, saved on the server: it applies from the next run. Open positions keep the size they were bought at (1 / the max open then); lowering it only stops new buys until enough positions are sold.">
          <LiveMaxOpen value={maxOpen} onChange={saveMaxOpen} saving={saving} limit={data?.max_open_limit} />
        </Field>
        <Field label="Prices" hint="Each trade is recorded at both the stock's and its future's price at the same moment (the future expiring at least 10 days out, so a hold never crosses expiry).">
          <Segmented label="Prices" options={PRICES} value={prices} onChange={setPrices} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {saveError && <p className="text-sm" style={{ color: "var(--negative)" }}>{saveError}</p>}
      {data && (
        <>
          <StatusLine>
            Recorded at 15:15 each trading day: sell positions on their {data.hold}th trading day, then buy the most oversold signals
            into the free slots (at most {maxOpen} open, from the next run) · each position 1 / max open when bought · backtest {data.backtest_variant} · costs {data.summary.cost_per_side_bps} bps a side ·
            nothing places orders
          </StatusLine>
          <PaperCards s={summary} value={value} extra={[{ label: "Open", value: `${data.open.length} / ${maxOpen}` }]} />
          <Panel title="Open positions" right={`sold at 15:15 on the ${data.hold}th trading day`}>
            <PositionsTable rows={data.open} columns={openCols} minWidth={760} empty="No open positions." />
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
