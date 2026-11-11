import { useEffect, useMemo, useRef } from "react";
import { createChart, HistogramSeries, LineSeries } from "lightweight-charts";

export const PERIODS = {
  day: { label: "Daily", unit: "day", units: "days" },
  week: { label: "Weekly", unit: "week", units: "weeks" },
  month: { label: "Monthly", unit: "month", units: "months" },
};

// Bucket a trade date (YYYY-MM-DD) to its day, its week's Monday, or its month's 1st.
export function bucket(date, period) {
  if (period === "month") return `${date.slice(0, 7)}-01`;
  if (period === "week") {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return date;
}

/** Per-period win rate (bars) and running win rate (line) over closed trades. */
export function winRates(trades, period = "day") {
  const byDay = new Map();
  trades
    .filter((t) => t.status === "closed")
    .forEach((t) => {
      const key = bucket(t.date, period);
      const day = byDay.get(key) || { date: key, trades: 0, wins: 0, r: 0 };
      day.trades += 1;
      day.wins += t.r > 0 ? 1 : 0;
      day.r += t.r || 0;
      byDay.set(key, day);
    });
  let trades_ = 0;
  let wins = 0;
  return [...byDay.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((day) => {
      trades_ += day.trades;
      wins += day.wins;
      return {
        ...day,
        r: Math.round(day.r * 100) / 100,
        winRate: Math.round((day.wins / day.trades) * 1000) / 10,
        runningWinRate: Math.round((wins / trades_) * 1000) / 10,
      };
    });
}

export default function WinRateChart({ trades, period = "day" }) {
  const container = useRef(null);
  const days = useMemo(() => winRates(trades, period), [trades, period]);
  const { label, unit, units } = PERIODS[period];

  useEffect(() => {
    if (!container.current || days.length === 0) return undefined;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "#181b20" }, textColor: "#9b968c", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: "#23272e" } },
      rightPriceScale: { borderColor: "#2c313a", scaleMargins: { top: 0.08, bottom: 0.02 } },
      timeScale: { borderColor: "#2c313a" },
      handleScroll: false,
      handleScale: false,
    });
    const bars = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "custom", formatter: (v) => `${v.toFixed(0)}%` },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    bars.setData(
      days.map((d) => ({
        time: d.date,
        value: d.winRate,
        color: d.winRate >= 50 ? "rgba(8,153,129,0.65)" : "rgba(242,54,69,0.6)",
      }))
    );
    const running = chart.addSeries(LineSeries, {
      color: "#e2c08a",
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: (v) => `${v.toFixed(1)}%` },
    });
    running.setData(days.map((d) => ({ time: d.date, value: d.runningWinRate })));
    bars.createPriceLine({ price: 50, color: "#6f6a62", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [days]);

  if (days.length === 0) return null;
  const last = days.at(-1);
  const green = days.filter((d) => d.winRate >= 50).length;
  return (
    <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
          {label} win rate{period === "week" ? " · bars dated by Monday" : ""}
        </p>
        <p className="font-mono text-xs text-[#9b968c]">
          <span className="text-[#8fbf9f]">■</span> {unit} ≥ 50% · <span className="text-[#f0b4b4]">■</span> {unit} &lt; 50% ·{" "}
          <span className="text-[#e2c08a]">—</span> running {last.runningWinRate}% · {green}/{days.length} {units} ≥ 50%
        </p>
      </div>
      <div ref={container} className="h-80 w-full" />
    </section>
  );
}

export function WinRateModal({ trades, title, period = "day", onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasData = trades.some((t) => t.status === "closed");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-5xl overflow-hidden rounded-lg border border-[#2c313a] bg-[#12151a] p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-[#2c313a] px-2 py-0.5 text-sm text-[#c8c3b8] hover:bg-white/5"
          >
            Close
          </button>
        </div>
        {hasData ? (
          <WinRateChart trades={trades} period={period} />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-[#9b968c]">No closed trades yet.</p>
        )}
      </div>
    </div>
  );
}
