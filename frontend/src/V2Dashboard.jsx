import { useEffect, useState } from "react";
import { Card, Panel, tone } from "./V2BacktestView";
import { formatRs } from "./V2Controls";
import { savedParams } from "./V2BacktestParams";
import { useSettings } from "./settings";
import { findPaper, paperDefaults } from "./V2Paper";

// v2 Dashboard: today at a glance. Refreshes every minute while the market is open (every 5 outside).

const STATE = {
  done: { label: "Done", color: "var(--positive)" },
  pending: { label: "Later", color: "var(--faint)" },
  running: { label: "Due now", color: "var(--warning)" },
  late: { label: "Missed", color: "var(--negative)" },
  off: { label: "No session", color: "var(--faint)" },
};

const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const num = (v) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const go = (href) => (e) => {
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

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

function Header({ d }) {
  const status = d.market_open ? ["Market open", "var(--positive)"] : d.preopen ? ["Pre-open", "var(--warning)"] : ["Market closed", "var(--faint)"];
  const kite = d.kite?.connected;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {d.weekday}, {new Date(`${d.today}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          {d.now.slice(11, 16)} IST · next session {d.next_session === d.today ? "today" : d.next_session}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}

function Schedule({ steps }) {
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

function Markets({ rows }) {
  return (
    <div className="flex flex-col">
      {rows.map((m) => (
        <div key={m.symbol} className="flex items-center justify-between border-t py-2 text-sm first:border-t-0" style={{ borderColor: "var(--border)" }}>
          <span>{m.symbol}</span>
          <span className="flex items-baseline gap-3 tabular-nums">
            <span className="font-medium">{num(m.last)}</span>
            <span className="w-16 text-right text-xs font-medium" style={{ color: tone(m.change_pct) }}>
              {pct(m.change_pct)}
            </span>
          </span>
        </div>
      ))}
      <p className="pt-2 text-xs" style={{ color: "var(--faint)" }}>
        {rows[0]?.live ? "Live from Kite · change vs the previous close" : rows[0]?.as_of ? `Closes to ${rows[0].as_of} (Kite not connected)` : ""}
      </p>
    </div>
  );
}

function PaperCard({ title, href, style, lines, error }) {
  return (
    <a
      href={href}
      onClick={go(href)}
      className="block rounded-lg border p-4 transition-colors hover:bg-[var(--surface-2)]"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-[0.625rem] font-medium uppercase tracking-[0.08em]" style={{ color: style === "Intraday" ? "var(--accent)" : "var(--muted)" }}>
          {style}
        </span>
      </div>
      {error ? (
        <p className="mt-3 text-xs" style={{ color: "var(--negative)" }}>
          {error}
        </p>
      ) : (
        <dl className="mt-3 flex flex-col gap-1.5 text-sm">
          {lines.map(([k, v, color]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt style={{ color: "var(--muted)" }}>{k}</dt>
              <dd className="tabular-nums font-medium" style={{ color: color || "var(--text)" }}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </a>
  );
}

function Paper({ p, today }) {
  // one F&O lot a position: rupees, with % of the day's margin where there is one
  const rs = (v, m) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}${m == null ? "" : ` · ${pct(m, 2)}`}`);
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {};
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <PaperCard
        title="Buy/Sell on gap"
        href="/v2/paper/buy-on-gap"
        style="Intraday"
        error={g.error}
        lines={[
          ["Today", g.today_status ? `${g.today_positions} positions · ${g.today_status === "open" ? "live" : "closed"}` : "no picks yet"],
          ["Max open", g.max_open ? g.max_open : "as per model"],
          ["Today's net", rs(g.today_net_rs, g.today_margin_pct), tone(g.today_net_rs)],
          ["Total net", rs(g.total_net_rs), tone(g.total_net_rs)],
          ["Capital required", g.capital_rs ? formatRs(g.capital_rs) : "—"],
          ["Watchlist", `${g.watchlist ?? "—"} stocks for ${g.session === today ? "today" : g.session}`],
        ]}
      />
      <PaperCard
        title="Cross-sectional mean reversion"
        href="/v2/paper/xs-mean-reversion"
        style="Intraday"
        error={x.error}
        lines={[
          ["Today", x.today_status ? `${x.today_positions} positions · ${x.today_status === "open" ? "live" : "closed"}` : "not recorded yet"],
          ["Max open", x.max_open ? `${x.max_open} (${x.pairs} + ${x.pairs})` : "as per model (5 + 5)"],
          ["Today's net", rs(x.today_net_rs, x.today_margin_pct), tone(x.today_net_rs)],
          ["Total net", rs(x.total_net_rs), tone(x.total_net_rs)],
          ["Capital required", x.capital_rs ? formatRs(x.capital_rs) : "—"],
        ]}
      />
      <PaperCard
        title="Oops gap reversal"
        href="/v2/paper/oops"
        style="Intraday"
        error={op.error}
        lines={[
          ["Watching", `${op.watched ?? 0} opened below yesterday's low`],
          ["Today", op.today_status ? `${op.today_positions} bought · ${op.today_status === "open" ? "live" : "closed"}` : "no buys yet"],
          ["Today's net", rs(op.today_net_rs, op.today_value_pct), tone(op.today_net_rs)],
          ["Total net", rs(op.total_net_rs), tone(op.total_net_rs)],
          ["Capital required", op.capital_rs ? formatRs(op.capital_rs) : "—"],
        ]}
      />
      <PaperCard
        title="Short-term mean reversion"
        href="/v2/paper/short-term-reversion"
        style="Positional"
        error={c.error}
        lines={[
          ["Open", `${c.open ?? 0} / ${c.max_open ?? 3}${c.open_symbols?.length ? ` · ${c.open_symbols.join(", ")}` : ""}`],
          ["Closed trades", c.closed ?? 0],
          ["Open now", rs(c.open_net_rs), tone(c.open_net_rs)],
          ["Net (stock prices)", rs(c.net_rs), tone(c.net_rs)],
          ["Net (futures prices)", rs(c.fut_net_rs), tone(c.fut_net_rs)],
          ["Capital required", c.capital_rs ? formatRs(c.capital_rs) : "—"],
        ]}
      />
      <PaperCard
        title="Cumulative RSI(2) · exit on strength"
        href="/v2/paper/cumulative-rsi"
        style="Positional"
        error={cc.error}
        lines={[
          ["Open", `${cc.open ?? 0} / ${cc.max_open ?? 3}${cc.open_symbols?.length ? ` · ${cc.open_symbols.join(", ")}` : ""}`],
          ["Closed trades", cc.closed ?? 0],
          ["Open now", rs(cc.open_net_rs), tone(cc.open_net_rs)],
          ["Net (stock prices)", rs(cc.net_rs), tone(cc.net_rs)],
          ["Net (futures prices)", rs(cc.fut_net_rs), tone(cc.fut_net_rs)],
          ["Capital required", cc.capital_rs ? formatRs(cc.capital_rs) : "—"],
        ]}
      />
    </div>
  );
}

function Models() {
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
      <table className="w-full min-w-[820px] text-sm tabular-nums">
        <thead className="text-left text-xs" style={{ color: "var(--faint)" }}>
          <tr>
            {["Model", "Settings", "Net / yr", "Sharpe", "Max drawdown", "Green years", `${data.year} so far`].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.models.map((m) => (
            <tr key={`${m.id}-${m.label}`} className="border-t" style={{ borderColor: "var(--border)" }}>
              <td className="px-3 py-2">
                <a href={`/v2/backtesting/${m.id}`} onClick={go(`/v2/backtesting/${m.id}`)} className="font-medium hover:underline">
                  {m.label}
                </a>
                <span className="ml-2 text-[0.625rem] font-medium uppercase tracking-[0.08em]" style={{ color: m.style === "Intraday" ? "var(--accent)" : "var(--muted)" }}>
                  {m.style}
                </span>
              </td>
              <td className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
                {m.settings}
              </td>
              {m.error ? (
                <td colSpan={5} className="px-3 py-2 text-xs" style={{ color: "var(--negative)" }}>
                  {m.error}
                </td>
              ) : (
                <>
                  <td className="px-3 py-2 font-medium" style={{ color: tone(m.net_year_pct) }}>
                    {pct(m.net_year_pct, 1)}
                  </td>
                  <td className="px-3 py-2">{m.sharpe ?? "—"}</td>
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
function dashboardQuery(values) {
  const max = (id) => savedParams(values, `paper-${id}`, paperDefaults(findPaper(id))).maxOpen;
  return `gap_max_open=${max("buy-on-gap")}&xsmr_max_open=${max("xs-mean-reversion")}`;
}

export default function V2Dashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const query = dashboardQuery(useSettings().values);
  useEffect(() => {
    let timer;
    const load = () =>
      fetch(`/api/v2/dashboard?${query}`)
        .then((r) => r.json())
        .then((p) => {
          if (p.status !== "success") setError(p.message || p.detail || "Could not load the dashboard");
          else {
            setError("");
            setD(p);
          }
          timer = setTimeout(load, p.market_open || p.preopen ? 60000 : 300000);
        })
        .catch(() => {
          setError("Could not reach the API");
          timer = setTimeout(load, 60000);
        });
    load();
    const onKite = () => load();
    window.addEventListener("kite-status-changed", onKite);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("kite-status-changed", onKite);
    };
  }, [query]);

  if (error && !d) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  return (
    <div className="flex flex-col gap-5">
      <Header d={d} />
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Paper trading</h2>
        <Paper p={d.paper} today={d.today} />
      </section>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel title="Today's schedule" right="the production scheduler, automatically">
            <Schedule steps={d.schedule} />
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel title="Markets" right="F&O indices">
            <Markets rows={d.markets} />
          </Panel>
        </div>
      </div>
      <Panel title="Strategies" right="every backtest at its default settings">
        <Models />
      </Panel>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Data</h2>
        <Freshness f={d.freshness} expected={d.expected_data} />
      </section>
    </div>
  );
}
