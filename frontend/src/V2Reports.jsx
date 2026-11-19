import { Card, Panel, tone } from "./V2BacktestView";
import { Field, formatRs } from "./V2Controls";
import { useBacktest } from "./V2BuyOnGap";
import { PositionsTable } from "./V2PaperView";
import { useSetting } from "./settings";

// Reports: the intraday paper books' fills against their signals (backend reports.py). Signal price vs the price really
// paid on the way in, printed exit vs the price really got on the way out, the slippage on each side, and analytics.

const rs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);
const pc = (v, d = 3) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—");
// slippage: positive = worse than the signal (paid more / got less)
const slipColor = (v) => (v == null ? undefined : v > 0.0005 ? "var(--negative)" : v < -0.0005 ? "var(--positive)" : "var(--muted)");

function SlipCell({ pct, rupees, source }) {
  if (pct == null) return "—";
  return (
    <span style={{ color: slipColor(pct) }} title={source === "tick" ? "From the recorded order book (the real fill)" : "No order book recorded: the fixed slippage"}>
      {pc(pct)}
      {rupees != null && <span style={{ color: "var(--faint)" }}> · {formatRs(Math.abs(rupees))}</span>}
      {source === "fixed" && <span style={{ color: "var(--faint)" }}> (fixed)</span>}
    </span>
  );
}

