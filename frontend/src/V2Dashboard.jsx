import { useEffect, useState } from "react";
import { Card, Panel, tone } from "./V2BacktestView";
import { formatRs, Segmented } from "./V2Controls";
import { savedParams } from "./V2BacktestParams";
import { useSetting, useSettings } from "./settings";
import { STATUS, statusOf, useModelStatuses } from "./modelStatus";
import { findPaper, paperDefaults } from "./V2Paper";
import V2PaperCurve from "./V2PaperCurve";
import { InstrumentTag } from "./V2SideNav";

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

// Seconds to the dashboard's next refresh, ticking each second
function Countdown({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!at) return null;
  const left = Math.max(0, Math.round((at - now) / 1000));
  return <span title="the dashboard reloads its data then">{left}s</span>;
}

function Header({ d, nextAt }) {
  const status = d.market_open ? ["Market open", "var(--positive)"] : d.preopen ? ["Pre-open", "var(--warning)"] : ["Market closed", "var(--faint)"];
  const kite = d.kite?.connected;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {d.weekday}, {new Date(`${d.today}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          {d.now.slice(11, 16)} IST · next session {d.next_session === d.today ? "today" : d.next_session} · <Countdown at={nextAt} />
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

function PaperCard({ title, href, style, lines, error, price }) {
  return (
    <a
      href={href}
      onClick={go(href)}
      className="block rounded-lg border p-4 transition-colors hover:bg-[var(--surface-2)]"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
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
  };
}

// Turn of the month is traded by hand with real money (Live trading), not paper traded: its own card
function TomCard({ tm = {} }) {
  const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—");
  return (
      <PaperCard
        title="Turn of the month · manual"
        href="/v2/trade/turn-of-month"
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
      {shown("buy-on-gap") && (
      <PaperCard
        title="Buy/Sell on gap"
        href="/v2/paper/buy-on-gap"
        style="Intraday"
        error={g.error}
        lines={[
          ["Today", g.today_status ? `${g.today_positions} positions · ${g.today_status === "open" ? "live" : "closed"}` : "no picks yet"],
          ["Max open", g.max_open ? g.max_open : "as per model"],
          ["Today's net", rs(g.today_net_rs, g.today_margin_pct), tone(g.today_net_rs)],
          ["Realized net", rs(g.total_net_rs), tone(g.total_net_rs)],
          ["Capital required", g.capital_rs ? formatRs(g.capital_rs) : "—"],
          ["Watchlist", `${g.watchlist ?? "—"} stocks for ${g.session === today ? "today" : g.session}`],
        ]}
      />
      )}
      {shown("xs-mean-reversion") && (
      <PaperCard
        title="Cross-sectional mean reversion"
        href="/v2/paper/xs-mean-reversion"
        style="Intraday"
        error={x.error}
        lines={[
          ["Today", x.today_status ? `${x.today_positions} positions · ${x.today_status === "open" ? "live" : "closed"}` : "not recorded yet"],
          ["Max open", x.max_open ? `${x.max_open} (${x.pairs} + ${x.pairs})` : "as per model (5 + 5)"],
          ["Today's net", rs(x.today_net_rs, x.today_margin_pct), tone(x.today_net_rs)],
          ["Realized net", rs(x.total_net_rs), tone(x.total_net_rs)],
          ["Capital required", x.capital_rs ? formatRs(x.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("oops") && (
      <PaperCard
        title="Oops gap reversal"
        href="/v2/paper/oops"
        style="Intraday"
        error={op.error}
        lines={[
          ["Watching", `${op.watched ?? 0} opened below yesterday's low`],
          ["Today", op.today_status ? `${op.today_positions} bought · ${op.today_status === "open" ? "live" : "closed"}` : "no buys yet"],
          ["Today's net", rs(op.today_net_rs, op.today_value_pct), tone(op.today_net_rs)],
          ["Realized net", rs(op.total_net_rs), tone(op.total_net_rs)],
          ["Capital required", op.capital_rs ? formatRs(op.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("short-term-reversion") && (
      <PaperCard
        title="Short-term mean reversion"
        href="/v2/paper/short-term-reversion"
        style="Positional"
        price={c.price}
        error={c.error}
        lines={[
          ["Open", `${c.open ?? 0} / ${c.max_open ?? 3}${c.open_symbols?.length ? ` · ${c.open_symbols.join(", ")}` : ""}`],
          ["Closed trades", c.closed ?? 0],
          ["Today's net", rs(c.today_net_rs), tone(c.today_net_rs)],
          ["Open now", rs(c.open_fut_net_rs), tone(c.open_fut_net_rs)],
          ["Realized net", rs(c.fut_net_rs), tone(c.fut_net_rs)],
          ["Capital required", c.capital_rs ? formatRs(c.capital_rs) : "—"],
        ]}
      />
      )}
      {shown("cumulative-rsi") && (
      <PaperCard
        title="Cumulative RSI(2)"
        href="/v2/paper/cumulative-rsi"
        style="Positional"
        price={cc.price}
        error={cc.error}
        lines={[
          ["Open", `${cc.open ?? 0} / ${cc.max_open ?? 3}${cc.open_symbols?.length ? ` · ${cc.open_symbols.join(", ")}` : ""}`],
          ["Closed trades", cc.closed ?? 0],
          ["Today's net", rs(cc.today_net_rs), tone(cc.today_net_rs)],
          ["Open now", rs(cc.open_fut_net_rs), tone(cc.open_fut_net_rs)],
          ["Realized net", rs(cc.fut_net_rs), tone(cc.fut_net_rs)],
          ["Capital required", cc.capital_rs ? formatRs(cc.capital_rs) : "—"],
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
                    title="Penfold: must be 0. The chance of falling below half the capital within 10 years (from the backtest's own months, resampled), at full size; otherwise the size that brings it to 0"
                  >
                    {m.ruin_pct == null ? "—" : m.ruin_pct === 0 ? "0% ✓" : (
                      <>
                        {m.ruin_pct}%
                        <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                          {m.ruin_safe_size ? `0 at ${Math.round(100 * m.ruin_safe_size)}% size` : "not 0 at 10%"}
                        </span>
                      </>
                    )}
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
function dashboardQuery(values) {
  const max = (id) => savedParams(values, `paper-${id}`, paperDefaults(findPaper(id))).maxOpen || paperDefaults(findPaper(id)).maxOpen;
  return `gap_max_open=${max("buy-on-gap")}&xsmr_max_open=${max("xs-mean-reversion")}`;
}

// The dashboard's data (refreshed each minute in market hours, every 5 minutes otherwise)
function useDashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [nextAt, setNextAt] = useState(null);
  const query = dashboardQuery(useSettings().values);
  useEffect(() => {
    let timer;
    const schedule = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(load, ms);
      setNextAt(Date.now() + ms);
    };
    const load = () =>
      fetch(`/api/v2/dashboard?${query}`)
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
        });
    load();
    const onKite = () => load();
    window.addEventListener("kite-status-changed", onKite);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("kite-status-changed", onKite);
    };
  }, [query]);
  return { d, error, nextAt };
}

// Across every paper book (archived ones left out): what's open, and the net (SR and CR each trade on its own prices (spot or futures))
// Across every paper book (archived ones left out): books and positions open now, today's and total net
function paperTotals(p, statuses) {
  const on = (id) => statusOf(statuses, id) !== "archived";
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {};
  const open = openNow(p);
  const ids = Object.keys(open).filter(on);
  const live = (b) => (b.today_status === "open" ? b.today_positions || 0 : 0);
  const positions =
    (on("buy-on-gap") ? live(g) : 0) + (on("xs-mean-reversion") ? live(x) : 0) + (on("oops") ? live(op) : 0) +
    (on("short-term-reversion") ? c.open || 0 : 0) + (on("cumulative-rsi") ? cc.open || 0 : 0);
  const sum = (pairs) => pairs.filter(([id, v]) => on(id) && v != null).reduce((a, [, v]) => a + v, 0);
  const today = sum([["buy-on-gap", g.today_net_rs], ["xs-mean-reversion", x.today_net_rs], ["oops", op.today_net_rs],
    ["short-term-reversion", c.today_net_rs], ["cumulative-rsi", cc.today_net_rs]]);
  const total = sum([["buy-on-gap", g.total_net_rs], ["xs-mean-reversion", x.total_net_rs], ["oops", op.total_net_rs],
    ["short-term-reversion", c.fut_net_rs], ["cumulative-rsi", cc.fut_net_rs]]);
  const openRs = sum([["buy-on-gap", g.open_net_rs], ["xs-mean-reversion", x.open_net_rs], ["oops", op.open_net_rs],
    ["short-term-reversion", c.open_fut_net_rs], ["cumulative-rsi", cc.open_fut_net_rs]]);
  return { openBooks: ids.filter((id) => open[id]).length, books: ids.length, positions, today, total, openRs };
}

function PaperTotals({ p }) {
  const { openBooks, books, positions, today, total, openRs } = paperTotals(p, useModelStatuses());
  const signed = (v) => `${v > 0 ? "+" : ""}${formatRs(v)}`;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Card label="Books with open trades" value={`${openBooks} / ${books}`} hint="Paper books holding something now" />
      <Card label="Open positions" value={positions} hint="Intraday books: today's live positions; SR and CR: positions held" />
      <Card label="Today's net" value={signed(today)} color={tone(today)} hint="Every paper book today, one lot each: the intraday books' trades, and SR and CR each trade on its own prices (spot or futures) (positions held from before: the move since yesterday's close)" />
      <Card label="Open now" value={signed(openRs)} color={tone(openRs)} hint="Positions not sold yet, marked at the current price, one lot each (SR and CR each trade on its own prices (spot or futures), since their buy): not locked in" />
      <Card label="Realized net" value={signed(total)} color={tone(total)} hint="Trades already sold, every paper book since it started, one lot each, after costs; SR and CR each trade on its own prices (spot or futures)" />
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
      <Panel title="Open positions" right="price since bought, one lot each · on the future each book trades (older gap and XR rows: the share)">
        <OpenPositions query={curveQuery} />
      </Panel>
      <Panel title="Net P&L by day" right="cumulative, one lot a position · SR and CR each trade on its own prices (spot or futures), open positions marked now">
        <V2PaperCurve query={curveQuery} />
      </Panel>
      <Paper p={d.paper} today={d.today} openOnly={filter === "open"} />
      <Panel title="Paper vs backtest" right="closed paper trades against the backtest on the same days, same settings">
        <PaperCheck query={curveQuery} />
      </Panel>
    </div>
  );
}

// Every paper book's open positions, each a small chart of its price since it was bought (refreshed each minute)
function OpenPositions({ query }) {
  const [data, setData] = useState(null);
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
  }, [query]);
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
    <a href={p.books[0].href} onClick={go(p.books[0].href)} className="flex flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
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
    </a>
  );
}

