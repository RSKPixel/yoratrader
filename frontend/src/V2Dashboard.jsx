import { RefreshCw } from "lucide-react";
import { useSecond } from "./istClock";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Card, Panel, tone } from "./V2BacktestView";
import { formatRs, Segmented } from "./V2Controls";
import { savedParams } from "./V2BacktestParams";
import { useSetting, useSettings } from "./settings";
import { STATUS, statusOf, useModelStatuses } from "./modelStatus";
import { findPaper, paperDefaults } from "./V2Paper";
import V2PaperCurve from "./V2PaperCurve";
import { InstrumentTag } from "./V2SideNav";
import { useResume } from "./resume";
import { usePaperChart } from "./V2PaperView";
import { FundsRow, LiveItemModal, lotsText } from "./V2TradeLanding";

// v2 Dashboard: today at a glance. Refreshes every minute while the market is open (every 5 outside).

const STATE = {
  done: { label: "Done", color: "var(--positive)" },
  pending: { label: "Later", color: "var(--faint)" },
  running: { label: "Due now", color: "var(--warning)" },
  late: { label: "Missed", color: "var(--negative)" },
  off: { label: "No session", color: "var(--faint)" },
};

export const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
export const num = (v) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const go = (href) => (e) => {
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

// The dashboard shows the paper books without linking to their pages (the paper landing page keeps the links)
export const NoPaperLinks = createContext(false);
function PaperLink({ href, className, children, ...rest }) {
  const off = useContext(NoPaperLinks) && href?.startsWith("/v2/paper");
  if (off) return <div className={className?.replace(/hover:\S+/g, "")} {...rest}>{children}</div>;
  return <a href={href} onClick={go(href)} className={className} {...rest}>{children}</a>;
}

function Pill({ color, children, title }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
      title={title}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />
      {children}
    </span>
  );
}

// Seconds to the dashboard's next refresh, ticking each second
export function Countdown({ at }) {
  const now = useSecond(); // the same tick as the clock, so both change at once
  if (!at) return null;
  const left = Math.max(0, Math.ceil((at - Math.floor(now / 1000) * 1000) / 1000));
  return <span title="the dashboard reloads its data then">{left}s</span>;
}

export function RefreshIcon({ spin }) {
  return (
    <RefreshCw className={`h-3 w-3 ${spin ? "animate-spin" : ""}`} strokeWidth={2.2} aria-hidden="true" />
  );
}

function Header({ d, nextAt, onRefresh, loading }) {
  // the four status labels, on the right of the tab row
  const status = d.market_open ? ["Market open", "var(--positive)"] : d.preopen ? ["Pre-open", "var(--warning)"] : ["Market closed", "var(--faint)"];
  const kite = d.kite?.connected;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2 self-center py-1">
      <button type="button" onClick={onRefresh} disabled={loading} title="Refresh now (it also refreshes by itself when the count reaches 0)"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-default"
        style={{ background: "color-mix(in srgb, var(--muted) 14%, transparent)", color: "var(--muted)" }}>
        <RefreshIcon spin={loading} />
        <span className="inline-block min-w-[6.5rem] tabular-nums">{loading ? "Refreshing…" : <>Refresh in <Countdown at={nextAt} /></>}</span>
      </button>
      <Pill color="var(--accent)" title="The next trading session">
        Next session {d.next_session === d.today ? "today" : new Date(`${d.next_session}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
      </Pill>
      <Pill color={status[1]}>{status[0]}</Pill>
      <Pill color={kite ? "var(--positive)" : "var(--negative)"} title={kite ? `as ${d.kite.user_id}` : d.kite?.error}>
        Kite {kite ? "connected" : "not connected"}
      </Pill>
      {!kite && (
        <a href="/api/kite/login" target="_blank" rel="noreferrer" className="rounded-md px-3 py-1 text-xs font-medium" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
          Kite Login
        </a>
      )}
    </div>
  );
}

export function Schedule({ steps }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => {
        const st = STATE[s.state] || STATE.pending;
        return (
          <li key={i} className="flex items-center gap-3 border-t py-2 first:border-t-0" style={{ borderColor: "var(--border)" }}>
            <span className="w-11 text-xs tabular-nums" style={{ color: "var(--muted)" }}>
              {s.at}
            </span>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: st.color }} aria-hidden="true" />
            <span className="min-w-0 flex-1 text-sm">
              {s.label}
              {s.detail && (
                <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
                  {s.detail}
                </span>
              )}
            </span>
            <span className="text-xs font-medium" style={{ color: st.color }}>
              {st.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Realized net's move since yesterday: the trades sold today (up / down arrow and the rupees)
export function Delta({ v, className = "text-xs" }) {
  if (v == null) return null;
  const up = v > 0, down = v < 0;
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums ${className}`} style={{ color: up ? "var(--positive)" : down ? "var(--negative)" : "var(--faint)" }}
      title="Since yesterday: the trades sold today">
      <span aria-hidden="true">{up ? "▲" : down ? "▼" : "•"}</span>
      {up || down ? `${formatRs(Math.abs(v))} today` : "no change today"}
    </span>
  );
}

