import { formatRs } from "./V2Controls";
import { tone } from "./V2BacktestView";
import { Panel, PositionsTable } from "./V2PaperView";

// The paper book is filled tick by tick (backend capped.py): a limit order no worse than the printed price by the cap,
// cancelled after the wait, the slot passed to the next candidate, from the recorded order book. This panel puts it
// side by side with the printed-price way (every pick at its open / level + slippage). Nothing places orders.

const rs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);

function Side({ title, s, note }) {
  const row = (k, v, color) => (
    <div className="flex justify-between gap-3">
      <dt style={{ color: "var(--muted)" }}>{k}</dt>
      <dd className="font-medium tabular-nums" style={{ color: color || "var(--text)" }}>{v}</dd>
    </div>
  );
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-0.5 text-xs" style={{ color: "var(--faint)" }}>{note}</p>
      <dl className="mt-3 flex flex-col gap-1.5 text-sm">
        {row("Realized net", rs(s.net_rs), tone(s.net_rs))}
        {row("Open now", rs(s.open_net_rs), tone(s.open_net_rs))}
        {row("Closed trades", s.trades ?? 0)}
        {row("Open trades", s.open_trades ?? 0)}
        {row("Win rate", s.win_rate_lots == null ? "—" : `${s.win_rate_lots}%`)}
        {row("Costs (closed)", s.cost_rs ? formatRs(-s.cost_rs) : "—", "var(--negative)")}
      </dl>
    </div>
  );
}

export default function CappedPanel({ cap, entryLabel = "Fill" }) {
  if (!cap) return null;
  const day = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const fills = cap.days.flatMap((d) => d.picks.map((p) => ({ ...p, day: d.day })));
  const fillCols = [
    { h: "Day", cell: (t) => day(t.day) },
    { h: "Future", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side },
    { h: "Paper price", cell: (t) => t.paper_entry, style: () => ({ color: "var(--muted)" }) },
    { h: entryLabel, cell: (t) => `${t.entry} · ${t.filled_at}`, title: (t) => (t.triggered_at ? `Triggered ${t.triggered_at}` : undefined) },
    {
      h: "vs paper",
      cell: (t) => `${(((t.entry - t.paper_entry) / t.paper_entry) * 100 * (t.side === "long" ? 1 : -1)).toFixed(2)}%`,
      style: (t) => ({ color: (t.entry - t.paper_entry) * (t.side === "long" ? 1 : -1) > 0 ? "var(--negative)" : "var(--positive)" }),
    },
    { h: "Exit / last", cell: (t) => t.exit ?? "—" },
    { h: "Net", cell: (t) => <span className="font-medium">{rs(t.net_rs)}</span>, style: (t) => ({ color: tone(t.net_rs) }) },
  ];
  const missCols = [
    { h: "Day", cell: (m) => day(m.day) },
    { h: "Future", cell: (m) => <span className="font-medium">{m.symbol}</span> },
    { h: "Side", cell: (m) => m.side },
    { h: "Why", cell: (m) => m.reason, style: () => ({ color: "var(--muted)" }) },
    {
      h: "It made (at the printed price)",
      cell: (m) => (m.market_net_rs == null ? "—" : `${rs(m.market_net_rs)}${m.closed ? "" : " · open"}`),
      style: (m) => ({ color: tone(m.market_net_rs) }),
      title: () => "What this pick made (or makes so far) bought at its printed price + slippage: a missed winner is the price of the cap",
    },
  ];
  return (
    <Panel
      title="Tick fills vs printed price · side by side"
      right={`a limit no worse than ${cap.cap_pct}% past the paper price, cancelled after ${cap.wait_s} s, the slot to the next candidate${cap.from ? ` · from ${day(cap.from)} (the tick log)` : ""}`}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Side title="Tick-filled (the book)" s={cap.summary} note="Filled only where the order book allowed within the cap, at the real fill prices" />
        <Side title="At the printed price (for comparison)" s={cap.market_same_days} note="The same days, every pick at its open / level + slippage (thin futures: the order book's cost)" />
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
        Missed so far: {cap.misses.length}
        {cap.missed_closed ? ` · of the closed ones, ${cap.missed_winners} of ${cap.missed_closed} were winners, together ${rs(cap.missed_net_rs)} at the printed price` : ""}
      </p>
      <h3 className="mt-4 mb-1 text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--faint)" }}>Filled</h3>
      <PositionsTable rows={fills} columns={fillCols} minWidth={820} empty="No capped fills yet." />
      <h3 className="mt-4 mb-1 text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--faint)" }}>Missed (cancelled)</h3>
      <div className="max-h-80 overflow-auto">
        <PositionsTable rows={cap.misses} columns={missCols} minWidth={760} empty="No misses yet." />
      </div>
    </Panel>
  );
}