function PaperFills() {
  const [pick, setPick] = useSetting("reports.paperfills.day", "all");
  const q = pick === "all" ? "" : `?day_from=${pick}&day_to=${pick}`;
  const { data, error } = useBacktest(`/api/v2/reports/paper-fills${q}`);
  const all = useBacktest("/api/v2/reports/paper-fills").data; // the days list for the picker
  if (error) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!data) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  const o = data.overall;
  const days = (all || data).days || [];
  const bookCols = [
    { h: "Book", cell: (b) => <span className="font-medium">{b.name}</span> },
    { h: "Trades", cell: (b) => (b.error ? "—" : `${b.trades} (${b.open} open)`) },
    { h: "Missed", cell: (b) => b.missed ?? "—" },
    { h: "Fill rate", cell: (b) => (b.fill_rate_pct == null ? "—" : `${b.fill_rate_pct}%`) },
    { h: "Buy-in slip avg / max", cell: (b) => (b.slip_in ? `${pc(b.slip_in.avg)} / ${pc(b.slip_in.max)}` : "—") },
    { h: "Exit slip avg / max", cell: (b) => (b.slip_out ? `${pc(b.slip_out.avg)} / ${pc(b.slip_out.max)}` : "—") },
    { h: "Slippage", cell: (b) => (b.slip_rs == null ? "—" : formatRs(-b.slip_rs)), style: (b) => ({ color: tone(-b.slip_rs) }) },
    { h: "Charges", cell: (b) => (b.charges_rs == null ? "—" : formatRs(-b.charges_rs)), style: () => ({ color: "var(--negative)" }) },
    { h: "Net (closed)", cell: (b) => rs(b.net_rs), style: (b) => ({ color: tone(b.net_rs) }) },
    { h: "Win rate", cell: (b) => (b.win_rate_pct == null ? "—" : `${b.win_rate_pct}%`) },
  ];
  const tradeCols = [
    { h: "Day", cell: (t) => day(t.day) },
    { h: "Book", cell: (t) => t.book_name.split(" ")[0] === "Buy/Sell" ? "Gap" : t.book_name.split(" ")[0] },
    { h: "Future", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side },
    { h: "Qty", cell: (t) => t.qty?.toLocaleString("en-IN") ?? "—" },
    { h: "Signal in", cell: (t) => t.signal_in ?? "—", style: () => ({ color: "var(--muted)" }) },
    { h: t0("in"), cell: (t) => `${t.price_in}${t.at_in ? ` · ${t.at_in}` : ""}` },
    { h: "Slip in", cell: (t) => <SlipCell pct={t.slip_in_pct} rupees={t.slip_in_rs} source={t.in_source} /> },
    { h: "Signal out", cell: (t) => t.signal_out ?? (t.status === "open" ? "open" : "—"), style: () => ({ color: "var(--muted)" }) },
    { h: t0("out"), cell: (t) => (t.price_out == null ? (t.ltp ? `last ${t.ltp}` : "—") : `${t.price_out}${t.at_out ? ` · ${String(t.at_out).slice(-8)}` : ""}`) },
    { h: "Slip out", cell: (t) => <SlipCell pct={t.slip_out_pct} rupees={t.slip_out_rs} source={t.out_source} /> },
    { h: "P&L", cell: (t) => rs(t.pnl_rs), style: (t) => ({ color: tone(t.pnl_rs) }), title: () => "At the prices got (slippage in), before charges" },
    { h: "Charges", cell: (t) => (t.charges_rs == null ? "—" : formatRs(-t.charges_rs)), style: () => ({ color: "var(--negative)" }) },
    { h: "Net", cell: (t) => <span className="font-medium">{rs(t.net_rs)}</span>, style: (t) => ({ color: tone(t.net_rs) }) },
    { h: "Status", cell: (t) => (t.unpaired ? "no pair: sold back" : t.status), style: () => ({ color: "var(--muted)" }) },
  ];
  const missCols = [
    { h: "Day", cell: (m) => day(m.day) },
    { h: "Book", cell: (m) => (m.book === "gap" ? "Gap" : m.book === "xsmr" ? "Cross-sectional" : "Oops") },
    { h: "Future", cell: (m) => <span className="font-medium">{m.symbol}</span> },
    { h: "Side", cell: (m) => m.side },
    { h: "Signal", cell: (m) => (m.signal == null ? "—" : `${m.signal}${m.at ? ` · ${m.at}` : ""}`) },
    { h: "Why", cell: (m) => m.reason, style: () => ({ color: "var(--muted)" }) },
    { h: "Would have made", cell: (m) => (m.would_net_rs == null ? "—" : `${rs(m.would_net_rs)}${m.closed ? "" : " · open"}`), style: (m) => ({ color: tone(m.would_net_rs) }) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Days">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text)" }}
          >
            <option value="all">All days{days.length ? ` (${days.length})` : ""}</option>
            {days.map((d) => (
              <option key={d} value={d}>{day(d)}</option>
            ))}
          </select>
        </Field>
        <p className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
          Oops, Buy/Sell on gap and Cross-sectional, as their paper pages show them (one lot each). Slippage: positive = worse than the signal.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Card label="Trades" value={o.trades} hint={`${o.closed} closed, ${o.open} open`} />
        <Card label="Fill rate" value={o.fill_rate_pct == null ? "—" : `${o.fill_rate_pct}%`} hint={`${o.missed} orders missed (not filled within the cap)`} />
        <Card label="Buy-in slip (avg)" value={o.slip_in ? pc(o.slip_in.avg) : "—"} color={slipColor(o.slip_in?.avg)} hint={o.slip_in ? `Median ${pc(o.slip_in.median)}, worst ${pc(o.slip_in.max)}, best ${pc(o.slip_in.min)} (${o.slip_in.n} tick fills)` : undefined} />
        <Card label="Exit slip (avg)" value={o.slip_out ? pc(o.slip_out.avg) : "—"} color={slipColor(o.slip_out?.avg)} hint={o.slip_out ? `Median ${pc(o.slip_out.median)}, worst ${pc(o.slip_out.max)} (${o.slip_out.n} tick exits)` : "No tick-filled exits yet"} />
        <Card label="Slippage" value={formatRs(-o.slip_rs)} color={tone(-o.slip_rs)} hint="All trades, both sides, one lot each: what the prices got cost against the signals" />
        <Card label="Charges (closed)" value={formatRs(-o.charges_rs)} color="var(--negative)" hint="Brokerage, STT, exchange and SEBI fees, GST, stamp" />
        <Card label="Net (closed)" value={rs(o.net_rs)} color={tone(o.net_rs)} hint={`At the signal prices it would have been ${rs(o.at_signal_rs - o.charges_rs)}`} />
        <Card label="Missed winners" value={data.missed_closed ? `${data.missed_winners} / ${data.missed_closed}` : "—"} hint={data.missed_closed ? `Closed misses that would have made money; together ${rs(data.missed_net_rs)}` : "No closed misses yet"} />
      </div>
      <Panel title="By book" right={`${data.from ? day(data.from) : ""}${data.to && data.to !== data.from ? ` – ${day(data.to)}` : ""}`}>
        <PositionsTable rows={Object.values(data.books)} columns={bookCols} minWidth={980} empty="No books." />
      </Panel>
      {data.worst.length > 0 && (
        <Panel title="Costliest fills" right="the most slippage, both sides">
          <PositionsTable rows={data.worst} columns={tradeCols} minWidth={1300} />
        </Panel>
      )}
      <Panel title="Every trade" right="signal → price got, on the way in and out">
        <PositionsTable rows={data.trades} columns={tradeCols} minWidth={1300} empty="No tick-filled trades for these days." />
      </Panel>
      <Panel title="Missed orders" right="not filled within the cap, or the pair broke">
        <div className="max-h-96 overflow-auto">
          <PositionsTable rows={data.misses} columns={missCols} minWidth={900} empty="No misses." />
        </div>
      </Panel>
    </div>
  );
}

function t0(side) {
  return side === "in" ? "Price in" : "Price out";
}

export default function V2Reports() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <h2 className="mt-3 text-sm font-semibold">Paper fills · signal vs price got</h2>
      </div>
      <PaperFills />
    </div>
  );
}