function PaperCard({ title, href, style, lines, error, price, headline, side }) {
  // side: [label, value, color]: shown to the right of the headline (unrealized)
  // headline: [label, value, color]: the card's big number (the paper books: realized net)
  // on the dashboard (no links to the paper pages) a click opens the book's open positions' charts instead
  const inPlace = useContext(NoPaperLinks) && href.startsWith("/v2/paper");
  const [show, setShow] = useState(false);
  const query = dashboardQuery(useSettings().values);
  return (
    <>
    {show && <BookPositionsModal title={title} query={query} onClose={() => setShow(false)} />}
    <PaperLink
      href={href}
      className={`block rounded-lg border p-4 transition-colors hover:bg-[var(--surface-2)] ${inPlace ? "cursor-pointer" : ""}`}
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      {...(inPlace ? { onClick: () => setShow(true), role: "button", tabIndex: 0, onKeyDown: (e) => (e.key === "Enter" || e.key === " ") && setShow(true), title: "Open positions: click for their charts" } : {})}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="flex items-center gap-1.5">
          <span className="text-[0.625rem] font-medium uppercase tracking-[0.08em]" style={{ color: style === "Intraday" ? "var(--accent)" : "var(--muted)" }}>
            {style}
          </span>
          <InstrumentTag id={href.split("/").pop()} paper price={price} />
        </span>
      </div>
      {error ? (
        <p className="mt-3 text-xs" style={{ color: "var(--negative)" }}>
          {error}
        </p>
      ) : (
        <>
        {headline && (
          <div className="mt-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[0.6875rem]" style={{ color: "var(--muted)" }}>{headline[0]}</div>
              <div className="text-2xl font-semibold tabular-nums tracking-tight" style={{ color: headline[2] || "var(--text)" }}>{headline[1]}</div>
              <Delta v={headline[3]} />
            </div>
            {side && (
              <div className="text-right" title="Open positions marked at the current price: not locked in">
                <div className="text-[0.6875rem]" style={{ color: "var(--muted)" }}>{side[0]}</div>
                <div className="text-lg font-semibold tabular-nums" style={{ color: side[2] || "var(--text)" }}>{side[1]}</div>
              </div>
            )}
          </div>
        )}
        <dl className="mt-3 flex flex-col gap-1.5 border-t pt-3 text-sm" style={{ borderColor: headline ? "var(--border)" : "transparent", ...(headline ? {} : { paddingTop: 0, borderTopWidth: 0 }) }}>
          {lines.map(([k, v, color]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt style={{ color: "var(--muted)" }}>{k}</dt>
              <dd className="tabular-nums font-medium" style={{ color: color || "var(--text)" }}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        </>
      )}
    </PaperLink>
    </>
  );
}

// One paper book's open positions, each a chart of its price since it was bought (the dashboard's model card click)
function BookPositionsModal({ title, query, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v2/paper/open-positions?${query}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
    return () => controller.abort();
  }, [query]);
  useEffect(() => {
    // Esc with a candle chart open on top closes only the chart
    const onKey = (e) => e.key === "Escape" && document.querySelectorAll("[role=dialog]").length < 2 && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // each position with this book's own lot (a stock two books hold: this book's entry and result)
  const rows = (data?.positions || []).flatMap((p) => p.books.filter((b) => b.label === title).map((b) => ({ ...p, ...b, books: [b] })));
  const total = rows.reduce((a, p) => a + (p.net_rs || 0), 0);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${title}: open positions`} className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {data ? `${rows.length} open · unrealized ` : "Loading…"}
              {data && <span style={{ color: tone(total) }}>{signedRs(total)}</span>}
              {data && " · one lot each, after costs, marked now"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>Close</button>
        </div>
        <div className="overflow-auto p-4">
          {data && data.status !== "success" ? (
            <p className="text-sm" style={{ color: "var(--negative)" }}>{data.message}</p>
          ) : data && rows.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing open in this book right now.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((p) => <PositionChart key={`${p.key}-${p.since}-${p.entry}`} p={p} />)}
              </div>
              {rows.length > 0 && <PositionsSchedule rows={rows} />}
            </>
          )}
          {data?.chart_error && <p className="mt-2 text-xs" style={{ color: "var(--warning)" }}>{data.chart_error}</p>}
        </div>
      </div>
    </div>
  );
}

// A book's open positions under its charts: each trade's details and its exit schedule, one row a position
function PositionsSchedule({ rows, model = false }) {
  // the script's candlestick button: the 15-minute candles of what the book trades (the future's contract, or the share)
  const chart = usePaperChart({ days: 5 });
  const asRow = (p) => {
    const fut = p.key?.startsWith("NFO:") ? p.key.split(":")[1] : null;
    return { symbol: p.symbol, side: p.side, stop: p.stop, entry: p.entry, ...(fut ? { fut, fut_buy: p.entry, fut_ltp: p.last } : { exit: p.last }) };
  };
  const px = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const cols = ["Script", ...(model ? ["Model"] : []), "Instrument", "Side", "Qty", "Bought", "Entry", "Now", "Value", "Held", "Net P&L", "Schedule"];
  const color = (when) => (when === "Sell order placed" ? "var(--warning)" : when === "Disaster stop" ? "var(--negative)" : undefined);
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
      <table className="w-full whitespace-nowrap text-xs tabular-nums">
        <thead className="text-left" style={{ background: "var(--surface-2)", color: "var(--faint)" }}>
          <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const fut = p.key?.startsWith("NFO:");
            return (
              <tr key={`${p.key}-${p.since}-${p.entry}-${p.label}`} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                <td className="px-3 py-2 font-semibold">
                  <span className="flex items-center gap-2">{chart.column.cell(asRow(p))}{p.symbol}</span>
                </td>
                {model && <td className="px-3 py-2">{p.label}</td>}
                <td className="px-3 py-2" title={p.key?.split(":")[1]}>{fut ? "Futures" : "Spot"}</td>
                <td className="px-3 py-2" style={{ color: p.side === "short" ? "var(--negative)" : "var(--positive)" }}>{p.side === "short" ? "Short" : "Long"}</td>
                <td className="px-3 py-2">{p.qty ?? "—"}</td>
                <td className="px-3 py-2">{p.entry_at || p.since}</td>
                <td className="px-3 py-2">{px(p.entry)}</td>
                <td className="px-3 py-2">{px(p.last)}</td>
                <td className="px-3 py-2">{p.qty && p.last ? formatRs(p.qty * p.last) : "—"}</td>
                <td className="px-3 py-2">{p.day_of_hold ? `day ${p.day_of_hold}` : p.since === new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) ? "today" : `since ${p.since}`}</td>
                <td className="px-3 py-2 font-semibold" style={{ color: tone(p.net_rs) }}>{p.net_rs == null ? "—" : signedRs(p.net_rs)}</td>
                <td className="px-3 py-2">
                  {(p.plan || []).map(([when, what]) => (
                    <div key={when}>
                      <span className="font-medium" style={{ color: color(when) }}>{when}</span>
                      <span style={{ color: "var(--muted)" }}> · {what}</span>
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {chart.dialog}
    </div>
  );
}

// Whether a paper book holds anything now (the landing page's "With open trades" filter)
function openNow(p) {
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {};
  const live = (b) => b.today_status === "open" && (b.today_positions || 0) > 0;
  return {
    "buy-on-gap": live(g),
    "xs-mean-reversion": live(x),
    oops: live(op),
    "short-term-reversion": (c.open || 0) > 0,
    "cumulative-rsi": (cc.open || 0) > 0,
    "turn-of-month": ((p.tom_paper || {}).open || 0) > 0,
  };
}

// The live trading items (the Live trading page), each a card: on / off, real or dry run, its holdings marked now,
// realized and unrealized (gross, before charges), today's orders and its last log line. Every minute.
function useLiveSummary() {
  const [data, setData] = useState(null);
  const [n, setN] = useState(0);
  const resumed = useResume();
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/v2/live/summary").then((r) => r.json()).then((p) => alive && setData(p)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [resumed, n]);
  return [data, () => setN((x) => x + 1)];
}

// a live card's click: that item's modal (settings, signals, log) over the dashboard
function useItemModal(reload) {
  const [open, setOpen] = useState(null);
  const click = (id) => (e) => {
    e.preventDefault();
    setOpen(id);
  };
  const modal = open != null && <LiveItemModal id={open} onClose={() => setOpen(null)} onChange={reload} />;
  return [click, modal];
}

// The dashboard's summary cards for the live trading items: one small card each (realized, today's arrow, unrealized
// now), and all of them together. Gross: before charges. Nothing when there are no items.
function LiveRow() {
  const [data, reload] = useLiveSummary();
  const [click, modal] = useItemModal(reload);
  if (!data || data.status !== "success" || !data.items.length) return null;
  const items = data.items;
  const add = (k) => items.reduce((a, it) => a + (it[k] || 0), 0);
  const unreal = items.some((it) => it.unrealized_rs != null) ? add("unrealized_rs") : null;
  const badge = (it) => (
    <span className="shrink-0 text-[0.625rem] font-semibold uppercase tracking-[0.08em]" style={{ color: !it.enabled ? "var(--faint)" : it.real ? "var(--negative)" : "var(--accent)" }}>
      {!it.enabled ? "Off" : !it.engine ? "By hand" : it.real ? "Live" : "Dry run"}
    </span>
  );
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>Live trading</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {items.map((it) => (
          <a key={it.id} href="/v2/trade" onClick={click(it.id)} className="rounded-lg border px-3 py-2.5 transition-colors hover:bg-[var(--surface-2)]"
            style={{ borderColor: it.enabled && it.real ? "var(--negative)" : "var(--border)", background: "var(--surface)" }}
            title={`${it.name}: ${it.model} · ${it.account}. Realized (the arrow: sold today) and unrealized now, before charges. Click: its settings`}>
            <div className="flex items-center justify-between gap-2 text-xs" style={{ color: "var(--muted)" }}><span className="truncate">{it.name}</span>{badge(it)}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: tone(it.realized_rs) }}>{signedRs(it.realized_rs ?? 0)}</div>
            <div className="flex flex-wrap items-baseline gap-x-2 text-[0.6875rem] tabular-nums">
              <Delta v={it.sold_today_rs} className="text-[0.6875rem]" />
              <span style={{ color: "var(--muted)" }}>open {it.open.length}{it.unrealized_rs != null ? <span style={{ color: tone(it.unrealized_rs) }}> {signedRs(it.unrealized_rs)}</span> : ""}</span>
            </div>
          </a>
        ))}
        {items.length > 1 && (
          <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--accent)", background: "var(--surface)" }} title="Every live trading item together: realized (the arrow: sold today) and unrealized now, before charges">
            <div className="truncate text-xs font-medium" style={{ color: "var(--text)" }}>All live items</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: tone(add("realized_rs")) }}>{signedRs(add("realized_rs"))}</div>
            <div className="flex flex-wrap items-baseline gap-x-2 text-[0.6875rem] tabular-nums">
              <Delta v={add("sold_today_rs")} className="text-[0.6875rem]" />
              <span style={{ color: "var(--muted)" }}>open {items.reduce((a, it) => a + it.open.length, 0)}{unreal != null ? <span style={{ color: tone(unreal) }}> {signedRs(unreal)}</span> : ""}</span>
            </div>
          </div>
        )}
      </div>
      {modal}
    </section>
  );
}

export function LiveItems() {
  const [data, reload] = useLiveSummary();
  const [click, modal] = useItemModal(reload);
  if (!data) return null;
  if (data.status !== "success") return <p className="text-sm" style={{ color: "var(--negative)" }}>{data.message || data.detail}</p>;
  const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);
  return <>{data.items.map((it) => {
    const s = it.settings || {};
    return (
      <a key={it.id} href="/v2/trade" onClick={click(it.id)} className="flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: it.enabled && it.real ? "var(--negative)" : it.enabled ? "var(--positive)" : "var(--border)", background: "var(--surface)" }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{it.name}</h3>
            <p className="truncate text-xs" style={{ color: "var(--muted)" }}>{it.model}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <span className="rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em]" style={{ background: "var(--surface-2)", color: it.enabled ? "var(--positive)" : "var(--faint)" }}>
              {it.enabled ? "On" : "Off"}
            </span>
            {it.engine && (
              <span className="rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em]" style={{ background: "var(--surface-2)", color: it.real ? "var(--negative)" : "var(--accent)" }}>
                {it.real ? "Live" : "Dry run"}
              </span>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
          <div className="col-span-2 flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Account</dt><dd className="truncate text-right">{it.account}</dd></div>
          <div className="flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Realized</dt><dd style={{ color: tone(it.realized_rs) }}>{signed(it.realized_rs)}</dd></div>
          <div className="flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Unrealized</dt><dd style={{ color: tone(it.unrealized_rs) }}>{signed(it.unrealized_rs)}</dd></div>
          <div className="flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Holding</dt><dd>{it.open.length}{s.max_open != null ? ` / ${s.max_open}` : ""}</dd></div>
          <div className="flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Invested</dt><dd>{formatRs(it.invested_rs)}</dd></div>
          <div className="flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Size</dt><dd className="truncate">{s.capital != null && s.price !== "futures" ? formatRs(s.capital) : s.lots != null ? lotsText(s, it.need_rs) : "1 lot each"}</dd></div>
          <div className="flex justify-between gap-2"><dt style={{ color: "var(--muted)" }}>Trades closed</dt><dd>{it.trades}</dd></div>
          <div className="col-span-2"><FundsRow f={it.funds} settings={s} need={it.need_rs} /></div>
          <div className="col-span-2 flex justify-between gap-2">
            <dt style={{ color: "var(--muted)" }}>Today's orders</dt>
            <dd>{it.real ? `${it.today.sent} sent` : `${it.today.dry} logged`}{it.today.problems ? <span style={{ color: "var(--negative)" }}> · {it.today.problems} problems</span> : ""}</dd>
          </div>
        </dl>
        {it.open.length > 0 && (
          <table className="w-full text-xs tabular-nums">
            <tbody>
              {it.open.map((p) => (
                <tr key={`${p.symbol}-${p.buy_day}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-1 font-semibold">{p.symbol}</td>
                  <td className="py-1" style={{ color: "var(--muted)" }}>{p.qty} @ {num(p.buy_price)}</td>
                  <td className="py-1 text-right">{num(p.last)}</td>
                  <td className="py-1 text-right font-medium" style={{ color: tone(p.pnl_rs) }}>{signed(p.pnl_rs)}</td>
                  <td className="py-1 pl-2 text-right" style={{ color: p.state === "held" ? "var(--faint)" : "var(--warning)" }}>{p.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </a>
    );
  })}{modal}</>;
}

// Turn of the month is traded by hand with real money (Live trading), not paper traded: its own card
export function TomCard({ tm = {} }) {
  const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—");
  return (
      <PaperCard
        title="Turn of the month (ITM)"
        href="/v2/manual/turn-of-month"
        style="Positional"
        error={tm.error}
        lines={[
          ["Now", tm.state === "waiting" ? `waiting · ${tm.days_to_buy} trading days to the buy` : tm.state ?? "—", tm.state && tm.state !== "waiting" ? "var(--warning)" : undefined],
          ["Buy · sell (close)", `${day(tm.buy)} · ${day(tm.sell)}`],
          [tm.call_label || "Call to buy", tm.strike ? `NIFTY ${tm.strike} CE · ${day(tm.expiry)}` : tm.call_label?.startsWith("Call held") ? "buy day's close not stored yet" : "—"],
          ...(tm.best
            ? [
                ["Limit price", `₹${tm.best.limit}`, tm.state?.startsWith("buy") ? "var(--warning)" : undefined],
                ["Per lot", formatRs(tm.best.per_lot)],
              ]
            : []),
        ]}
      />
  );
}

function Paper({ p, today, openOnly = false }) {
  const statuses = useModelStatuses();
  const open = openNow(p);
  const shown = (id) => statusOf(statuses, id) !== "archived" && (!openOnly || open[id]);
  // one F&O lot a position: rupees, with % of the day's margin where there is one
  const rs = (v, m) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}${m == null ? "" : ` · ${pct(m, 2)}`}`);
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {};
  const tm = p.tom || {};
  if (openOnly && !Object.keys(open).some(shown))
    return (
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        No paper book holds anything right now.
      </p>
    );
  const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—");
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {shown("oops") && (
      <PaperCard
        title="Oops gap reversal"
        href="/v2/paper/oops"
        style="Intraday"
        error={op.error}
        headline={["Realized net", rs(op.total_net_rs), tone(op.total_net_rs), op.sold_today_rs]}
        side={["Unrealized", rs(op.open_net_rs), tone(op.open_net_rs)]}
        lines={[
          ["Watching", `${op.watched ?? 0} opened below yesterday's low`],
          ["Today", op.today_status ? `${op.today_positions} bought · ${op.today_status === "open" ? "live" : "closed"}` : "no buys yet"],
          ["Today's net", rs(op.today_net_rs, op.today_value_pct), tone(op.today_net_rs)],
          ["Capital required", op.capital_rs ? formatRs(op.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("buy-on-gap") && (
      <PaperCard
        title="Buy/Sell on gap"
        href="/v2/paper/buy-on-gap"
        style="Intraday"
        error={g.error}
        headline={["Realized net", rs(g.total_net_rs), tone(g.total_net_rs), g.sold_today_rs]}
        side={["Unrealized", rs(g.open_net_rs), tone(g.open_net_rs)]}
        lines={[
          ["Today", g.today_status ? `${g.today_positions} positions · ${g.today_status === "open" ? "live" : "closed"}` : "no picks yet"],
          ["Max open", g.max_open ? g.max_open : "as per model"],
          ["Today's net", rs(g.today_net_rs, g.today_margin_pct), tone(g.today_net_rs)],
          ["Capital required", g.capital_rs ? formatRs(g.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("xs-mean-reversion") && (
      <PaperCard
        title="Cross-sectional mean reversion"
        href="/v2/paper/xs-mean-reversion"
        style="Intraday"
        error={x.error}
        headline={["Realized net", rs(x.total_net_rs), tone(x.total_net_rs), x.sold_today_rs]}
        side={["Unrealized", rs(x.open_net_rs), tone(x.open_net_rs)]}
        lines={[
          ["Today", x.today_status ? `${x.today_positions} positions · ${x.today_status === "open" ? "live" : "closed"}` : "not recorded yet"],
          ["Max open", x.max_open ? `${x.max_open} (${x.pairs} + ${x.pairs})` : "as per model (5 + 5)"],
          ["Today's net", rs(x.today_net_rs, x.today_margin_pct), tone(x.today_net_rs)],
          ["Capital required", x.capital_rs ? formatRs(x.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("short-term-reversion") && (
      <PaperCard
        title="Short-term mean reversion (RSI)"
        href="/v2/paper/short-term-reversion"
        style="Positional"
        price={c.price}
        error={c.error}
        headline={["Realized net", rs(c.fut_net_rs), tone(c.fut_net_rs), c.sold_today_rs]}
        side={["Unrealized", rs(c.open_fut_net_rs), tone(c.open_fut_net_rs)]}
        lines={[
          ["Open", `${c.open ?? 0} / ${c.max_open ?? 3}${c.open_symbols?.length ? ` · ${c.open_symbols.join(", ")}` : ""}`],
          ["Closed trades", c.closed ?? 0],
          ["Today's net", rs(c.today_net_rs, c.today_value_pct), tone(c.today_net_rs)],
          ["Capital required", c.capital_rs ? formatRs(c.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("cumulative-rsi") && (
      <PaperCard
        title="Short-term mean reversion (C-RSI)"
        href="/v2/paper/cumulative-rsi"
        style="Positional"
        price={cc.price}
        error={cc.error}
        headline={["Realized net", rs(cc.fut_net_rs), tone(cc.fut_net_rs), cc.sold_today_rs]}
        side={["Unrealized", rs(cc.open_fut_net_rs), tone(cc.open_fut_net_rs)]}
        lines={[
          ["Open", `${cc.open ?? 0} / ${cc.max_open ?? 3}${cc.open_symbols?.length ? ` · ${cc.open_symbols.join(", ")}` : ""}`],
          ["Closed trades", cc.closed ?? 0],
          ["Today's net", rs(cc.today_net_rs, cc.today_value_pct), tone(cc.today_net_rs)],
          ["Capital required", cc.capital_rs ? formatRs(cc.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("turn-of-month") && (
      <PaperCard
        title="Turn of the month"
        href="/v2/paper/turn-of-month"
        style="Positional"
        error={(p.tom_paper || {}).error}
        headline={["Realized net", rs((p.tom_paper || {}).total_net_rs), tone((p.tom_paper || {}).total_net_rs), (p.tom_paper || {}).sold_today_rs]}
        side={["Unrealized", rs((p.tom_paper || {}).open_net_rs), tone((p.tom_paper || {}).open_net_rs)]}
        lines={[
          ["Now", (p.tom_paper || {}).open ? `holding ${p.tom_paper.fut}` : (p.tom_paper || {}).state === "waiting" ? `${p.tom_paper.days_to_buy} trading days to the buy` : (p.tom_paper || {}).state ?? "—"],
          ["Buy · sell (15:15)", `${day((p.tom_paper || {}).buy)} · ${day((p.tom_paper || {}).sell)}`],
          ["Today's net", rs((p.tom_paper || {}).today_net_rs), tone((p.tom_paper || {}).today_net_rs)],
        ]}
      />
      )}
    </div>
  );
}

export function Models() {
  const statuses = useModelStatuses();
  const [data, setData] = useState(null);
  useEffect(() => {
    let timer;
    const load = () =>
      fetch("/api/v2/dashboard/models")
        .then((r) => r.json())
        .then((p) => {
          if (p.status === "success") setData(p);
          if (p.building && !p.models) timer = setTimeout(load, 5000); // first build: poll until it's ready
        })
        .catch(() => {});
    load();
    return () => clearTimeout(timer);
  }, []);
  if (!data?.models) {
    return (
      <p className="py-4 text-center text-sm" style={{ color: "var(--muted)" }}>
        Building the table (the first time takes about a minute)…
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm tabular-nums">
        <thead className="text-left text-xs" style={{ color: "var(--faint)" }}>
          <tr>
            {["Model", "Settings", "Instrument", "Net / yr", "Sharpe", "Risk of ruin", "Max drawdown", "Green years", `${data.year} so far`].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.models.filter((m) => statusOf(statuses, m.id) !== "archived").map((m) => (
            <tr key={`${m.id}-${m.label}`} className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="px-3 py-2">
                <a href={m.link || `/v2/backtesting/${m.id}`} onClick={go(m.link || `/v2/backtesting/${m.id}`)} className="font-medium hover:underline">
                  {m.label}
                </a>
                {statusOf(statuses, m.id) !== "research" && (
                  <span className="ml-2 text-[0.625rem] font-semibold uppercase tracking-[0.08em]" style={{ color: STATUS[statusOf(statuses, m.id)].color }}>
                    {STATUS[statusOf(statuses, m.id)].label}
                  </span>
                )}
                <span className="ml-2 text-[0.625rem] font-medium uppercase tracking-[0.08em]" style={{ color: m.style === "Intraday" ? "var(--accent)" : "var(--muted)" }}>
                  {m.style}
                </span>
              </td>
              <td className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
                {m.settings}
              </td>
              <td className="px-3 py-2">
                <InstrumentTag id={m.id} universe={/^(Indices|Nifty)/.test(m.settings || "") ? "indices" : "fno"} />
              </td>
              {m.error ? (
                <td colSpan={6} className="px-3 py-2 text-xs" style={{ color: "var(--negative)" }}>
                  {m.error}
                </td>
              ) : (
                <>
                  <td className="px-3 py-2 font-medium" style={{ color: tone(m.net_year_pct) }}>
                    {pct(m.net_year_pct, 1)}
                  </td>
                  <td className="px-3 py-2">{m.sharpe ?? "—"}</td>
                  <td
                    className="px-3 py-2"
                    style={{ color: m.ruin_pct == null ? "var(--muted)" : m.ruin_pct === 0 ? "var(--positive)" : "var(--negative)" }}
                    title="Penfold: must be 0. The chance of falling below half the capital within 10 years (from the backtest's own months, resampled), at full size"
                  >
                    {m.ruin_pct == null ? "—" : m.ruin_pct === 0 ? "0% ✓" : `${m.ruin_pct}%`}
                  </td>
                  <td className="px-3 py-2" style={{ color: "var(--negative)" }}>
                    {pct(m.max_dd_pct, 1)}
                  </td>
                  <td className="px-3 py-2" style={{ color: "var(--muted)" }}>
                    {m.green ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-medium" style={{ color: tone(m.this_year_pct) }}>
                    {pct(m.this_year_pct, 1)}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 pt-2 text-xs" style={{ color: "var(--faint)" }}>
        Net of costs at 0.02% slippage, % of capital a year, not compounded. Click a model for its backtest.
      </p>
    </div>
  );
}

function Freshness({ f, expected }) {
  const items = [
    ["Backtest · daily", f.backtest_daily, "F&O stocks (refreshed 15:45)"],
    ["Backtest · index daily", f.backtest_index_daily, "the five indices"],
    ["Backtest · 15 min", f.backtest_15m, "F&O stocks"],
    ["Live futures · daily", f.live_daily, "Data → Live futures → Download EOD"],
    ["Live futures · 15 min", f.live_15m, "Data → Live futures → Download 15 min"],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {items.map(([label, day, hint]) => {
        const stale = !day || day < expected;
        return <Card key={label} label={label} value={day || "—"} color={stale ? "var(--warning)" : "var(--positive)"} hint={`${hint}${stale ? ` · behind (expected ${expected})` : " · up to date"}`} />;
      })}
    </div>
  );
}

// The paper cards use the max open each paper page was last set to (the user's settings)
export function dashboardQuery(values) {
  const max = (id) => savedParams(values, `paper-${id}`, paperDefaults(findPaper(id))).maxOpen || paperDefaults(findPaper(id)).maxOpen;
  return `gap_max_open=${max("buy-on-gap")}&xsmr_max_open=${max("xs-mean-reversion")}`;
}

// The dashboard's data (refreshed each minute in market hours, every 5 minutes otherwise)
export function useDashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [nextAt, setNextAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(null);
  const query = dashboardQuery(useSettings().values);
  const resumed = useResume();
  useEffect(() => {
    let timer;
    const schedule = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(load, ms);
      setNextAt(Date.now() + ms);
    };
    const load = () => {
      setLoading(true);
      return fetch(`/api/v2/dashboard?${query}`)
        .then((r) => r.json())
        .then((p) => {
          if (p.status !== "success") setError(p.message || p.detail || "Could not load the dashboard");
          else {
            setError("");
            setD(p);
          }
          schedule(p.market_open || p.preopen ? 60000 : 300000);
        })
        .catch(() => {
          setError("Could not reach the API");
          schedule(60000);
        })
        .finally(() => setLoading(false));
    };
    loadRef.current = load;
    load();
    const onKite = () => load();
    window.addEventListener("kite-status-changed", onKite);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("kite-status-changed", onKite);
    };
  }, [query, resumed]);
  // the Refresh button: load now (the next automatic refresh counts from then)
  const reload = useCallback(() => loadRef.current?.(), []);
  return { d, error, nextAt, reload, loading };
}

// Across every paper book (archived ones left out): what's open, and the net (SR and CR each trade on its own prices (spot or futures))
// Across every paper book (archived ones left out): books and positions open now, today's and total net
export function paperTotals(p, statuses) {
  const on = (id) => statusOf(statuses, id) !== "archived";
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {}, tp = p.tom_paper || {};
  const open = openNow(p);
  const ids = Object.keys(open).filter(on);
  const live = (b) => (b.today_status === "open" ? b.today_positions || 0 : 0);
  const positions =
    (on("buy-on-gap") ? live(g) : 0) + (on("xs-mean-reversion") ? live(x) : 0) + (on("oops") ? live(op) : 0) +
    (on("short-term-reversion") ? c.open || 0 : 0) + (on("cumulative-rsi") ? cc.open || 0 : 0) + (on("turn-of-month") ? tp.open || 0 : 0);
  const sum = (pairs) => pairs.filter(([id, v]) => on(id) && v != null).reduce((a, [, v]) => a + v, 0);
  const today = sum([["buy-on-gap", g.today_net_rs], ["xs-mean-reversion", x.today_net_rs], ["oops", op.today_net_rs],
    ["short-term-reversion", c.today_net_rs], ["cumulative-rsi", cc.today_net_rs], ["turn-of-month", tp.today_net_rs]]);
  const total = sum([["buy-on-gap", g.total_net_rs], ["xs-mean-reversion", x.total_net_rs], ["oops", op.total_net_rs],
    ["short-term-reversion", c.fut_net_rs], ["cumulative-rsi", cc.fut_net_rs], ["turn-of-month", tp.total_net_rs]]);
  const openRs = sum([["buy-on-gap", g.open_net_rs], ["xs-mean-reversion", x.open_net_rs], ["oops", op.open_net_rs],
    ["short-term-reversion", c.open_fut_net_rs], ["cumulative-rsi", cc.open_fut_net_rs], ["turn-of-month", tp.open_net_rs]]);
  const openToday = sum([["buy-on-gap", g.open_today_rs], ["xs-mean-reversion", x.open_today_rs], ["oops", op.open_today_rs],
    ["short-term-reversion", c.open_today_rs], ["cumulative-rsi", cc.open_today_rs], ["turn-of-month", tp.open_today_rs]]);
  const soldToday = sum([["buy-on-gap", g.sold_today_rs], ["xs-mean-reversion", x.sold_today_rs], ["oops", op.sold_today_rs],
    ["short-term-reversion", c.sold_today_rs], ["cumulative-rsi", cc.sold_today_rs], ["turn-of-month", tp.sold_today_rs]]);
  // capital each book needs (its own setting): SR / CR on spot are cash (delivery), the futures books margin (their biggest day / slots)
  const spot = (b) => b.price === "spot";
  const caps = [["buy-on-gap", g, false], ["xs-mean-reversion", x, false], ["oops", op, false],
    ["short-term-reversion", c, spot(c)], ["cumulative-rsi", cc, spot(cc)], ["turn-of-month", tp, false]].filter(([id, b]) => on(id) && b.capital_rs);
  const cash = caps.filter(([, , isCash]) => isCash).reduce((a, [, b]) => a + b.capital_rs, 0);
  const margin = caps.filter(([, , isCash]) => !isCash).reduce((a, [, b]) => a + b.capital_rs, 0);
  return { openBooks: ids.filter((id) => open[id]).length, books: ids.length, positions, today, total, openRs, openToday, soldToday, cash, margin };
}

function PaperTotals({ p, realized = true }) {
  // realized false: the dashboard, whose realized total ends the Realized net by model row
  const { openBooks, books, positions, today, total, openRs, openToday, soldToday, cash, margin } = paperTotals(p, useModelStatuses());
  const query = dashboardQuery(useSettings().values);
  const [showOpen, setShowOpen] = useState(false);
  const [showRealized, setShowRealized] = useState(false);
  const signed = (v) => `${v > 0 ? "+" : ""}${formatRs(v)}`;
  return (
    <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6`}>
      <button type="button" onClick={() => setShowRealized(true)} className="h-full rounded-lg border px-3 py-2.5 text-left transition-opacity hover:opacity-80" style={{ borderColor: "var(--border)", background: "var(--surface)" }} title="Trades already sold, every paper book since it started, one lot each, after charges and slippage. The arrow: how much it moved today (the trades sold today). Click for every sold trade">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--faint)" }}>Total realized</p>
        <p className="mt-1 text-lg font-semibold tabular-nums" style={{ color: tone(total) }}>{signed(total)}</p>
        <Delta v={soldToday} className="text-[0.6875rem]" />
      </button>
      <Card label="Today's realized" value={signed(soldToday)} color={tone(soldToday)} hint="Trades sold today, every paper book, one lot each, after charges and slippage: each sale's whole result (Oops: yesterday's buys sold at today's open too)" />
      <Card label="Total unrealized" value={signed(openRs)} color={tone(openRs)} hint="Every position still held, all paper books, one lot each, marked now: its whole result since it was bought, after charges and slippage" />
      <Card label="Books with open trades" value={`${openBooks} / ${books}`} hint="Paper books holding something now" />
      <button type="button" onClick={() => setShowOpen(true)} className="h-full text-left transition-opacity hover:opacity-80 [&>div]:h-full" aria-label="Open positions: show the details">
        <Card label="Open positions" value={positions} hint="Every position held now, all paper books: click for the details" />
      </button>
      <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }} title="What every active paper book needs, one lot a position, each at its own settings: cash for the books bought on spot (delivery: SR / CR when on spot), margin for the futures books (their biggest day's margin, or slots × a lot's margin)">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--faint)" }}>Capital required</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{formatRs(cash + margin)}</p>
        <p className="text-[0.6875rem] tabular-nums" style={{ color: "var(--muted)" }}>cash {formatRs(cash)} · margin {formatRs(margin)}</p>
      </div>
      {showOpen && <OpenPositionsModal query={query} onClose={() => setShowOpen(false)} />}
      {showRealized && <RealizedModal query={query} onClose={() => setShowRealized(false)} />}
    </div>
  );
}

// Every sold paper trade in one table (the Total realized card's click), newest sale first, with the total
export function RealizedModal({ query, onClose }) {
  const [data, setData] = useState(null);
  const statuses = useModelStatuses();
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v2/paper/realized?${query}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
    return () => controller.abort();
  }, [query]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // the books the card counts (archived ones left out)
  const rows = (data?.trades || []).filter((t) => statusOf(statuses, t.id) !== "archived");
  const total = rows.reduce((a, t) => a + (t.net_rs || 0), 0);
  const wins = rows.filter((t) => (t.net_rs || 0) > 0).length;
  const px = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const cols = ["Script", "Model", "Side", "Qty", "Bought", "Entry", "Sold", "Exit", "Why sold", "Net P&L", "Net %"];
  const errors = Object.entries(data?.errors || {});
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Realized trades" className="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="text-base font-semibold">Realized trades</h2>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {data ? `${rows.length} trades sold · ${wins} winners · realized ` : "Loading…"}
              {data && <span style={{ color: tone(total) }}>{signedRs(total)}</span>}
              {data && " · one lot each, after charges and slippage"}
            </p>
            {errors.length > 0 && <p className="text-xs" style={{ color: "var(--negative)" }}>Not loaded: {errors.map(([k]) => k).join(", ")}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>Close</button>
        </div>
        <div className="overflow-auto">
          {data && data.status !== "success" ? (
            <p className="p-4 text-sm" style={{ color: "var(--negative)" }}>{data.message}</p>
          ) : data && rows.length === 0 ? (
            <p className="p-4 text-sm" style={{ color: "var(--muted)" }}>No paper trade has been sold yet.</p>
          ) : (
            <table className="w-full whitespace-nowrap text-xs tabular-nums" style={{ minWidth: 900 }}>
              <thead className="sticky top-0 text-left" style={{ background: "var(--surface)", color: "var(--faint)" }}>
                <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((t, i) => (
                  <tr key={`${t.id}-${t.symbol}-${t.entry_at}-${i}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="px-3 py-2 font-semibold">{t.symbol}</td>
                    <td className="px-3 py-2">{t.book}</td>
                    <td className="px-3 py-2" style={{ color: t.side === "short" ? "var(--negative)" : "var(--positive)" }}>{t.side === "short" ? "Short" : "Long"}</td>
                    <td className="px-3 py-2">{t.qty ?? "—"}</td>
                    <td className="px-3 py-2">{t.entry_at || "—"}</td>
                    <td className="px-3 py-2">{px(t.entry)}</td>
                    <td className="px-3 py-2">{t.exit_at || "—"}</td>
                    <td className="px-3 py-2">{px(t.exit)}</td>
                    <td className="px-3 py-2" style={{ color: "var(--muted)" }}>{t.reason || "—"}</td>
                    <td className="px-3 py-2 font-semibold" style={{ color: tone(t.net_rs) }}>{t.net_rs == null ? "—" : signedRs(t.net_rs)}</td>
                    <td className="px-3 py-2" style={{ color: tone(t.net_pct) }}>{t.net_pct == null ? "—" : `${t.net_pct > 0 ? "+" : ""}${Number(t.net_pct).toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="sticky bottom-0" style={{ background: "var(--surface-2)" }}>
                  <tr className="border-t font-semibold" style={{ borderColor: "var(--border)" }}>
                    <td className="px-3 py-2" colSpan={9}>Total · {rows.length} trades</td>
                    <td className="px-3 py-2" style={{ color: tone(total) }}>{signedRs(total)}</td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// Every open paper position in one table (the Open positions card's click): script, model, side, entry, now, P&L
export function OpenPositionsModal({ query, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v2/paper/open-positions?${query}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
    return () => controller.abort();
  }, [query]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // one row a book: a stock two books hold is two lots, each with its own result (as the Unrealized card counts them)
  const rows = (data?.positions || []).flatMap((p) => p.books.map((b) => ({ ...p, ...b, book: b })));
  const total = rows.reduce((a, p) => a + (p.net_rs || 0), 0);
  const px = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const cols = ["Script", "Model", "Instrument", "Side", "Entry date & time", "Entry", "Now", "Stop", "Held", "Net P&L", "Net %"];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Open positions" className="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="text-base font-semibold">Open positions</h2>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {data ? `${rows.length} lots held · unrealized ` : "Loading…"}
              {data && <span style={{ color: tone(total) }}>{signedRs(total)}</span>}
              {data && " · one lot each, after charges and slippage, marked now"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>Close</button>
        </div>
        <div className="overflow-auto">
          {data && data.status !== "success" ? (
            <p className="p-4 text-sm" style={{ color: "var(--negative)" }}>{data.message}</p>
          ) : data && rows.length === 0 ? (
            <p className="p-4 text-sm" style={{ color: "var(--muted)" }}>No paper book holds anything right now.</p>
          ) : (
            <table className="w-full whitespace-nowrap text-xs tabular-nums" style={{ minWidth: 900 }}>
              <thead className="sticky top-0 text-left" style={{ background: "var(--surface)", color: "var(--faint)" }}>
                <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const fut = p.key?.startsWith("NFO:");
                  return (
                    <tr key={`${p.key}-${p.since}-${p.entry}-${p.book.label}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="px-3 py-2 font-semibold">{p.symbol}</td>
                      <td className="px-3 py-2">
                        <PaperLink href={p.book.href} className="underline-offset-2 hover:underline">{p.book.label}</PaperLink>
                      </td>
                      <td className="px-3 py-2" title={p.key?.split(":")[1]}>{fut ? "Futures" : "Spot"}</td>
                      <td className="px-3 py-2" style={{ color: p.side === "short" ? "var(--negative)" : "var(--positive)" }}>{p.side === "short" ? "Short" : "Long"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{p.entry_at || p.since}</td>
                      <td className="px-3 py-2">{px(p.entry)}</td>
                      <td className="px-3 py-2">{px(p.last)}</td>
                      <td className="px-3 py-2">{px(p.stop)}</td>
                      <td className="px-3 py-2">{p.day_of_hold ? `day ${p.day_of_hold}` : p.since === new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) ? "today" : `since ${p.since}`}</td>
                      <td className="px-3 py-2 font-semibold" style={{ color: tone(p.net_rs) }}>{p.net_rs == null ? "—" : signedRs(p.net_rs)}</td>
                      <td className="px-3 py-2" style={{ color: tone(p.net_pct) }}>{p.net_pct == null ? "—" : `${p.net_pct > 0 ? "+" : ""}${Number(p.net_pct).toFixed(2)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="sticky bottom-0" style={{ background: "var(--surface-2)" }}>
                  <tr className="border-t font-semibold" style={{ borderColor: "var(--border)" }}>
                    <td className="px-3 py-2" colSpan={9}>Total · {rows.length} lots</td>
                    <td className="px-3 py-2" style={{ color: tone(total) }}>{signedRs(total)}</td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// The paper trading landing page: the dashboard's paper trading cards, each opening its model's page
export function PaperOverview() {
  const { d, error } = useDashboard();
  const curveQuery = dashboardQuery(useSettings().values);
  const [filter, setFilter] = useSetting("paper.landing.filter", "all");
  if (error && !d) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex">
        <Segmented
          label="Show"
          options={[
            ["open", "With open trades"],
            ["all", "All"],
          ]}
          value={filter}
          onChange={setFilter}
        />
      </div>
      <PaperTotals p={d.paper} />
      <Panel title="Open positions">
        <OpenPositions query={curveQuery} />
      </Panel>
      <Paper p={d.paper} today={d.today} openOnly={filter === "open"} />
      <Panel title="Paper vs backtest" right="closed paper trades against the backtest on the same days, same settings">
        <PaperCheck query={curveQuery} />
      </Panel>
      <Panel title="Net P&L by day" right="cumulative, one lot a position · SR and CR each trade on its own prices (spot or futures), open positions marked now">
        <V2PaperCurve query={curveQuery} />
      </Panel>
    </div>
  );
}

// Every paper book's open positions, each a small chart of its price since it was bought (refreshed each minute)
export function OpenPositions({ query, schedule = false }) {
  const [data, setData] = useState(null);
  const resumed = useResume();
  useEffect(() => {
    let timer;
    const controller = new AbortController();
    const load = () =>
      fetch(`/api/v2/paper/open-positions?${query}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((p) => {
          setData(p);
          timer = setTimeout(load, 60000);
        })
        .catch(() => {
          timer = setTimeout(load, 60000);
        });
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, resumed]);
  if (!data) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  if (data.status !== "success") return <p className="text-sm" style={{ color: "var(--negative)" }}>{data.message}</p>;
  const rows = data.positions || [];
  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>No paper book holds anything right now.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rows.map((p) => <PositionChart key={`${p.key}-${p.since}-${p.entry}`} p={p} />)}
        </div>
      )}
      {schedule && rows.length > 0 && (
        // one row a book (a stock two books hold: each book's own lot and schedule)
        <PositionsSchedule model rows={rows.flatMap((p) => p.books.map((b) => ({ ...p, ...b, books: [b] })))} />
      )}
      {(data.chart_error || Object.keys(data.errors || {}).length > 0) && (
        <p className="text-xs" style={{ color: "var(--warning)" }}>
          {[data.chart_error, ...Object.entries(data.errors || {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

function PositionChart({ p }) {
  const closes = p.closes || [];
  const W = 300, H = 90, pad = 4;
  const prices = closes.map((c) => c[1]).concat([p.entry, p.stop].filter((v) => v != null));
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const span = hi - lo || 1;
  const y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / span);
  const x = (i) => (closes.length > 1 ? (W * i) / (closes.length - 1) : W / 2);
  const line = closes.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c[1]).toFixed(1)}`).join("");
  const color = tone(p.net_rs) || "var(--muted)";
  const short = p.side === "short";
  const days = closes.length ? new Set(closes.map((c) => new Date(c[0] * 1000).toISOString().slice(0, 10))).size : 0;
  return (
    <PaperLink href={p.books[0].href} className="flex flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            {p.symbol}
            {short && <span className="rounded px-1 text-[0.625rem] font-medium uppercase" style={{ background: "var(--surface-2)", color: "var(--negative)" }}>short</span>}
            {p.key.startsWith("NFO:") && <span className="text-[0.625rem] font-medium uppercase tracking-[0.06em]" style={{ color: "var(--faint)" }}>fut</span>}
          </div>
          <div className="truncate text-[0.6875rem]" style={{ color: "var(--muted)" }}>{p.books.map((b) => b.label).join(" · ")}</div>
        </div>
        <div className="text-right tabular-nums">
          <div className="text-sm font-semibold" style={{ color }}>{p.net_rs == null ? "—" : `${p.net_rs > 0 ? "+" : ""}${formatRs(p.net_rs)}`}</div>
          <div className="text-[0.6875rem]" style={{ color }}>{pct(p.net_pct)}</div>
        </div>
      </div>
      {closes.length > 1 ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-20 w-full" role="img" aria-label={`${p.symbol} price since bought`}>
          <line x1="0" x2={W} y1={y(p.entry)} y2={y(p.entry)} stroke="var(--accent)" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          {p.stop != null && <line x1="0" x2={W} y1={y(p.stop)} y2={y(p.stop)} stroke="var(--negative)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
          <path d={`${line}L${W},${H}L0,${H}Z`} fill={color} opacity="0.08" />
          <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="grid h-20 place-items-center text-xs" style={{ color: "var(--faint)" }}>No price path</div>
      )}
      <div className="flex justify-between text-[0.6875rem] tabular-nums" style={{ color: "var(--muted)" }}>
        <span>
          <span style={{ color: "var(--accent)" }}>{short ? "Sold" : "Bought"} {num(p.entry)}</span>
          {p.stop != null && <span style={{ color: "var(--negative)" }}> · stop {num(p.stop)}</span>}
        </span>
        <span>
          now {num(p.last)} · {p.day_of_hold ? `day ${p.day_of_hold}` : days > 1 ? `${days} days` : "today"}
        </span>
      </div>
    </PaperLink>
  );
}

// Each paper book against its backtest over the same days: the sign a backtest was too good is a paper
// result that stays well below it over enough trades (v2check.py).
function PaperCheck({ query }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const resumed = useResume();
  useEffect(() => {
    let alive = true;
    fetch(`/api/v2/paper/check?${query}`)
      .then((r) => r.json())
      .then((p) => alive && (p.status === "success" ? (setData(p), setError("")) : setError(p.message || "Could not load the check")))
      .catch(() => alive && setError("Could not reach the API"));
    return () => {
      alive = false;
    };
  }, [query, resumed]);
  if (error) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!data) return <p className="text-sm" style={{ color: "var(--faint)" }}>Comparing… (the first time builds the backtests, up to a couple of minutes)</p>;
  const n = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  const statusColor = (st) => (st === "in line" ? "var(--positive)" : st === "behind the backtest" ? "var(--negative)" : "var(--muted)");
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm tabular-nums">
        <thead className="text-left text-xs" style={{ color: "var(--faint)" }}>
          <tr>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Days compared</th>
            <th className="px-3 py-2 font-medium">Paper trades</th>
            <th className="px-3 py-2 font-medium">Backtest trades</th>
            <th className="px-3 py-2 font-medium">Same picks</th>
            <th className="px-3 py-2 font-medium">Paper win / avg</th>
            <th className="px-3 py-2 font-medium">Backtest win / avg</th>
            <th className="px-3 py-2 font-medium">Paper − backtest</th>
            <th className="px-3 py-2 font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key} className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="px-3 py-2">
                <PaperLink href={r.link} className="font-medium hover:underline">
                  {r.label}
                </PaperLink>
              </td>
              {r.error ? (
                <td colSpan={8} className="px-3 py-2 text-xs" style={{ color: "var(--negative)" }}>
                  {r.error}
                </td>
              ) : (
                <>
                  <td className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
                    {r.since && r.until && r.since <= r.until ? `${r.since} → ${r.until}` : "—"}
                  </td>
                  <td className="px-3 py-2">{r.paper.trades}</td>
                  <td className="px-3 py-2">{r.backtest.trades}</td>
                  <td className="px-3 py-2" title="Of the paper's (day, stock) picks, how many the backtest also took">
                    {r.same_picks_pct == null ? "—" : `${r.same_picks_pct}%`}
                  </td>
                  <td className="px-3 py-2">
                    {r.paper.win_rate == null ? "—" : `${r.paper.win_rate}%`} · <span style={{ color: tone(r.paper.avg_net_pct) }}>{n(r.paper.avg_net_pct)}</span>
                  </td>
                  <td className="px-3 py-2">
                    {r.backtest.win_rate == null ? "—" : `${r.backtest.win_rate}%`} ·{" "}
                    <span style={{ color: tone(r.backtest.avg_net_pct) }}>{n(r.backtest.avg_net_pct)}</span>
                  </td>
                  <td className="px-3 py-2" style={{ color: tone(r.diff_pct) }} title="Average net per trade, after costs: paper minus backtest">
                    {n(r.diff_pct)}
                  </td>
                  <td className="px-3 py-2 text-xs" style={{ color: statusColor(r.status) }}>
                    {r.status}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        Average net per trade, each trade on its own value after costs. A verdict needs at least {data.min_trades} closed paper trades; until then it says
        too early. The backtest store is topped up after the close, so the latest paper days join the next day (a day later for next-open exits,
        about a week for the 5-day holds).
      </p>
    </div>
  );
}

const DASH_TABS = [
  { id: "paper", label: "Paper trading" },
  { id: "live", label: "Live trading" },
  { id: "manual", label: "Manual trading" },
];

export default function V2Dashboard() {
  const { d, error, nextAt, reload, loading } = useDashboard();
  // the tab row's shadow: only while the page is scrolled under it
  const barRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const main = barRef.current?.closest("main");
    if (!main) return undefined;
    const on = () => setScrolled(main.scrollTop > 2);
    on();
    main.addEventListener("scroll", on, { passive: true });
    return () => main.removeEventListener("scroll", on);
  }, [d == null]);
  const [saved, setTab] = useSetting("dashboard.tab", "paper");
  const tab = DASH_TABS.some((t) => t.id === saved) ? saved : "paper";
  if (error && !d) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      <div ref={barRef} className="sticky -top-6 z-10 -mx-4 -mt-6 flex flex-wrap items-end gap-1 border-b px-4 pt-2 transition-[box-shadow,background-color] md:-mx-6 md:px-6"
        style={{ borderColor: "var(--border)", background: "var(--surface)", boxShadow: scrolled ? "var(--bar-shadow)" : "none" }}>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Dashboard sections">
        {DASH_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="-mb-px cursor-pointer border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors hover:text-[var(--text)]"
            style={tab === t.id ? { borderColor: "var(--accent)", color: "var(--text)" } : { borderColor: "transparent", color: "var(--muted)" }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Header d={d} nextAt={nextAt} onRefresh={reload} loading={loading} />
      </div>
      <div role="tabpanel">
        {tab === "paper" && (
          <NoPaperLinks.Provider value={true}>
            <WidePaper p={d.paper} today={d.today} />
          </NoPaperLinks.Provider>
        )}
        {tab === "live" && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <LiveItems />
          </div>
        )}
        {tab === "manual" && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <TomCard tm={d.paper.tom} />
          </div>
        )}
      </div>
    </div>
  );
}

// Settings' Schedules tab (it was the dashboard's): today's schedule and how fresh the data is
export function SchedulesPanel() {
  const { d, error } = useDashboard();
  if (error && !d) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Today's schedule" right="the production scheduler, automatically">
        <Schedule steps={d.schedule} />
      </Panel>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Data</h2>
        <Freshness f={d.freshness} expected={d.expected_data} />
      </section>
    </div>
  );
}

// The phone has an app of its own at /mobile (src/mobile/): a phone opening the site's home goes there (main.jsx).

export const signedRs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);

export function PaperHero({ t, wide = false, onPositions, onRealized }) {
  const stat = (label, v, hint) => (
    <div title={hint}>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
      <div className={`font-semibold ${wide ? "text-lg" : ""}`} style={{ color: tone(v) }}>{signedRs(v)}</div>
    </div>
  );
  const realized = stat("Realized net", t.total, "Trades already sold, every paper book since it started, one lot each, after charges and slippage");
  const open = stat("Total unrealized", t.openRs, "Every position still held, all paper books, one lot each, marked now: its whole result since it was bought, after costs: not locked in");
  const count = `${t.positions} positions open · ${t.openBooks} of ${t.books} books`;
  if (wide)
    return (
      <div className="flex flex-wrap items-end gap-x-10 gap-y-3 rounded-xl border px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>Today's net · all paper books</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight" style={{ color: tone(t.today) }}>{signedRs(t.today)}</div>
        </div>
        <div className="flex gap-10 tabular-nums">{realized}{open}</div>
        <div className="ml-auto self-center text-xs" style={{ color: "var(--muted)" }}>{count} · after costs</div>
      </div>
    );
  // the phone: total realized big (the arrow: since yesterday), today's realized and the unrealized below, the capital
  // required, and the open positions count (tap: the table of every open lot)
  const todayNet = stat("Today's realized", t.soldToday, "Trades sold today, every paper book, one lot each, after charges and slippage");
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <button type="button" onClick={onRealized} className="block w-full text-left">
        <div className="flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
          <span>Total realized · all paper books</span>
          {onRealized && <span style={{ color: "var(--accent)" }}>Trades ›</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
          <span className="text-3xl font-semibold tabular-nums tracking-tight" style={{ color: tone(t.total) }}>{signedRs(t.total)}</span>
          <Delta v={t.soldToday} className="text-sm" />
        </div>
      </button>
      <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-sm tabular-nums" style={{ borderColor: "var(--border)" }}>
        {todayNet}
        {open}
      </div>
      <div className="mt-3 border-t pt-3 text-sm tabular-nums" style={{ borderColor: "var(--border)" }} title="What every active paper book needs, one lot a position, each at its own settings: cash for the spot books, margin for the futures books">
        <div className="text-xs" style={{ color: "var(--muted)" }}>Capital required</div>
        <div className="font-semibold">{formatRs(t.cash + t.margin)}</div>
        <div className="text-[0.6875rem]" style={{ color: "var(--muted)" }}>cash {formatRs(t.cash)} · margin {formatRs(t.margin)}</div>
      </div>
      <button type="button" onClick={onPositions} className="mt-3 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
        <span>{count}</span>
        <span style={{ color: "var(--accent)" }}>Details ›</span>
      </button>
    </div>
  );
}

// One small card a paper book (tap: the book): its today's net, or its realized net (the trades already sold since it started)
const ROW_FIELDS = {
  today: { title: "Today's net by model", hint: "Today, one lot each, after charges and slippage (positions held from before: the move since yesterday's close)",
    pick: { oops: "today_net_rs", gap: "today_net_rs", xsmr: "today_net_rs", connors: "today_net_rs", connors_cum: "today_net_rs", tom_paper: "today_net_rs" } },
  realized: { title: "Realized net by model", hint: "Trades already sold since the book started, one lot each, after charges and slippage",
    pick: { oops: "total_net_rs", gap: "total_net_rs", xsmr: "total_net_rs", connors: "fut_net_rs", connors_cum: "fut_net_rs", tom_paper: "total_net_rs" } },
};

function ModelRow({ p, field }) {
  const statuses = useModelStatuses();
  const f = ROW_FIELDS[field];
  const books = [
    ["oops", "Oops", "oops"],
    ["buy-on-gap", "Buy/Sell on gap", "gap"],
    ["xs-mean-reversion", "Cross-sectional", "xsmr"],
    ["short-term-reversion", "Short-term MR (RSI)", "connors"],
    ["cumulative-rsi", "Short-term MR (C-RSI)", "connors_cum"],
    ["turn-of-month", "Turn of the month", "tom_paper"],
  ].filter(([id]) => statusOf(statuses, id) !== "archived");
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>{f.title}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {books.map(([id, label, key]) => {
          const b = p[key] || {};
          const v = b[f.pick[key]];
          return (
            <PaperLink key={id} href={`/v2/paper/${id}`} className="rounded-lg border px-3 py-2.5 transition-colors hover:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)", background: "var(--surface)" }} title={f.hint}>
              <div className="truncate text-xs" style={{ color: "var(--muted)" }}>{label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: b.error ? "var(--negative)" : tone(v) }}>{b.error ? "error" : signedRs(v ?? 0)}</div>
              {field === "realized" && !b.error && <Delta v={b.sold_today_rs} className="text-[0.6875rem]" />}
            </PaperLink>
          );
        })}
        {field === "realized" && (() => {
          const { total, soldToday } = paperTotals(p, statuses);
          return (
            <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--accent)", background: "var(--surface)" }} title="Every paper book together: trades already sold since each started, one lot each, after charges and slippage">
              <div className="truncate text-xs font-medium" style={{ color: "var(--text)" }}>All books</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: tone(total) }}>{signedRs(total)}</div>
              <Delta v={soldToday} className="text-[0.6875rem]" />
            </div>
          );
        })()}
      </div>
    </section>
  );
}

function WidePaper({ p, today }) {
  return (
    <div className="flex flex-col gap-3">
      <PaperTotals p={p} realized={false} />
      <ModelRow p={p} field="realized" />
      <Paper p={p} today={today} />
    </div>
  );
}

