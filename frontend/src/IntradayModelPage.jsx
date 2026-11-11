import { useEffect, useMemo, useState } from "react";
import CandleModal from "./CandleModal";
import { PERIODS, WinRateModal, bucket } from "./DailyWinRateChart";
import ModelInfoModal, { InfoButton } from "./ModelInfoModal";

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
  const profits = list.map(tradeProfit).filter(Boolean);
  return {
    trades: list.length,
    open: list.length - closed.length,
    win_rate: list.length ? Math.round((list.filter((t) => t.r > 0).length / list.length) * 1000) / 10 : null,
    total_r: Math.round(total * 100) / 100,
    avg_r: list.length ? Math.round((total / list.length) * 100) / 100 : null,
    net_profit: profits.length ? profits.reduce((sum, p) => sum + p.net, 0) : null,
    profit_excluded: list.length - profits.length,
  };
}

// Blended points per unit: R times the entry-to-stop risk, so a half booked at T1 counts half.
function tradePoints(t) {
  if (t.r == null || t.entry == null || t.stop == null) return null;
  return t.r * Math.abs(t.entry - t.stop);
}

// NSE futures charges (Zerodha schedule). Brokerage is per executed order.
const CHARGES = {
  brokeragePct: 0.0003, // 0.03% per order, capped at ₹20
  brokerageCap: 20,
  sttSellPct: 0.0005, // 0.05% on the sell side (futures, from Apr 2026)
  exchangePct: 0.0000173, // NSE transaction charge, both sides
  sebiPct: 0.000001, // ₹10 per crore, both sides
  stampBuyPct: 0.00002, // 0.002% on the buy side
  gstPct: 0.18, // on brokerage + exchange + SEBI
};

// One lot, round trip. A T1 half-booking makes the exit two orders; the blended exit
// price (entry ± points) gives the exact total exit turnover either way.
function tradeCharges(t, points) {
  const qty = t.lot_size;
  const entryValue = t.entry * qty;
  const exitValue = (t.side === "long" ? t.entry + points : t.entry - points) * qty;
  const buyValue = t.side === "long" ? entryValue : exitValue;
  const sellValue = t.side === "long" ? exitValue : entryValue;
  const exitOrders = t.t1_hit ? 2 : 1;
  const perOrder = (value) => Math.min(CHARGES.brokerageCap, value * CHARGES.brokeragePct);
  const brokerage = perOrder(entryValue) + exitOrders * perOrder(exitValue / exitOrders);
  const turnover = buyValue + sellValue;
  const exchange = turnover * CHARGES.exchangePct;
  const sebi = turnover * CHARGES.sebiPct;
  const stt = sellValue * CHARGES.sttSellPct;
  const stamp = buyValue * CHARGES.stampBuyPct;
  const gst = (brokerage + exchange + sebi) * CHARGES.gstPct;
  return { brokerage, stt, exchange, sebi, stamp, gst, total: brokerage + stt + exchange + sebi + stamp + gst };
}

// Kite reports MCX lot_size as 1 (lots, not quantity), so rupee profit is only shown for NSE.
// Returns net profit for one lot after brokerage and statutory charges.
function tradeProfit(t) {
  const points = tradePoints(t);
  if (points == null || !t.lot_size || t.exchange === "MCX") return null;
  const gross = points * t.lot_size;
  const charges = tradeCharges(t, points);
  return { gross, charges, net: gross - charges.total };
}