// Each paper book against its backtest over the same days: the sign a backtest was too good is a paper
// result that stays well below it over enough trades (v2check.py).
function PaperCheck({ query }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(`/api/v2/paper/check?${query}`)
      .then((r) => r.json())
      .then((p) => alive && (p.status === "success" ? (setData(p), setError("")) : setError(p.message || "Could not load the check")))
      .catch(() => alive && setError("Could not reach the API"));
    return () => {
      alive = false;
    };
  }, [query]);
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
                <a href={r.link} onClick={go(r.link)} className="font-medium hover:underline">
                  {r.label}
                </a>
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
  { id: "schedule", label: "Schedules" },
];

const PHONE = "(max-width: 767px)";

function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(PHONE);
    if (!m) return;
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

export default function V2Dashboard() {
  const phone = usePhone();
  const { d, error, nextAt } = useDashboard();
  const [saved, setTab] = useSetting("dashboard.tab", "paper");
  const tab = DASH_TABS.some((t) => t.id === saved) ? saved : "paper";
  if (error && !d) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  if (phone) return <PhoneDashboard d={d} nextAt={nextAt} tab={tab} setTab={setTab} />;
  return (
    <div className="flex flex-col gap-4">
      <Header d={d} nextAt={nextAt} />
      <div className="flex flex-wrap gap-1 border-b" style={{ borderColor: "var(--border)" }} role="tablist" aria-label="Dashboard sections">
        {DASH_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="-mb-px border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap"
            style={tab === t.id ? { borderColor: "var(--accent)", color: "var(--text)" } : { borderColor: "transparent", color: "var(--muted)" }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "paper" && <Paper p={d.paper} today={d.today} />}
        {tab === "live" && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <TomCard tm={d.paper.tom} />
          </div>
        )}
        {tab === "schedule" && (
          <div className="flex flex-col gap-4">
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
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Data</h2>
              <Freshness f={d.freshness} expected={d.expected_data} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Phone: a dashboard of its own (below 768 px). A status strip, then one tab at a time chosen from a
// bar fixed at the bottom of the screen (the same remembered tab as the wide dashboard).

const signedRs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);

function PhoneStatus({ d, nextAt }) {
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

function PhoneRow({ title, href, sub, value, valueLabel, total, error }) {
  return (
    <a href={href} onClick={go(href)} className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0 active:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)" }}>
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

function PhonePaper({ p }) {
  const statuses = useModelStatuses();
  const t = paperTotals(p, statuses);
  const shown = (id) => statusOf(statuses, id) !== "archived";
  const g = p.gap || {}, x = p.xsmr || {}, c = p.connors || {}, cc = p.connors_cum || {}, op = p.oops || {};
  const intraday = (b, word, none) => (b.today_status ? `${b.today_positions} ${word} · ${b.today_status === "open" ? "live" : "closed"}` : none);
  const held = (b) => `${b.open ?? 0} / ${b.max_open ?? 3} open${b.open_symbols?.length ? ` · ${b.open_symbols.join(", ")}` : ""}`;
  const rows = [
    ["buy-on-gap", { title: "Buy/Sell on gap", sub: intraday(g, "positions", "no picks yet"), value: g.today_net_rs, valueLabel: "today", total: g.total_net_rs, error: g.error }],
    ["xs-mean-reversion", { title: "Cross-sectional mean reversion", sub: intraday(x, "positions", "not recorded yet"), value: x.today_net_rs, valueLabel: "today", total: x.total_net_rs, error: x.error }],
    ["oops", { title: "Oops gap reversal", sub: intraday(op, "bought", `${op.watched ?? 0} watched, no buys yet`), value: op.today_net_rs, valueLabel: "today", total: op.total_net_rs, error: op.error }],
    ["short-term-reversion", { title: "Short-term mean reversion", sub: held(c), value: c.today_net_rs, valueLabel: "today", total: c.fut_net_rs, error: c.error }],
    ["cumulative-rsi", { title: "Cumulative RSI(2)", sub: held(cc), value: cc.today_net_rs, valueLabel: "today", total: cc.fut_net_rs, error: cc.error }],
  ].filter(([id]) => shown(id));
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="text-xs" style={{ color: "var(--muted)" }}>Today's net · all paper books</div>
        <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight" style={{ color: tone(t.today) }}>{signedRs(t.today)}</div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-sm tabular-nums" style={{ borderColor: "var(--border)" }}>
          <div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>Realized net</div>
            <div className="font-semibold" style={{ color: tone(t.total) }}>{signedRs(t.total)}</div>
          </div>
          <div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>Open now</div>
            <div className="font-semibold" style={{ color: tone(t.openRs) }}>{signedRs(t.openRs)}</div>
          </div>
        </div>
        <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>{t.positions} positions open · {t.openBooks} of {t.books} books</div>
      </div>
      <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        {rows.map(([id, r]) => <PhoneRow key={id} href={`/v2/paper/${id}`} {...r} />)}
      </div>
      <p className="text-[0.6875rem]" style={{ color: "var(--faint)" }}>One lot a position. SR and CR each trade on its own prices (spot or futures). Tap a book to open it.</p>
    </div>
  );
}

function PhoneSchedule({ d }) {
  const next = d.schedule.find((s) => s.state === "running") || d.schedule.find((s) => s.state === "pending");
  const f = d.freshness || {};
  const data = [
    ["Backtest · daily", f.backtest_daily], ["Backtest · index daily", f.backtest_index_daily], ["Backtest · 15 min", f.backtest_15m],
    ["Live futures · daily", f.live_daily], ["Live futures · 15 min", f.live_15m],
  ];
  const box = { borderColor: "var(--border)", background: "var(--surface)" };
  return (
    <div className="flex flex-col gap-4">
      {next && (
        <div className="rounded-xl border p-4" style={box}>
          <div className="text-xs" style={{ color: "var(--muted)" }}>{next.state === "running" ? "Due now" : "Next up"}</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-2xl font-semibold tabular-nums">{next.at}</span>
            <span className="text-sm font-medium">{next.label}</span>
          </div>
        </div>
      )}
      <div className="rounded-xl border px-4 py-1" style={box}>
        <Schedule steps={d.schedule} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {d.markets.map((m) => (
          <div key={m.symbol} className="rounded-xl border p-3" style={box}>
            <div className="truncate text-xs" style={{ color: "var(--muted)" }}>{m.symbol}</div>
            <div className="text-base font-semibold tabular-nums">{num(m.last)}</div>
            <div className="text-xs font-medium tabular-nums" style={{ color: tone(m.change_pct) }}>{pct(m.change_pct)}</div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border" style={box}>
        <div className="px-4 pt-3 text-xs font-semibold">Data</div>
        {data.map(([label, day]) => {
          const stale = !day || day < d.expected_data;
          return (
            <div key={label} className="flex items-center justify-between border-t px-4 py-2 text-sm first:border-t-0" style={{ borderColor: "var(--border)" }}>
              <span>{label}</span>
              <span className="tabular-nums text-xs font-medium" style={{ color: stale ? "var(--warning)" : "var(--positive)" }}>{day || "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PHONE_ICONS = {
  paper: "M4 19V9m6 10V5m6 14v-7m4 7H2",
  live: "M3 12h4l3-8 4 16 3-8h4",
  schedule: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
};

function PhoneDashboard({ d, nextAt, tab, setTab }) {
  return (
    <div className="flex flex-col gap-4 pb-24">
      <PhoneStatus d={d} nextAt={nextAt} />
      <div role="tabpanel">
        {tab === "paper" && <PhonePaper p={d.paper} />}
        {tab === "live" && <TomCard tm={d.paper.tom} />}
        {tab === "schedule" && <PhoneSchedule d={d} />}
      </div>
      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t"
        style={{ borderColor: "var(--border)", background: "var(--surface)", paddingBottom: "env(safe-area-inset-bottom)" }}
        role="tablist"
        aria-label="Dashboard sections"
      >
        {DASH_TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={active} onClick={() => setTab(t.id)}
              className="flex flex-col items-center gap-1 py-2.5 text-[0.6875rem] font-medium"
              style={{ color: active ? "var(--accent)" : "var(--muted)" }}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={PHONE_ICONS[t.id]} />
              </svg>
              {t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
