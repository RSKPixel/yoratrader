import { useCallback, useEffect, useMemo, useState } from "react";
import { formatR, formatRs, KBDT_EXITS, KBDT_STOP_MODES, KBDT_STOP_PCTS, rClass, Segmented, SLIPPAGE, Stat } from "./backtestShared";

const PERIODS = [
  [0, "All available"],
  [5, "Last 5 days"],
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(key) {
  return `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function SignalsTable({ parts, slippage, days }) {
  const [data, setData] = useState(null);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const query = `exit=${parts.exit}&stop_mode=${parts.mode}&stop_pct=${parts.pct}&slippage=${slippage}&days=${days}`;

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch(`/api/backtest/kbdt/signals?${query}`)
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || "Could not load signals");
          return;
        }
        setData(payload);
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const hold = Number(parts.exit[0]);
  const fresh = data ? Object.values(data.freshness) : [];
  const dailyAsOf = fresh.length ? fresh.map((f) => f.daily).sort().at(-1) : null;
  const intradayAsOf = fresh.length ? fresh.map((f) => f.intraday).filter(Boolean).sort().at(-1) : null;
  const scanFrom = fresh.length ? fresh.map((f) => f.daily_from).sort()[0] : null;
  const intradayFrom = fresh.length ? fresh.map((f) => f.intraday_from).filter(Boolean).sort()[0] : null;

  // Months that have signals, newest first, with each month's net for the dropdown.
  const months = useMemo(() => {
    const byMonth = new Map();
    (data?.signals || []).forEach((sig) => {
      const key = sig.date.slice(0, 7);
      const entry = byMonth.get(key) || { key, signals: 0, net: 0 };
      entry.signals += 1;
      if (sig.trade?.status === "closed") entry.net += sig.trade.net_rs || 0;
      byMonth.set(key, entry);
    });
    return [...byMonth.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [data]);

  const activeMonth = months.some((m) => m.key === month) ? month : "";
  const shown = useMemo(
    () => (data?.signals || []).filter((sig) => !activeMonth || sig.date.startsWith(activeMonth)),
    [data, activeMonth]
  );

  const stats = useMemo(() => {
    const list = shown;
    const taken = list.filter((sig) => sig.trade);
    const closed = taken.filter((sig) => sig.trade.status === "closed").map((sig) => sig.trade);
    const open = taken.filter((sig) => sig.trade.status === "open").map((sig) => sig.trade);
    const winners = closed.filter((t) => t.net_rs > 0);
    const losers = closed.filter((t) => t.net_rs <= 0);
    const sum = (ts) => ts.reduce((total, t) => total + (t.net_rs || 0), 0);
    const grossWin = sum(winners);
    const grossLoss = -sum(losers);
    // Drawdown on closed trades in exit order, one lot each.
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    [...closed]
      .sort((a, b) => (a.exit_date < b.exit_date ? -1 : a.exit_date > b.exit_date ? 1 : 0))
      .forEach((t) => {
        equity += t.net_rs || 0;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.min(maxDrawdown, equity - peak);
      });
    const best = closed.reduce((b, t) => (!b || t.net_rs > b.net_rs ? t : b), null);
    const worst = closed.reduce((w, t) => (!w || t.net_rs < w.net_rs ? t : w), null);
    const stopped = closed.filter((t) => t.exit_reason.startsWith("stop")).length;
    return {
      signals: list.length,
      taken: taken.length,
      notTaken: list.length - taken.length,
      open: open.length,
      openRs: sum(open),
      closed: closed.length,
      wins: winners.length,
      losses: losers.length,
      stopped,
      winRate: closed.length ? Math.round((winners.length / closed.length) * 100) : null,
      netRs: sum(closed),
      avgRs: closed.length ? sum(closed) / closed.length : null,
      avgWin: winners.length ? grossWin / winners.length : null,
      avgLoss: losers.length ? -grossLoss / losers.length : null,
      grossWin,
      grossLoss,
      profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
      maxDrawdown,
      best,
      worst,
      longs: taken.filter((sig) => sig.side === "long").length,
      shorts: taken.filter((sig) => sig.side === "short").length,
    };
  }, [shown]);

  return (
    <section className="mb-4 rounded-md border border-[#e2c08a]/30 bg-[#181b20] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#e2c08a]">
          KBDT signals · index futures · {days ? `last ${days} trading days` : `all available${scanFrom ? ` since ${scanFrom}` : ""}`}
        </p>
        <div className="flex items-center gap-3">
          {months.length > 1 && (
            <select
              value={activeMonth}
              onChange={(e) => setMonth(e.target.value)}
              aria-label="Filter by month"
              className="rounded-md border border-[#2c313a] bg-[#12151a] px-2 py-1 font-mono text-xs text-[#e2c08a] [color-scheme:dark]"
            >
              <option value="">All months</option>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {monthLabel(m.key)} · {m.signals} signal{m.signals === 1 ? "" : "s"} · {formatRs(m.net)}
                </option>
              ))}
            </select>
          )}
          <p className="font-mono text-xs text-[#6f6a62]">
            {dailyAsOf ? `daily ${dailyAsOf} · 15m to ${intradayAsOf ?? "—"}` : ""}
          </p>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded border border-[#2c313a] px-2 py-0.5 text-xs text-[#c8c3b8] hover:bg-white/5 disabled:opacity-40"
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      {error && <p className="py-3 text-sm text-[#f0b4b4]">{error}</p>}
      {!error && data && data.signals.length === 0 && (
        <p className="py-3 text-sm text-[#9b968c]">
          No KBDT signals on NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY or NIFTYNXT50 in the last {days} trading days. Signals
          are rare: about 7 a year per index in the backtest.
        </p>
      )}
      {!error && data && data.signals.length > 0 && (
        <>
          <p className="mb-2 font-mono text-xs text-[#9b968c]">
            {activeMonth ? monthLabel(activeMonth) : "All months"} · one lot per trade, after charges and slippage
          </p>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat
              label="Signals"
              value={stats.signals}
              sub={`${stats.taken} taken · ${stats.notTaken} not`}
              title={`${stats.longs} long · ${stats.shorts} short taken`}
            />
            <Stat
              label="Profitable trades"
              value={`${stats.wins} / ${stats.closed}`}
              className="text-[#8fbf9f]"
              sub={`${stats.losses} losing · ${stats.stopped} stopped`}
            />
            <Stat label="Win rate" value={stats.winRate == null ? "—" : `${stats.winRate}%`} sub="closed trades" />
            <Stat
              label="Net profit"
              value={formatRs(stats.netRs)}
              className={rClass(stats.netRs)}
              sub={`won ${formatRs(stats.grossWin)} · lost ${formatRs(-stats.grossLoss)}`}
            />
            <Stat
              label="Avg / trade"
              value={formatRs(stats.avgRs)}
              className={rClass(stats.avgRs)}
              sub={`win ${formatRs(stats.avgWin)} · loss ${formatRs(stats.avgLoss)}`}
            />
            <Stat
              label="Profit factor"
              value={stats.profitFactor ?? "—"}
              className={stats.profitFactor >= 1 ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}
              sub={`max drawdown ${formatRs(stats.maxDrawdown)}`}
              title="Rupees won ÷ rupees lost. Drawdown: largest fall in cumulative net profit, trades in exit order."
            />
            <Stat
              label="Best / worst"
              value={formatRs(stats.best?.net_rs)}
              className="text-[#8fbf9f]"
              sub={stats.worst ? `worst ${formatRs(stats.worst.net_rs)}` : undefined}
              title={
                stats.best && stats.worst
                  ? `Best: ${stats.best.symbol} ${stats.best.date} · Worst: ${stats.worst.symbol} ${stats.worst.date}`
                  : undefined
              }
            />
            <Stat
              label="Open now"
              value={stats.open}
              className={stats.open ? "text-[#e2c08a]" : ""}
              sub={stats.open ? `${formatRs(stats.openRs)} so far` : "no open positions"}
            />
          </div>
        </>
      )}
      {!error && data && data.signals.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Date", "Futures", "Action", "Entry", "Stop loss", "Risk / lot", "Exit", "Status", "Net / lot"].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
              {shown.map((sig) => {
                const t = sig.trade;
                const long = sig.side === "long";
                const status = !t
                  ? "Not taken"
                  : t.status === "open"
                    ? `Open · day ${t.day_of_hold} of ${hold}`
                    : t.exit_reason.startsWith("stop")
                      ? "Stopped out"
                      : "Exited on time";
                // The stop the chosen setting uses: from the actual fill when there is one, else from the level.
                const entryPx = t ? t.entry : sig.level;
                let stop = t ? t.stop : sig.model_stop;
                if (!t && parts.mode !== "model") {
                  const fixed = long ? entryPx * (1 - parts.pct / 100) : entryPx * (1 + parts.pct / 100);
                  stop = parts.mode === "fixed" ? fixed : long ? Math.max(stop, fixed) : Math.min(stop, fixed);
                }
                const stopPts = Math.abs(entryPx - stop);
                const fmt = (v) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return (
                  <tr key={`${sig.symbol}-${sig.date}`} className="align-top hover:bg-white/[0.03]">
                    <td className="px-3 py-2 text-[#9b968c]">
                      {sig.date}
                      {sig.today && (
                        <span
                          className="ml-2 rounded bg-[#e2c08a]/15 px-1.5 py-0.5 text-[0.65rem] text-[#e2c08a]"
                          title="Today's daily candle is still forming; this signal can change until the close"
                        >
                          today
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[#e7e4dc]">
                      {sig.symbol}
                      <p className="text-[#6f6a62]">lot {sig.lot_size ?? "—"}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 font-semibold ${
                          long ? "bg-[#089981]/20 text-[#7dcca8]" : "bg-[#f23645]/20 text-[#f0b4b4]"
                        }`}
                      >
                        {long ? "BUY" : "SELL"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-[#e7e4dc]">
                        {long ? "Buy above" : "Sell below"} {fmt(sig.level)}
                      </span>
                      <p className="text-[#6f6a62]">
                        {t ? (
                          t.method === "15m" ? (
                            `filled ${fmt(t.entry)} at ${t.entry_label}`
                          ) : (
                            <span title="No 15m candles for this day: entry, stop and exit are estimated from daily candles (exit at the day's close)">
                              filled {fmt(t.entry)} · daily est.
                            </span>
                          )
                        ) : sig.note?.includes("still open") ? (
                          "skipped: position already open"
                        ) : sig.note?.includes("never reached") ? (
                          "level not reached on 15m"
                        ) : sig.note?.includes("15:15") ? (
                          "skipped: break after 15:15"
                        ) : (
                          "skipped: stop past entry"
                        )}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-[#f0b4b4]">{fmt(stop)}</span>
                      <p className="text-[#6f6a62]">
                        {stopPts.toFixed(2)} pts · {((stopPts / entryPx) * 100).toFixed(2)}%
                        {Math.abs(stop - sig.model_stop) > 0.005 && (
                          <span title="The model's stop: previous day's low (long) or high (short)"> · model {fmt(sig.model_stop)}</span>
                        )}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-[#c8c3b8]">
                      {sig.lot_size ? `₹${Math.round(stopPts * sig.lot_size).toLocaleString("en-IN")}` : "—"}
                      <p className="text-[#6f6a62]">if stopped</p>
                    </td>
                    <td className="px-3 py-2 text-[#9b968c]">
                      {hold === 1 ? "Same day 15:15" : `${hold === 3 ? "3rd" : "5th"} trading day 15:15`}
                      <p className="text-[#6f6a62]">
                        {t && t.status === "closed"
                          ? `${fmt(t.exit)} on ${t.exit_date}${t.method === "daily" && !t.exit_reason.startsWith("stop") ? " (close)" : ""}`
                          : t
                            ? "still open"
                            : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2" title={sig.note}>
                      <span
                        className={
                          t?.status === "open"
                            ? "text-[#e2c08a]"
                            : t
                              ? t.exit_reason.startsWith("stop")
                                ? "text-[#f0b4b4]"
                                : "text-[#c8c3b8]"
                              : "text-[#6f6a62] underline decoration-dotted"
                        }
                      >
                        {status}
                      </span>
                      {t?.exit_reason === "stop (gap)" && <p className="text-[#6f6a62]">gapped past stop</p>}
                    </td>
                    <td
                      className={`px-3 py-2 ${rClass(t?.net_rs)}`}
                      title={t ? `${formatR(t.net_r)} after costs${t.status === "open" ? " · marked to the latest 15m close" : ""}` : undefined}
                    >
                      {t ? formatRs(t.net_rs) : "—"}
                      {t && <p className="text-[#6f6a62]">{formatR(t.net_r)}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-[#6f6a62]">
        From the futures' own continuous daily candles (scanned once at least 60 days of history exist) and 15m candles
        {intradayFrom ? ` (from ${intradayFrom})` : ""}, replayed day by day like the backtest with the Exit and Stop above.
        Signals on days without 15m candles are estimated from daily candles (exit at the day's close) and marked "daily
        est.". One open position per future at a time; hover "Not taken" for the reason. Today's daily candle is still
        forming, so a signal on it can appear or disappear until the close. Refresh the data with Download EOD and iData.
      </p>
    </section>
  );
}

function Check({ ok, label, title }) {
  return (
    <span className={ok ? "text-[#8fbf9f]" : "text-[#f0b4b4]"} title={title}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function NextSetups({ parts }) {
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch("/api/kbdt/setups")
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || "Could not load setups");
          return;
        }
        setRows(payload.data || []);
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live LTP of the current futures contracts, refreshed every 30 seconds.
  const [ltp, setLtp] = useState({});
  const [ltpAt, setLtpAt] = useState("");
  const [ltpError, setLtpError] = useState("");
  useEffect(() => {
    let alive = true;
    const fetchLtp = () =>
      fetch("/api/kbdt/ltp")
        .then((r) => r.json())
        .then((payload) => {
          if (!alive) return;
          if (payload.status !== "success") {
            setLtpError(payload.message || "LTP unavailable");
            return;
          }
          setLtp(payload.data || {});
          setLtpAt(payload.at || "");
          setLtpError("");
        })
        .catch(() => alive && setLtpError("LTP unavailable"));
    fetchLtp();
    const timer = window.setInterval(fetchLtp, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const fmt = (v) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const asOf = rows?.map((r) => r.as_of).filter(Boolean).sort().at(-1);
  // After the session, the stored daily close should equal the LTP. If not, today's
  // candle was downloaded mid-session and the setups are built on an unfinished candle.
  const stale = (rows || []).filter(
    (r) => r.close != null && !r.forming && ltp[r.symbol] && Math.abs(ltp[r.symbol].ltp - r.close) / r.close > 0.001
  );
  const forming = rows?.some((r) => r.forming);
  const live = rows?.filter((r) => r.live) || [];
  const hold = Number(parts.exit[0]);

  return (
    <section className="mb-4 rounded-md border border-[#e2c08a]/50 bg-[#181b20] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#e2c08a]">
          Tomorrow's setups · next session{asOf ? ` · from the ${asOf} close` : ""}
        </p>
        <div className="flex items-center gap-3">
          {rows && (
            <p className="font-mono text-xs text-[#9b968c]">
              {live.length} live setup{live.length === 1 ? "" : "s"}
              {ltpAt ? ` · LTP ${ltpAt}` : ""}
              {ltpError ? <span className="text-[#f0b4b4]"> · {ltpError}</span> : null}
            </p>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded border border-[#2c313a] px-2 py-0.5 text-xs text-[#c8c3b8] hover:bg-white/5 disabled:opacity-40"
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      {forming && (
        <p className="mb-2 rounded bg-[#e2c08a]/10 px-3 py-1.5 text-xs text-[#e2c08a]">
          Today's daily candle is still forming. These setups are only final after the close; run Download EOD after 15:30
          and refresh.
        </p>
      )}
      {stale.length > 0 && !forming && (
        <p className="mb-2 rounded bg-[#f23645]/10 px-3 py-1.5 text-xs text-[#f0b4b4]">
          The stored {asOf} daily candle doesn't match the live price (
          {stale.map((r) => `${r.symbol} close ${fmt(r.close)} vs LTP ${fmt(ltp[r.symbol].ltp)}`).join(" · ")}). It was
          probably downloaded during the session. Run Download EOD after 15:30, then Refresh, before placing orders.
        </p>
      )}
      {error && <p className="py-3 text-sm text-[#f0b4b4]">{error}</p>}
      {rows && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Futures", "Setup", "LTP", "Stop loss", "Risk / lot", "Filters", "Exit"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
              {rows.map((r) => {
                if (r.level == null) {
                  return (
                    <tr key={r.symbol}>
                      <td className="px-3 py-2 text-[#e7e4dc]">{r.symbol}</td>
                      <td className="px-3 py-2 text-[#6f6a62]" colSpan={6}>
                        No setup · {r.reasons?.join(", ")}
                      </td>
                    </tr>
                  );
                }
                const long = r.side === "long";
                let stop = r.stop;
                if (parts.mode !== "model") {
                  const fixed = long ? r.level * (1 - parts.pct / 100) : r.level * (1 + parts.pct / 100);
                  stop = parts.mode === "fixed" ? fixed : long ? Math.max(stop, fixed) : Math.min(stop, fixed);
                }
                const stopPts = Math.abs(r.level - stop);
                return (
                  <tr key={r.symbol} className={`align-top ${r.live ? "bg-[#e2c08a]/[0.06]" : "opacity-60"}`}>
                    <td className="px-3 py-2 text-[#e7e4dc]">
                      {r.symbol}
                      <p className="text-[#6f6a62]">lot {r.lot_size ?? "—"}</p>
                    </td>
                    <td className="px-3 py-2">
                      {r.live ? (
                        <>
                          <span
                            className={`mr-2 rounded px-2 py-0.5 font-semibold ${
                              long ? "bg-[#089981]/20 text-[#7dcca8]" : "bg-[#f23645]/20 text-[#f0b4b4]"
                            }`}
                          >
                            {long ? "BUY" : "SELL"}
                          </span>
                          <span className="text-[#e7e4dc]">
                            {long ? "above" : "below"} {fmt(r.level)}
                          </span>
                          <p className="mt-1 text-[#6f6a62]">stop order, next session</p>
                        </>
                      ) : (
                        <>
                          <span className="text-[#9b968c]">No setup</span>
                          <p className="text-[#6f6a62]">
                            next {long ? "break up" : "break down"} at {fmt(r.level)}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {ltp[r.symbol] ? (
                        (() => {
                          const price = ltp[r.symbol].ltp;
                          const toGo = long ? r.level - price : price - r.level;
                          const through = toGo <= 0;
                          return (
                            <>
                              <span className="text-[#e7e4dc]">{fmt(price)}</span>
                              <p className={through ? "text-[#e2c08a]" : "text-[#6f6a62]"} title={ltp[r.symbol].tradingsymbol}>
                                {through
                                  ? `through the level by ${Math.abs(toGo).toFixed(2)}`
                                  : `${toGo.toFixed(2)} pts · ${((toGo / price) * 100).toFixed(2)}% to go`}
                              </p>
                            </>
                          );
                        })()
                      ) : (
                        <span className="text-[#6f6a62]">—</span>
                      )}
                      <p className="text-[#6f6a62]">close {fmt(r.close)}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span className={r.live ? "text-[#f0b4b4]" : "text-[#9b968c]"}>{fmt(stop)}</span>
                      <p className="text-[#6f6a62]">
                        {stopPts.toFixed(2)} pts · {((stopPts / r.level) * 100).toFixed(2)}%
                        {parts.mode !== "model" && Math.abs(stop - r.stop) > 0.005 ? ` · model ${fmt(r.stop)}` : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-[#c8c3b8]">
                      {r.lot_size ? `₹${Math.round(stopPts * r.lot_size).toLocaleString("en-IN")}` : "—"}
                      <p className="text-[#6f6a62]">if stopped</p>
                    </td>
                    <td className="px-3 py-2">
                      <Check
                        ok={r.lwv_on}
                        label="weekly low vol."
                        title="The model only trades when the weekly range is quiet (weekly LV filter)"
                      />
                      <p>
                        <Check
                          ok={!!r.prev_break_lost}
                          label={
                            r.prev_break != null
                              ? `last ${long ? "short" : "long"} break lost`
                              : "no earlier opposite break"
                          }
                          title={`The model only takes a break if the previous key break the other way would have lost${
                            r.prev_break != null ? ` · last ${long ? "short" : "long"} break: ${fmt(r.prev_break)} on ${r.prev_break_day}` : ""
                          }`}
                        />
                      </p>
                    </td>
                    <td className="px-3 py-2 text-[#9b968c]">
                      {hold === 1 ? "Same day 15:15" : `${hold === 3 ? "3rd" : "5th"} trading day 15:15`}
                      <p className="text-[#6f6a62]">or the stop</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-[#6f6a62]">
        Built from each future's daily candles up to the latest close, using the model's own signal code on a hypothetical
        next-day candle that touches the level. On history (Dec 2025 – Nov 2026), 51 of 56 signals were live setups the
        evening before, and 51 of 55 live setups that broke the next day became signals. Every miss came from the weekly
        low-volatility filter changing during that day. Place a stop order at the level with the stop loss attached; if
        the level doesn't break, cancel it and check again after the next close.
      </p>
    </section>
  );
}

export default function KbdtSignalsPage() {
  const [parts, setParts] = useState({ exit: "5d", mode: "model", pct: 0.75 });
  const [slippage, setSlippage] = useState(0.02);
  const [days, setDays] = useState(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">KBDT signals · index futures</h1>
        <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
          Key Breakout Dow Theory on NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50 futures: tomorrow's setups to
          place as stop orders, then past signals and how each traded under the exit and stop below. Same rules and
          day-by-day method as the backtest.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented options={PERIODS} value={days} onChange={setDays} />
        <div className="flex items-center gap-2" title="Exit at 15:15 on this trading day unless the stop is hit first">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Exit</span>
          <Segmented options={KBDT_EXITS} value={parts.exit} onChange={(exit) => setParts({ ...parts, exit })} />
        </div>
        <div
          className="flex items-center gap-2"
          title="Previous day: the model's stop (previous day's low for longs, high for shorts). Fixed: the stop sits this % from entry instead. Capped: the model stop, but never further than this %."
        >
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Stop</span>
          <Segmented options={KBDT_STOP_MODES} value={parts.mode} onChange={(mode) => setParts({ ...parts, mode })} />
          {parts.mode !== "model" && (
            <Segmented options={KBDT_STOP_PCTS} value={parts.pct} onChange={(pct) => setParts({ ...parts, pct })} />
          )}
        </div>
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
      </div>

      <NextSetups parts={parts} />

      <SignalsTable parts={parts} slippage={slippage} days={days} />
    </div>
  );
}