function profitTitle(p) {
  if (!p) return undefined;
  const c = p.charges;
  const f = (v) => `₹${v.toFixed(2)}`;
  return [
    `Gross ${formatRupees(p.gross)}`,
    `Brokerage ${f(c.brokerage)}`,
    `STT ${f(c.stt)}`,
    `Exchange ${f(c.exchange)}`,
    `SEBI ${f(c.sebi)}`,
    `Stamp ${f(c.stamp)}`,
    `GST ${f(c.gst)}`,
    `Charges ${f(c.total)}`,
    `Net ${formatRupees(p.net)}`,
  ].join("\n");
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

function Stat({ label, value, className = "", title }) {
  return (
    <div className="rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3" title={title}>
      <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">{label}</p>
      <p className={`mt-1 font-mono text-lg ${className}`}>{value}</p>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso) {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

// Week key is its Monday; label runs Monday to Sunday.
function weekLabel(monday) {
  const end = new Date(`${monday}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${shortDate(monday)} – ${shortDate(end.toISOString().slice(0, 10))} ${end.getUTCFullYear()}`;
}

function monthLabel(first) {
  return `${MONTHS[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;
}

const RANGES = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["all", "All days"],
];

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

export default function IntradayModelPage({ model, title, description, info: Info }) {
  const [trades, setTrades] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("day");
  const [selectedDay, setSelectedDay] = useState("");
  const [selectedWeek, setSelectedWeek] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [chartTrade, setChartTrade] = useState(null);
  const [winRatePeriod, setWinRatePeriod] = useState(null);
  const [showInfo, setShowInfo] = useState(false);
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
  const firstDay = useMemo(() => taken.reduce((min, t) => (!min || t.date < min ? t.date : min), ""), [taken]);
  // Until a day is picked, follow the latest day with trades.
  const activeDay = selectedDay || latestDay;
  // Weeks and months that have trades, newest first.
  const weeks = useMemo(() => [...new Set(taken.map((t) => bucket(t.date, "week")))].sort().reverse(), [taken]);
  const months = useMemo(() => [...new Set(taken.map((t) => bucket(t.date, "month")))].sort().reverse(), [taken]);
  const activeWeek = weeks.includes(selectedWeek) ? selectedWeek : weeks[0] || "";
  const activeMonth = months.includes(selectedMonth) ? selectedMonth : months[0] || "";
  const rangeLabel =
    filter === "day"
      ? activeDay || "—"
      : filter === "week"
        ? activeWeek
          ? `week ${weekLabel(activeWeek)}`
          : "—"
        : filter === "month"
          ? activeMonth
            ? monthLabel(activeMonth)
            : "—"
          : "all days";
  const rows = useMemo(() => {
    const list =
      filter === "day"
        ? taken.filter((t) => t.date === activeDay)
        : filter === "week"
          ? taken.filter((t) => bucket(t.date, "week") === activeWeek)
          : filter === "month"
            ? taken.filter((t) => bucket(t.date, "month") === activeMonth)
            : taken;
    return [...list].sort((a, b) => (a.date === b.date ? a.entry_time - b.entry_time : a.date < b.date ? 1 : -1));
  }, [taken, filter, activeDay, activeWeek, activeMonth]);

  // Summarise exactly the trades in the table; open trades are marked to the last bar.
  const shown = useMemo(() => (summary ? summarize(rows) : null), [summary, rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {Info && <InfoButton onClick={() => setShowInfo(true)} label="How this model works" />}
          </div>
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
            {filter === "all" ? "All days" : `Result for ${rangeLabel}`}
          </p>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Stat label="Trades" value={shown.trades} />
            <Stat label="Open" value={shown.open} />
            <Stat label="Win rate" value={shown.win_rate == null ? "—" : `${shown.win_rate}%`} />
            <Stat label="Total" value={formatR(shown.total_r)} className={rClass(shown.total_r)} />
            <Stat label="Avg / trade" value={formatR(shown.avg_r)} className={rClass(shown.avg_r)} />
            <Stat
              label="Net profit"
              value={formatRupees(shown.net_profit)}
              className={rClass(shown.net_profit)}
              title={
                shown.profit_excluded > 0
                  ? `One lot per trade, after charges. ${shown.profit_excluded} trade(s) excluded (MCX or missing lot size).`
                  : "One lot per trade, after charges"
              }
            />
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
        <div className="mr-2 flex overflow-hidden rounded-md border border-[#2c313a]">
          {RANGES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`px-3 py-1.5 text-sm ${
                filter === id ? "bg-[#e2c08a]/15 text-[#e2c08a]" : "text-[#9b968c] hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {filter === "day" && (
          <input
            type="date"
            value={activeDay}
            min={firstDay || undefined}
            max={latestDay || undefined}
            onChange={(e) => setSelectedDay(e.target.value)}
            aria-label="Trade day"
            className="rounded-md border border-[#2c313a] bg-[#181b20] px-2 py-1 font-mono text-sm text-[#e2c08a] [color-scheme:dark]"
          />
        )}
        {filter === "week" && (
          <select
            value={activeWeek}
            onChange={(e) => setSelectedWeek(e.target.value)}
            aria-label="Trade week"
            className="rounded-md border border-[#2c313a] bg-[#181b20] px-2 py-1.5 font-mono text-sm text-[#e2c08a] [color-scheme:dark]"
          >
            {weeks.map((w) => (
              <option key={w} value={w}>
                {weekLabel(w)}
              </option>
            ))}
          </select>
        )}
        {filter === "month" && (
          <select
            value={activeMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            aria-label="Trade month"
            className="rounded-md border border-[#2c313a] bg-[#181b20] px-2 py-1.5 font-mono text-sm text-[#e2c08a] [color-scheme:dark]"
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex gap-1">
          {Object.entries(PERIODS).map(([period, { label }]) => (
            <button
              key={period}
              type="button"
              onClick={() => setWinRatePeriod(period)}
              disabled={taken.length === 0}
              className="rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5 disabled:opacity-40"
            >
              {label} win rate
            </button>
          ))}
        </div>
        <p className="ml-3 font-mono text-xs text-[#6f6a62]">{rows.length} trades</p>
      </div>

      <section className="min-h-64 flex-1 overflow-auto rounded-md border border-[#2c313a] bg-[#181b20]">
        {error && <p className="px-4 py-10 text-center text-sm text-[#f0b4b4]">{error}</p>}
        {!error && !loading && rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-[#9b968c]">
            {taken.length > 0 && filter === "day"
              ? `No trades on ${activeDay}.`
              : "No trades. Download iData (and EOD for the trend filter) first."}
          </p>
        )}
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#1e2128] text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Date", "Exch", "Symbol", "Side", "Entry", "Price", "Stop", "Target", "Exit", "Reason", "R", "Points", "Lot", "Net profit", ""].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
              {rows.map((t) => {
                const profit = tradeProfit(t);
                return (
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
                    className={`px-3 py-2 ${rClass(profit?.net)}`}
                    title={t.exchange === "MCX" ? "MCX lot multiplier not available from Kite" : profitTitle(profit)}
                  >
                    {formatRupees(profit?.net)}
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
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {showInfo && Info && (
        <ModelInfoModal title={`How ${title} works`} onClose={() => setShowInfo(false)}>
          <Info />
        </ModelInfoModal>
      )}

      {winRatePeriod && (
        <WinRateModal
          trades={taken}
          period={winRatePeriod}
          title={`${title} · ${PERIODS[winRatePeriod].label.toLowerCase()} win rate`}
          onClose={() => setWinRatePeriod(null)}
        />
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
