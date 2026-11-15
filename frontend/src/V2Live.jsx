import { useCallback, useEffect, useState } from "react";
import { Card, Panel, tone } from "./V2BacktestView";

// v2 Live: the real Kite account, read-only. Refreshes every 10 s while the market is open (every
// minute outside); the backend caches Kite for 5 s, so several tabs don't add calls.

const rs = (v, d = 0) =>
  v == null ? "—" : `${v < 0 ? "−" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signedRs = (v, d = 0) => (v == null ? "—" : `${v > 0 ? "+" : ""}${rs(v, d)}`);
const price = (v) => (v == null || v === 0 ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

function marketOpen() {
  // IST from the browser clock: weekdays 09:00-15:30 (holidays aren't known here; polling is cheap)
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  const m = ist.getHours() * 60 + ist.getMinutes();
  return ist.getDay() > 0 && ist.getDay() < 6 && m >= 540 && m <= 930;
}

const STATUS = {
  COMPLETE: "var(--positive)",
  REJECTED: "var(--negative)",
  CANCELLED: "var(--faint)",
  OPEN: "var(--warning)",
  "TRIGGER PENDING": "var(--warning)",
};

function Badge({ color, children, title }) {
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.04em]"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
      title={title}
    >
      {children}
    </span>
  );
}

const Side = ({ side }) => <Badge color={side === "BUY" ? "var(--positive)" : "var(--negative)"}>{side}</Badge>;

function Table({ columns, rows, empty, minWidth = 720, rowStyle }) {
  if (!rows?.length) {
    return (
      <p className="py-6 text-center text-sm" style={{ color: "var(--faint)" }}>
        {empty}
      </p>
    );
  }
  return (
    <div className="-m-4 overflow-x-auto">
      <table className="w-full text-sm tabular-nums" style={{ minWidth }}>
        <thead className="text-xs" style={{ color: "var(--faint)" }}>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={`px-3 py-2 font-medium first:pl-4 last:pr-4 ${c.right ? "text-right" : "text-left"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key ?? i} className="border-t" style={{ borderColor: "var(--border)", ...(rowStyle?.(r) || {}) }}>
              {columns.map((c) => (
                <td key={c.label} className={`px-3 py-2 first:pl-4 last:pr-4 ${c.right ? "text-right" : ""}`} style={c.color ? { color: c.color(r) } : undefined}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Errored({ message }) {
  return (
    <p className="rounded-md px-3 py-2 text-xs" style={{ background: "color-mix(in srgb, var(--negative) 10%, transparent)", color: "var(--negative)" }}>
      {message}
    </p>
  );
}

function Funds({ m, positionsPnl, holdingsDay }) {
  const e = m?.equity;
  const today = (positionsPnl ?? 0) + (holdingsDay ?? 0);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <Card label="Available margin" value={rs(e?.net)} hint="Equity segment: cash + collateral − margin used" />
      <Card label="Margin used" value={rs(e?.used)} hint={e ? `SPAN ${rs(e.span)} · exposure ${rs(e.exposure)} · option premium ${rs(e.option_premium)}` : undefined} />
      <Card label="Cash" value={rs(e?.cash)} color={e?.cash < 0 ? "var(--negative)" : undefined} hint={e ? `Opening balance ${rs(e.opening)} · pay-in today ${rs(e.intraday_payin)}` : undefined} />
      <Card label="Collateral" value={rs(e?.collateral)} hint="Pledged holdings, after haircut" />
      <Card label="Positions P&L" value={signedRs(positionsPnl)} color={tone(positionsPnl)} hint="Net positions: realised + unrealised" />
      <Card label="Today's P&L" value={signedRs(today)} color={tone(today)} hint="Positions' P&L + holdings' change since yesterday's close" />
    </div>
  );
}

function Positions({ rows }) {
  const open = rows.filter((p) => p.qty !== 0);
  return (
    <Table
      empty="No positions today"
      rows={[...open, ...rows.filter((p) => p.qty === 0)].map((p) => ({ ...p, key: `${p.exchange}:${p.symbol}:${p.product}` }))}
      rowStyle={(p) => (p.qty === 0 ? { color: "var(--muted)" } : undefined)}
      columns={[
        { label: "Instrument", render: (p) => (<><span className="font-medium">{p.symbol}</span><span className="ml-1.5 text-xs" style={{ color: "var(--faint)" }}>{p.exchange}</span></>) },
        { label: "Product", render: (p) => <span className="text-xs">{p.product}</span> },
        { label: "Qty", right: true, render: (p) => p.qty || "closed", color: (p) => (p.qty > 0 ? "var(--positive)" : p.qty < 0 ? "var(--negative)" : undefined) },
        { label: "Avg", right: true, render: (p) => price(p.avg) },
        { label: "LTP", right: true, render: (p) => price(p.ltp) },
        { label: "Change", right: true, render: (p) => (p.close ? pct(100 * (p.ltp / p.close - 1)) : "—"), color: (p) => (p.close ? tone(p.ltp - p.close) : undefined) },
        { label: "Today (M2M)", right: true, render: (p) => signedRs(p.m2m, 2), color: (p) => tone(p.m2m) },
        { label: "P&L", right: true, render: (p) => <span className="font-medium">{signedRs(p.pnl, 2)}</span>, color: (p) => tone(p.pnl) },
      ]}
    />
  );
}

function Orders({ rows }) {
  return (
    <Table
      empty="No orders today"
      minWidth={860}
      rows={rows.map((o) => ({ ...o, key: o.id }))}
      columns={[
        { label: "Time", render: (o) => <span style={{ color: "var(--muted)" }}>{o.time}</span> },
        { label: "Side", render: (o) => <Side side={o.side} /> },
        { label: "Instrument", render: (o) => (<><span className="font-medium">{o.symbol}</span><span className="ml-1.5 text-xs" style={{ color: "var(--faint)" }}>{o.exchange}</span></>) },
        { label: "Type", render: (o) => <span className="text-xs">{o.type} · {o.product}</span> },
        { label: "Qty", right: true, render: (o) => `${o.filled ?? 0} / ${o.qty}` },
        { label: "Price", right: true, render: (o) => (o.avg ? price(o.avg) : o.type === "MARKET" ? "Market" : price(o.price)) },
        { label: "Trigger", right: true, render: (o) => price(o.trigger) },
        { label: "Status", render: (o) => <Badge color={STATUS[o.status] || "var(--muted)"} title={o.message || undefined}>{o.status}</Badge> },
        { label: "Tag", render: (o) => <span className="text-xs" style={{ color: "var(--faint)" }}>{o.tag || o.message || ""}</span> },
      ]}
    />
  );
}

function Trades({ rows }) {
  return (
    <Table
      empty="No fills today"
      minWidth={560}
      rows={rows.map((t) => ({ ...t, key: t.id }))}
      columns={[
        { label: "Time", render: (t) => <span style={{ color: "var(--muted)" }}>{t.time}</span> },
        { label: "Side", render: (t) => <Side side={t.side} /> },
        { label: "Instrument", render: (t) => <span className="font-medium">{t.symbol}</span> },
        { label: "Product", render: (t) => <span className="text-xs">{t.product}</span> },
        { label: "Qty", right: true, render: (t) => t.qty },
        { label: "Price", right: true, render: (t) => price(t.price) },
        { label: "Value", right: true, render: (t) => rs(t.qty * t.price) },
      ]}
    />
  );
}

function Holdings({ rows }) {
  const invested = rows.reduce((a, h) => a + h.invested, 0);
  const value = rows.reduce((a, h) => a + h.value, 0);
  const day = rows.reduce((a, h) => a + (h.day_pnl || 0), 0);
  return (
    <>
      {rows.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card label="Invested" value={rs(invested)} />
          <Card label="Current value" value={rs(value)} />
          <Card label="Total P&L" value={`${signedRs(value - invested)} · ${pct(invested ? (100 * (value - invested)) / invested : null)}`} color={tone(value - invested)} />
          <Card label="Today" value={`${signedRs(day)} · ${pct(value - day ? (100 * day) / (value - day) : null)}`} color={tone(day)} />
        </div>
      )}
      <Table
        empty="No holdings"
        minWidth={820}
        rows={rows.map((h) => ({ ...h, key: `${h.exchange}:${h.symbol}` }))}
        columns={[
          { label: "Instrument", render: (h) => (<><span className="font-medium">{h.symbol}</span><span className="ml-1.5 text-xs" style={{ color: "var(--faint)" }}>{h.exchange}</span></>) },
          { label: "Qty", right: true, render: (h) => [h.qty, h.t1 ? `T1 ${h.t1}` : null, h.pledged ? (h.pledged === h.qty ? "pledged" : `${h.pledged} pledged`) : null].filter(Boolean).join(" · ") },
          { label: "Avg", right: true, render: (h) => price(h.avg) },
          { label: "LTP", right: true, render: (h) => price(h.ltp) },
          { label: "Invested", right: true, render: (h) => rs(h.invested) },
          { label: "Value", right: true, render: (h) => rs(h.value) },
          { label: "P&L", right: true, render: (h) => <span className="font-medium">{signedRs(h.pnl)}</span>, color: (h) => tone(h.pnl) },
          { label: "P&L %", right: true, render: (h) => pct(h.invested ? (100 * h.pnl) / h.invested : null), color: (h) => tone(h.pnl) },
          { label: "Day", right: true, render: (h) => pct(h.day_change_pct), color: (h) => tone(h.day_change_pct) },
        ]}
      />
    </>
  );
}

const TABS = [
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Orders" },
  { id: "trades", label: "Trades" },
  { id: "holdings", label: "Holdings" },
];

export default function V2Live() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("positions");

  const load = useCallback((refresh = false) => {
    setLoading(true);
    return fetch(`/api/v2/live${refresh ? "?refresh=true" : ""}`)
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success") setError(p.message || p.detail || "Could not load the account");
        else {
          setError("");
          setD(p);
        }
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let timer;
    const tick = () => load().finally(() => (timer = setTimeout(tick, marketOpen() ? 10000 : 60000)));
    tick();
    const onKite = () => load(true);
    window.addEventListener("kite-status-changed", onKite);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("kite-status-changed", onKite);
    };
  }, [load]);

  if (error && !d) return <Errored message={error} />;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;

  const connected = d.kite?.connected;
  const net = d.positions?.net || [];
  const positionsPnl = d.positions ? net.reduce((a, p) => a + (p.pnl || 0), 0) : null;
  const holdingsDay = d.holdings ? d.holdings.reduce((a, h) => a + (h.day_pnl || 0), 0) : null;
  const counts = {
    positions: net.filter((p) => p.qty !== 0).length,
    orders: (d.orders || []).filter((o) => o.status === "OPEN" || o.status === "TRIGGER PENDING").length,
    trades: (d.trades || []).length,
    holdings: (d.holdings || []).length,
  };
  const live = marketOpen();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Live account</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            {connected ? `Kite ${d.kite.user_id}${d.kite.user_name ? ` · ${d.kite.user_name}` : ""} · ` : ""}
            read-only: orders are placed in Kite, not here
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: "var(--muted)" }}>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: live ? "var(--positive)" : "var(--faint)" }} aria-hidden="true" />
            {live ? "Updating every 10 s" : "Market closed · every minute"} · {d.fetched_at}
          </span>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading}
            className="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
            style={{ borderColor: "var(--border)", color: "var(--text)" }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <Errored message={error} />}

      {!connected ? (
        <section className="flex flex-col items-center gap-3 rounded-lg border px-6 py-12 text-center" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <p className="text-base font-semibold">Kite isn't connected</p>
          <p className="max-w-md text-sm" style={{ color: "var(--muted)" }}>
            Log in to Kite to see your funds, positions, orders and holdings here. The session lasts until about 6 AM tomorrow.
          </p>
          <a href="/api/kite/login" target="_blank" rel="noreferrer" className="rounded-md px-4 py-2 text-sm font-medium" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
            Kite Login
          </a>
        </section>
      ) : (
        <>
          {d.errors?.margins ? <Errored message={`Funds: ${d.errors.margins}`} /> : <Funds m={d.margins} positionsPnl={positionsPnl} holdingsDay={holdingsDay} />}

          <section className="rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div className="flex gap-1 overflow-x-auto border-b px-2" style={{ borderColor: "var(--border)" }} role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className="-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap"
                  style={tab === t.id ? { borderColor: "var(--accent)", color: "var(--text)" } : { borderColor: "transparent", color: "var(--muted)" }}
                >
                  {t.label}
                  {counts[t.id] > 0 && (
                    <span className="rounded-full px-1.5 text-[0.6875rem] tabular-nums" style={{ background: "var(--surface-2)", color: "var(--muted)" }}>
                      {counts[t.id]}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="p-4">
              {d.errors?.[tab] ? (
                <Errored message={d.errors[tab]} />
              ) : tab === "positions" ? (
                <Positions rows={net} />
              ) : tab === "orders" ? (
                <Orders rows={d.orders || []} />
              ) : tab === "trades" ? (
                <Trades rows={d.trades || []} />
              ) : (
                <Holdings rows={d.holdings || []} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
