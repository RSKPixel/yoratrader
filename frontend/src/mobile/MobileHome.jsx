import { tone } from "../V2BacktestView";
import { Countdown, dashboardQuery, OpenPositions, PaperHero, paperTotals, signedRs } from "../V2Dashboard";
import V2PaperCurve from "../V2PaperCurve";
import { statusOf, useModelStatuses } from "../modelStatus";
import { useSettings } from "../settings";
import { link } from "./route";

// The phone app's home: the time and status, every paper book's result today, then each book (tap to open),
// the open positions' charts and the net P&L by day.

export function Status({ d, nextAt }) {
  const market = d.market_open ? ["Market open", "var(--positive)"] : d.preopen ? ["Pre-open", "var(--warning)"] : ["Closed", "var(--faint)"];
  const kite = d.kite?.connected;
  const dot = (color) => <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-3xl font-semibold tabular-nums tracking-tight">{d.now.slice(11, 16)}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            {d.weekday.slice(0, 3)}, {new Date(`${d.today}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · IST
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-xs font-medium">
          <span className="flex items-center gap-1.5" style={{ color: market[1] }}>{dot(market[1])}{market[0]}</span>
          <span className="flex items-center gap-1.5" style={{ color: kite ? "var(--positive)" : "var(--negative)" }}>
            {dot(kite ? "var(--positive)" : "var(--negative)")}Kite {kite ? "on" : "off"}
          </span>
          <span className="tabular-nums" style={{ color: "var(--faint)" }}><Countdown at={nextAt} /></span>
        </div>
      </div>
      {!kite && (
        <a href="/api/kite/login" target="_blank" rel="noreferrer" className="rounded-lg py-2.5 text-center text-sm font-semibold" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
          Kite Login
        </a>
      )}
    </div>
  );
}

function Row({ title, href, sub, value, valueLabel, total, error }) {
  return (
    <a href={href} onClick={link(href)} className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0 active:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)" }}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs" style={{ color: error ? "var(--negative)" : "var(--muted)" }}>{error || sub}</div>
      </div>
      {!error && (
        <div className="text-right tabular-nums">
          <div className="text-sm font-semibold" style={{ color: tone(value) }}>{signedRs(value)}</div>
          <div className="text-[0.6875rem]" style={{ color: "var(--faint)" }}>
            {valueLabel} · realized <span style={{ color: tone(total) }}>{signedRs(total)}</span>
          </div>
        </div>
      )}
      <span style={{ color: "var(--faint)" }} aria-hidden="true">›</span>
    </a>
  );
}

export default function MobileHome({ d, nextAt }) {
  const p = d.paper;
  const statuses = useModelStatuses();
  const query = dashboardQuery(useSettings().values);
  const t = paperTotals(p, statuses);
  const shown = (id) => statusOf(statuses, id) !== "archived";
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {}, tp = p.tom_paper || {};
  const intraday = (b, word, none) => (b.today_status ? `${b.today_positions} ${word} · ${b.today_status === "open" ? "live" : "closed"}` : none);
  const held = (b) => `${b.open ?? 0} / ${b.max_open ?? 3} open${b.open_symbols?.length ? ` · ${b.open_symbols.join(", ")}` : ""}`;
  const rows = [
    ["oops", { title: "Oops gap reversal", sub: intraday(op, "bought", `${op.watched ?? 0} watched, no buys yet`), value: op.today_net_rs, total: op.total_net_rs, error: op.error }],
    ["buy-on-gap", { title: "Buy/Sell on gap", sub: intraday(g, "positions", "no picks yet"), value: g.today_net_rs, total: g.total_net_rs, error: g.error }],
    ["xs-mean-reversion", { title: "Cross-sectional mean reversion", sub: intraday(x, "positions", "not recorded yet"), value: x.today_net_rs, total: x.total_net_rs, error: x.error }],
    ["short-term-reversion", { title: "Short-term mean reversion", sub: held(c), value: c.today_net_rs, total: c.fut_net_rs, error: c.error }],
    ["cumulative-rsi", { title: "Cumulative RSI(2)", sub: held(cc), value: cc.today_net_rs, total: cc.fut_net_rs, error: cc.error }],
    ["turn-of-month", { title: "Turn of the month", sub: tp.open ? `holding ${tp.fut}` : `buy ${tp.buy ?? "—"} · sell ${tp.sell ?? "—"}`, value: tp.today_net_rs, total: tp.total_net_rs, error: tp.error }],
  ].filter(([id]) => shown(id));
  const box = { borderColor: "var(--border)", background: "var(--surface)" };
  return (
    <div className="flex flex-col gap-4">
      <Status d={d} nextAt={nextAt} />
      <PaperHero t={t} />
      <div className="overflow-hidden rounded-xl border" style={box}>
        {rows.map(([id, r]) => <Row key={id} href={`/mobile/paper/${id}`} valueLabel="today" {...r} />)}
      </div>
      <p className="text-[0.6875rem]" style={{ color: "var(--faint)" }}>One lot a position. SR and CR each trade on its own prices (spot or futures). Tap a book to open it.</p>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Open positions</h2>
        <OpenPositions query={query} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Net P&L by day</h2>
        <div className="rounded-xl border p-3" style={box}>
          <V2PaperCurve query={query} />
        </div>
      </section>
    </div>
  );
}
