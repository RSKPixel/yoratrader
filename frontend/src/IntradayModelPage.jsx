import { useEffect, useMemo, useState } from "react";
import CandleModal from "./CandleModal";
import { DailyWinRateModal } from "./DailyWinRateChart";

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatR(value) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(2)}R`;
}

function rClass(value) {
  if (value == null || value === 0) return "text-[#c8c3b8]";
  return value > 0 ? "text-[#8fbf9f]" : "text-[#f0b4b4]";
}

function summarize(list) {
  const closed = list.filter((t) => t.status === "closed");
  const total = list.reduce((sum, t) => sum + (t.r || 0), 0);
  return {
    trades: list.length,
    open: list.length - closed.length,
    win_rate: list.length ? Math.round((list.filter((t) => t.r > 0).length / list.length) * 1000) / 10 : null,
    total_r: Math.round(total * 100) / 100,
    avg_r: list.length ? Math.round((total / list.length) * 100) / 100 : null,
  };
}

// Blended points per unit: R times the entry-to-stop risk, so a half booked at T1 counts half.
function tradePoints(t) {
  if (t.r == null || t.entry == null || t.stop == null) return null;
  return t.r * Math.abs(t.entry - t.stop);
}

// Kite reports MCX lot_size as 1 (lots, not quantity), so rupee profit is only shown for NSE.
function tradeProfit(t) {
  const points = tradePoints(t);
  if (points == null || !t.lot_size || t.exchange === "MCX") return null;
  return points * t.lot_size;
}

function formatPoints(value) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatRupees(value) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function Stat({ label, value, className = "" }) {
  return (
    <div className="rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
      <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">{label}</p>
      <p className={`mt-1 font-mono text-lg ${className}`}>{value}</p>
    </div>
  );
}

const UNIVERSES = [
  ["all", "All"],
  ["nse", "NSE"],
  ["mcx", "MCX"],
  ["index", "Index"],
];

const CAPS = [
  [1, "1/day"],
  [2, "2/day"],
  [3, "3/day"],
  [5, "5/day"],
  [0, "No cap"],
];

const FILTERS = [
  ["latest", "Latest day"],
  ["all", "All trades"],
];

export default function IntradayModelPage({ model, title, description }) {
  const [trades, setTrades] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("latest");
  const [chartTrade, setChartTrade] = useState(null);
  const [showWinRate, setShowWinRate] = useState(false);
  const [universe, setUniverse] = useState("index");
  const [maxPerDay, setMaxPerDay] = useState(5);

  const [refreshing, setRefreshing] = useState(false);
  const [lastDownload, setLastDownload] = useState(null);

  // refresh=true pulls today's 15m bars for this universe first, then scans.
  const load = ({ refresh = false } = {}) => {
    setLoading(true);
    setRefreshing(refresh);
    setError("");
    const request = refresh
      ? fetch(`/api/models/${model}/refresh?universe=${universe}&max_per_day=${maxPerDay}`, { method: "POST" })
      : fetch(`/api/models/${model}?universe=${universe}&max_per_day=${maxPerDay}`);
    request
      .then((response) => response.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || "Could not run scan");
          return;
        }
        setTrades(payload.data || []);
        setSummary(payload.summary || null);
        if (payload.download) setLastDownload({ ...payload.download, at: new Date().toLocaleTimeString() });
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };

  useEffect(() => {
    load();
  }, [universe, model, maxPerDay]);

  const taken = useMemo(() => trades.filter((t) => t.status === "closed" || t.status === "open"), [trades]);
  const latestDay = useMemo(() => taken.reduce((max, t) => (t.date > max ? t.date : max), ""), [taken]);
  const rows = useMemo(() => {
    const list = filter === "latest" ? taken.filter((t) => t.date === latestDay) : taken;
    return [...list].sort((a, b) => (a.date === b.date ? a.entry_time - b.entry_time : a.date < b.date ? 1 : -1));
  }, [taken, filter, latestDay]);

  // Summarise exactly the trades in the table; open trades are marked to the last bar.
  const shown = useMemo(() => (summary ? summarize(rows) : null), [summary, rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">{description}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => load({ refresh: true })}
            disabled={loading}
            title="Download today's 15m bars for the selected universe, then rescan"
            className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
          >
            {refreshing ? "Downloading today…" : loading ? "Scanning…" : "Rescan"}
          </button>
          {lastDownload && (
            <p className="font-mono text-xs text-[#6f6a62]">
              {lastDownload.at} · {lastDownload.candles} bars, {lastDownload.symbols} symbols
              {lastDownload.errors.length > 0 && (
                <span className="text-[#f0b4b4]" title={lastDownload.errors.join("\n")}>
                  {" "}
                  · {lastDownload.errors.length} failed
                </span>
              )}
            </p>
          )}
        </div>
      </header>

      {shown && (
        <>
          <p className="mb-2 text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
            {filter === "latest" ? `Result for ${latestDay || "—"}` : "All days"}
          </p>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Trades" value={shown.trades} />
            <Stat label="Open" value={shown.open} />
            <Stat label="Win rate" value={shown.win_rate == null ? "—" : `${shown.win_rate}%`} />
            <Stat label="Total" value={formatR(shown.total_r)} className={rClass(shown.total_r)} />
            <Stat label="Avg / trade" value={formatR(shown.avg_r)} className={rClass(shown.avg_r)} />
          </div>
        </>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1">
        <div
          className="mr-3 flex overflow-hidden rounded-md border border-[#2c313a]"
          title="Max trades per day across the universe; first signals by time, ties go to the tighter stop"
        >
          {CAPS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMaxPerDay(value)}
              disabled={loading}
              className={`px-3 py-1.5 text-sm disabled:opacity-60 ${
                maxPerDay === value ? "bg-[#e2c08a]/15 text-[#e2c08a]" : "text-[#9b968c] hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mr-3 flex overflow-hidden rounded-md border border-[#2c313a]">
          {UNIVERSES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setUniverse(id)}
              disabled={loading}
              title={id === "index" ? "NIFTY, BANKNIFTY, MIDCPNIFTY futures" : undefined}
              className={`px-3 py-1.5 text-sm disabled:opacity-60 ${
                universe === id ? "bg-[#e2c08a]/15 text-[#e2c08a]" : "text-[#9b968c] hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              filter === id ? "bg-[#e2c08a]/15 text-[#e2c08a]" : "text-[#9b968c] hover:bg-white/5"
            }`}
          >
            {label}
            {id === "latest" && latestDay ? ` (${latestDay})` : ""}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowWinRate(true)}
          disabled={taken.length === 0}
          className="ml-auto rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5 disabled:opacity-40"
        >
          Daily win rate
        </button>
        <p className="ml-3 font-mono text-xs text-[#6f6a62]">{rows.length} trades</p>
      </div>

      <section className="min-h-64 flex-1 overflow-auto rounded-md border border-[#2c313a] bg-[#181b20]">
        {error && <p className="px-4 py-10 text-center text-sm text-[#f0b4b4]">{error}</p>}
        {!error && !loading && rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-[#9b968c]">
            No trades. Download iData (and EOD for the trend filter) first.
          </p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#1e2128] text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Date", "Exch", "Symbol", "Side", "Entry", "Price", "Stop", "Target", "Exit", "Reason", "R", "Points", "Lot", "Profit", ""].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
              {rows.map((t) => (
                <tr key={`${t.exchange}-${t.symbol}-${t.date}`} className="hover:bg-white/[0.03]">
                  <td className="px-3 py-2 text-[#9b968c]">{t.date}</td>
                  <td className="px-3 py-2 text-[#9b968c]">{t.exchange}</td>
                  <td className="px-3 py-2 text-[#e7e4dc]">{t.symbol}</td>
                  <td className={`px-3 py-2 uppercase ${t.side === "long" ? "text-[#7dcca8]" : "text-[#f0b4b4]"}`}>
                    {t.side}
                  </td>
                  <td className="px-3 py-2">{t.entry_label}</td>
                  <td className="px-3 py-2">{formatPrice(t.entry)}</td>
                  <td className="px-3 py-2 text-[#f0b4b4]">{formatPrice(t.stop)}</td>
                  <td className="px-3 py-2 text-[#8fbf9f]">{formatPrice(t.target)}</td>
                  <td className="px-3 py-2">{formatPrice(t.exit)}</td>
                  <td className="px-3 py-2 text-[#9b968c]">
                    {t.exit_reason}
                    {t.t1_hit ? " · T1" : ""}
                  </td>
                  <td className={`px-3 py-2 ${rClass(t.r)}`}>{formatR(t.r)}</td>
                  <td className={`px-3 py-2 ${rClass(t.r)}`}>{formatPoints(tradePoints(t))}</td>
                  <td className="px-3 py-2 text-[#9b968c]">{t.exchange === "MCX" ? "—" : t.lot_size ?? "—"}</td>
                  <td
                    className={`px-3 py-2 ${rClass(t.r)}`}
                    title={t.exchange === "MCX" ? "MCX lot multiplier not available from Kite" : undefined}
                  >
                    {formatRupees(tradeProfit(t))}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setChartTrade(t)}
                      aria-label={`Open 15m chart for ${t.symbol} on ${t.date}`}
                      className="rounded border border-[#2c313a] px-2 py-0.5 text-[#c8c3b8] hover:bg-white/5"
                    >
                      Chart
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showWinRate && (
        <DailyWinRateModal trades={taken} title={`${title} · daily win rate`} onClose={() => setShowWinRate(false)} />
      )}

      {chartTrade && (
        <CandleModal
          contract={{ exchange: chartTrade.exchange, name: chartTrade.symbol }}
          intradayTrade={chartTrade}
          onClose={() => setChartTrade(null)}
        />
      )}
    </div>
  );
}
