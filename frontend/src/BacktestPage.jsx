import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import ModelInfoModal, { BacktestInfo, InfoButton } from "./ModelInfoModal";
import { formatR, formatRs, KBDT_EXITS, KBDT_STOP_MODES, KBDT_STOP_PCTS, rClass, Segmented, SLIPPAGE, Stat } from "./backtestShared";

const DATASETS = [
  ["indices", "F&O indices"],
  ["stocks", "Nifty 50 stocks"],
];

const MODELS = [
  ["orb", "Opening Range Breakout"],
  ["fib", "Fib Pullback"],
  ["kbdtfib", "Key Break + Fib"],
  ["kbdt", "Key Breakout Dow Theory"],
  ["nrib", "NR4/NR7 inside day"],
  ["bbsq", "Bollinger squeeze"],
  ["rsi2", "RSI(2) pullback"],
  ["ibs", "IBS mean reversion"],
  ["donch", "Donchian breakout"],
  ["tom", "Turn of the month"],
];

// The six mechanical strategies: each variant id joins its dimension values with "-".
const TREND = [
  ["any", "Both sides"],
  ["with", "With SMA50 trend"],
];
const STRATEGY_SPECS = {
  nrib: {
    dims: [
      { key: "setup", label: "Setup", options: [["nr4", "NR4 inside day"], ["nr7", "NR7 inside day"]] },
      { key: "hold", label: "Exit", options: [["1d", "Same day 15:15"], ["3d", "3rd day 15:15"]] },
      { key: "trend", label: "Side", options: TREND },
    ],
    initial: { setup: "nr7", hold: "3d", trend: "any" },
    rules:
      "Toby Crabel's NR4/NR7 inside day: the setup day is both the narrowest range of the last 4 (or 7) days and an inside day (inside the day before). Next day, buy the break of its high or sell the break of its low, at the level or the open if it gaps past. Stop: the other side of the setup day's range. Exit at 15:15 the same day or on the 3rd day.",
  },
  bbsq: {
    dims: [
      { key: "stop", label: "Stop", options: [["1atr", "1× ATR"], ["2atr", "2× ATR"]] },
      { key: "hold", label: "Exit", options: [["3d", "3rd day 15:15"], ["5d", "5th day 15:15"]] },
    ],
    initial: { stop: "2atr", hold: "5d" },
    rules:
      "Bollinger squeeze: when the 20-day Bollinger Band width (4 standard deviations ÷ the 20-day average) is at its lowest in 120 days, trade the break of that day's high (buy) or low (sell) the next day. Stop: 1× or 2× the daily ATR from entry. Exit at 15:15 on the 3rd or 5th day.",
  },
  rsi2: {
    dims: [
      { key: "thr", label: "Signal", options: [["10", "RSI(2) < 10"], ["5", "RSI(2) < 5"]] },
      { key: "side", label: "Side", options: [["long", "Long only"], ["both", "Long & short"]] },
    ],
    initial: { thr: "10", side: "long" },
    rules:
      "Larry Connors' RSI(2) pullback: on the daily close, if 2-day RSI is below 10 (or 5) and the close is above its 200-day average, buy at the next open; optionally sell when RSI is above 90 (95) below the 200-day average. Exit at the next open after the close crosses the 5-day average, or after 5 days. Protective stop 2× ATR. The 200-day average needs history, so signals start in mid-2022.",
  },
  ibs: {
    dims: [
      { key: "thr", label: "Buy when IBS", options: [["0.2", "< 0.2"], ["0.1", "< 0.1"]] },
      { key: "exit", label: "Exit", options: [["next", "Next day 15:15"], ["ibs", "IBS > 0.8 (max 5 days)"]] },
    ],
    initial: { thr: "0.2", exit: "ibs" },
    rules:
      "Internal Bar Strength: at 15:15, IBS = (price − day's low) ÷ (day's high − day's low) from the day's 15m candles. Below 0.2 (or 0.1), the close is near the day's low: buy at 15:15. Exit at 15:15 the next day, or at 15:15 once IBS is above 0.8 (at most 5 days). Long only. Protective stop 2× ATR.",
  },
  donch: {
    dims: [
      { key: "entry", label: "Entry", options: [["20", "20-day breakout"], ["55", "55-day breakout"]] },
      { key: "exit", label: "Exit", options: [["10", "10-day opposite"], ["20", "20-day opposite"]] },
    ],
    initial: { entry: "20", exit: "10" },
    rules:
      "Donchian / Turtle breakout: buy a break of the 20-day (or 55-day) high, sell a break of the 20-day (or 55-day) low, at the level or the open if it gaps past. Stop 2× ATR from entry; exit on a break of the 10-day (or 20-day) low for longs, high for shorts. No time limit: trends are held as long as they run.",
  },
  tom: {
    dims: [
      { key: "entry", label: "Buy on", options: [["1", "Last trading day"], ["2", "2nd-last trading day"]] },
      { key: "exit", label: "Sell on", options: [["3", "3rd trading day"], ["5", "5th trading day"]] },
    ],
    initial: { entry: "1", exit: "3" },
    rules:
      "Turn of the month: buy at 15:15 on the last (or 2nd-last) trading day of the month and sell at 15:15 on the 3rd (or 5th) trading day of the next month. Long only, about 4–7 days a month. Protective stop 2× ATR.",
  },
};

function specVariant(model, parts) {
  return STRATEGY_SPECS[model].dims.map((d) => parts[d.key]).join("-");
}

function parseSpecVariant(model, id) {
  const values = id.split("-");
  return Object.fromEntries(STRATEGY_SPECS[model].dims.map((d, i) => [d.key, values[i]]));
}

function specLabel(model, id) {
  const parts = parseSpecVariant(model, id);
  return STRATEGY_SPECS[model].dims
    .map((d) => `${d.label} ${d.options.find(([v]) => v === parts[d.key])?.[1] ?? parts[d.key]}`)
    .join(" · ");
}

function kbdtVariant({ exit, mode, pct }) {
  return mode === "model" ? exit : `${exit}-${mode}-${pct}`;
}

function parseKbdtVariant(id) {
  const [exit, mode, pct] = id.split("-");
  return { exit, mode: mode || "model", pct: pct ? Number(pct) : 0.75 };
}

// ORB variant parts; the variant id is "bars-atr-minrisk", e.g. "2-0.5-0.0" (the live model).
const RANGE_BARS = [
  [2, "30 min"],
  [3, "45 min"],
  [4, "60 min"],
];
const STOP_ATR = [
  [0.5, "0.5× ATR"],
  [1.0, "1.0× ATR"],
];
const MIN_RISK = [
  [0.0, "Any"],
  [0.6, "≥ 0.6%"],
  [1.0, "≥ 1.0%"],
];
const LIVE = { bars: 2, atr: 0.5, minRisk: 0.0 };

function variantId({ bars, atr, minRisk }) {
  return `${bars}-${atr.toFixed(1)}-${minRisk.toFixed(1)}`;
}

function variantLabel(model, params, id) {
  if (STRATEGY_SPECS[model] && id) return specLabel(model, id);
  if (model === "kbdt") {
    const exit = KBDT_EXITS.find(([v]) => v === `${params.hold_days}d`)?.[1].toLowerCase();
    const stop =
      params.stop_mode === "fixed"
        ? `stop ${params.stop_pct}%`
        : params.stop_mode === "cap"
          ? `prev-day stop, max ${params.stop_pct}%`
          : "prev-day stop";
    return `Exit ${exit} · ${stop}`;
  }
  if (model !== "orb") return "Live settings";
  const range = RANGE_BARS.find(([b]) => b === params.or_bars)?.[1];
  const minRisk = params.min_risk_pct ? `stop ≥ ${params.min_risk_pct}%` : "any stop";
  return `${range} · ${params.stop_atr}× ATR · ${minRisk}`;
}

const CAPS = [
  [1, "1/day"],
  [2, "2/day"],
  [3, "3/day"],
  [5, "5/day"],
  [0, "No cap"],
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const UNITS = [
  ["r", "R"],
  ["rs", "₹ per lot"],
];

// Short rupees for the month grid: 1.2L, 45k.
function compactRs(value) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${Math.round(abs / 1000)}k`;
  return `${sign}${Math.round(abs)}`;
}

function cellStyle(value, scale) {
  if (value == null || !scale) return undefined;
  const alpha = Math.min(0.55, 0.1 + (Math.abs(value) / scale) * 0.45);
  return { backgroundColor: value >= 0 ? `rgba(8,153,129,${alpha})` : `rgba(242,54,69,${alpha})` };
}

function EquityChart({ equity, unit }) {
  const container = useRef(null);
  useEffect(() => {
    if (!container.current || equity.length === 0) return undefined;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "#181b20" }, textColor: "#9b968c", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: "#23272e" } },
      rightPriceScale: { borderColor: "#2c313a" },
      timeScale: { borderColor: "#2c313a" },
    });
    const format =
      unit === "rs"
        ? { type: "custom", formatter: (v) => `₹${(v / 100000).toFixed(2)}L` }
        : { type: "custom", formatter: (v) => `${v.toFixed(1)}R` };
    const grossKey = unit === "rs" ? "gross_rs" : "gross";
    const netKey = unit === "rs" ? "net_rs" : "net";
    const gross = chart.addSeries(LineSeries, {
      color: "#6f6a62",
      lineWidth: 1,
      priceLineVisible: false,
      priceFormat: format,
    });
    gross.setData(equity.map((p) => ({ time: p.date, value: p[grossKey] })));
    const net = chart.addSeries(LineSeries, {
      color: "#e2c08a",
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: format,
    });
    net.setData(equity.map((p) => ({ time: p.date, value: p[netKey] })));
    net.createPriceLine({ price: 0, color: "#6f6a62", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [equity, unit]);
  return <div ref={container} className="h-72 w-full" />;
}

function MonthGrid({ months, years, selected, onSelect, unit }) {
  const key_ = unit === "rs" ? "net_rs" : "net_r";
  const byMonth = useMemo(() => Object.fromEntries(months.map((m) => [m.month, m])), [months]);
  const scale = useMemo(() => Math.max(1, ...months.map((m) => Math.abs(m[key_]))), [months, key_]);
  const yearScale = useMemo(() => Math.max(1, ...years.map((y) => Math.abs(y[key_]))), [years, key_]);
  const cell = (v) => (unit === "rs" ? compactRs(v) : `${v > 0 ? "+" : ""}${v.toFixed(1)}`);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-0.5 font-mono text-xs">
        <thead>
          <tr className="text-[#6f6a62]">
            <th className="px-2 py-1 text-left font-medium">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-1 py-1 font-medium">
                {m}
              </th>
            ))}
            <th className="px-2 py-1 font-medium">Year</th>
            <th className="px-2 py-1 font-medium">Trades</th>
            <th className="px-2 py-1 font-medium">Win</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.year}>
              <td className="px-2 py-1 text-[#9b968c]">{y.year}</td>
              {MONTHS.map((_, i) => {
                const key = `${y.year}-${String(i + 1).padStart(2, "0")}`;
                const m = byMonth[key];
                return (
                  <td key={key} className="p-0">
                    {m ? (
                      <button
                        type="button"
                        onClick={() => onSelect(key)}
                        title={`${m.trades} trades · ${m.win_rate}% win · net ${formatR(m.net_r)} · ${formatRs(m.net_rs)} per lot`}
                        style={cellStyle(m[key_], scale)}
                        className={`w-full rounded px-1 py-1.5 text-center text-[#e7e4dc] hover:outline hover:outline-1 hover:outline-[#e2c08a]/60 ${
                          selected === key ? "outline outline-2 outline-[#e2c08a]" : ""
                        }`}
                      >
                        {cell(m[key_])}
                      </button>
                    ) : (
                      <span className="block px-1 py-1.5 text-center text-[#3a3f48]">·</span>
                    )}
                  </td>
                );
              })}
              <td className="rounded px-2 py-1.5 text-center text-[#e7e4dc]" style={cellStyle(y[key_], yearScale)}>
                {unit === "rs" ? formatRs(y.net_rs) : formatR(y.net_r, 1)}
              </td>
              <td className="px-2 py-1 text-center text-[#9b968c]">{y.trades}</td>
              <td className="px-2 py-1 text-center text-[#9b968c]">{y.win_rate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareTable({ rows, model, variant, onSelect, unit }) {
  const rs = unit === "rs";
  const sorted = useMemo(() => [...rows].sort((a, b) => b.avg_net_r - a.avg_net_r), [rows]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Model", "Settings", "Trades", "Gross / trade", "Cost / trade", "Net / trade", rs ? "Net ₹ / lot" : "Net R", "Profit factor", "t-stat", "Green years"].map(
              (h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
          {sorted.map((r) => {
            const active = r.model === model && r.variant === variant;
            return (
              <tr
                key={`${r.model}-${r.variant}`}
                onClick={() => onSelect(r.model, r.variant)}
                className={`cursor-pointer ${active ? "bg-[#e2c08a]/10" : "hover:bg-white/[0.03]"}`}
              >
                <td className="px-3 py-2 text-[#e7e4dc]">
                  {r.name}
                  {r.live && <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[0.65rem] text-[#9b968c]">live</span>}
                </td>
                <td className="px-3 py-2 text-[#9b968c]">{variantLabel(r.model, r.params, r.variant)}</td>
                <td className="px-3 py-2">{r.trades}</td>
                <td className={`px-3 py-2 ${rClass(r.avg_gross_r)}`}>
                  {rs ? formatRs(r.gross_rs / r.trades) : formatR(r.avg_gross_r, 3)}
                </td>
                <td className="px-3 py-2 text-[#9b968c]">
                  {rs ? formatRs(-r.avg_cost_rs) : `−${r.avg_cost_r.toFixed(3)}R`}
                </td>
                <td className={`px-3 py-2 ${rClass(r.avg_net_r)}`}>{rs ? formatRs(r.avg_net_rs) : formatR(r.avg_net_r, 3)}</td>
                <td className={`px-3 py-2 ${rClass(rs ? r.net_rs : r.net_r)}`}>{rs ? formatRs(r.net_rs) : formatR(r.net_r, 1)}</td>
                <td className={`px-3 py-2 ${r.profit_factor >= 1 ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>{r.profit_factor ?? "—"}</td>
                <td className="px-3 py-2 text-[#9b968c]">{r.t_stat ?? "—"}</td>
                <td className="px-3 py-2 text-[#9b968c]">
                  {r.green_years}/{r.years}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MonthTradesModal({ month, summary, trades, loading, settings, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Trades in ${title}`}
        className="flex max-h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-[#2c313a] bg-[#12151a] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2c313a] px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Trades · {title}</h2>
            <p className="mt-0.5 font-mono text-xs text-[#9b968c]">{settings}</p>
          </div>
          <div className="flex items-center gap-4">
            {summary && (
              <p className="font-mono text-xs text-[#9b968c]">
                {summary.trades} trades · {summary.win_rate}% win · net{" "}
                <span className={rClass(summary.net_r)}>{formatR(summary.net_r)}</span> ·{" "}
                <span className={rClass(summary.net_rs)}>{formatRs(summary.net_rs)}</span> per lot
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded border border-[#2c313a] px-2 py-0.5 text-sm text-[#c8c3b8] hover:bg-white/5"
            >
              Close
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? (
            <p className="py-10 text-center text-sm text-[#9b968c]">Loading…</p>
          ) : trades.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#9b968c]">No trades this month.</p>
          ) : (
            <TradesTable trades={trades} />
          )}
        </div>
      </div>
    </div>
  );
}

function TradesTable({ trades }) {
  return (
    <div className="overflow-auto rounded-md border border-[#2c313a]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#1e2128] text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Date", "Symbol", "Side", "Entry", "Price", "Stop", "Exit day", "Exit", "Reason", "R", "Cost", "Net R", "Lot", "Risk ₹", "Net ₹"].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
          {trades.map((t) => (
            <tr key={`${t.symbol}-${t.date}`} className="hover:bg-white/[0.03]">
              <td className="px-3 py-2 text-[#9b968c]">{t.date}</td>
              <td className="px-3 py-2 text-[#e7e4dc]">{t.symbol}</td>
              <td className={`px-3 py-2 uppercase ${t.side === "long" ? "text-[#7dcca8]" : "text-[#f0b4b4]"}`}>{t.side}</td>
              <td className="px-3 py-2">{t.entry_label}</td>
              <td className="px-3 py-2">{t.entry.toFixed(2)}</td>
              <td className="px-3 py-2 text-[#f0b4b4]">{t.stop.toFixed(2)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{t.exit_date === t.date ? "same day" : t.exit_date}</td>
              <td className="px-3 py-2">{t.exit.toFixed(2)}</td>
              <td className="px-3 py-2 text-[#9b968c]">
                {t.exit_reason}
                {t.t1_hit ? " · T1" : ""}
              </td>
              <td className={`px-3 py-2 ${rClass(t.r)}`}>{formatR(t.r)}</td>
              <td className="px-3 py-2 text-[#9b968c]">−{t.cost_r.toFixed(2)}R</td>
              <td className={`px-3 py-2 ${rClass(t.net_r)}`}>{formatR(t.net_r)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{t.lot_size ?? "—"}</td>
              <td className="px-3 py-2 text-[#9b968c]">{t.risk_rs == null ? "—" : `₹${t.risk_rs.toLocaleString("en-IN")}`}</td>
              <td
                className={`px-3 py-2 ${rClass(t.net_rs)}`}
                title={t.net_rs == null ? undefined : `Gross ${formatRs(t.gross_rs)} · costs ${formatRs(-t.cost_rs)}`}
              >
                {formatRs(t.net_rs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BacktestPage({ lockModel }) {
  const [model, setModel] = useState(lockModel || "kbdt");
  const [specParts, setSpecParts] = useState(() =>
    Object.fromEntries(Object.entries(STRATEGY_SPECS).map(([m, spec]) => [m, spec.initial]))
  );
  const [orbParts, setOrbParts] = useState(LIVE);
  const [kbdtParts, setKbdtParts] = useState({ exit: "5d", mode: "model", pct: 0.75 });
  const [compareRows, setCompareRows] = useState([]);
  const [dataset, setDataset] = useState("indices");
  const [maxPerDay, setMaxPerDay] = useState(0);
  const [unit, setUnit] = useState("r");
  const [slippage, setSlippage] = useState(0.02);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const [month, setMonth] = useState("");
  const [monthTrades, setMonthTrades] = useState([]);
  const [monthLoading, setMonthLoading] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const cap = maxPerDay;
  const variant =
    model === "orb"
      ? variantId(orbParts)
      : model === "kbdt"
        ? kbdtVariant(kbdtParts)
        : STRATEGY_SPECS[model]
          ? specVariant(model, specParts[model])
          : "live";
  const baseQuery = `dataset=${dataset}&max_per_day=${cap}&slippage=${slippage}`;
  const query = `model=${model}&variant=${variant}&${baseQuery}`;

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetch(`/api/backtest/orb?${query}`)
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || "Could not load the backtest");
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

  const loadCompare = useCallback(() => {
    fetch(`/api/backtest/orb/compare?${baseQuery}${lockModel ? `&model=${lockModel}` : ""}`)
      .then((r) => r.json())
      .then((payload) => setCompareRows(payload.data || []))
      .catch(() => setCompareRows([]));
  }, [baseQuery, lockModel]);

  useEffect(() => {
    loadCompare();
  }, [loadCompare]);

  const selectVariant = (nextModel, nextVariant) => {
    setModel(nextModel);
    if (nextModel === "orb") {
      const [bars, atr, minRisk] = nextVariant.split("-").map(Number);
      setOrbParts({ bars, atr, minRisk });
    }
    if (nextModel === "kbdt") setKbdtParts(parseKbdtVariant(nextVariant));
    if (STRATEGY_SPECS[nextModel]) setSpecParts((all) => ({ ...all, [nextModel]: parseSpecVariant(nextModel, nextVariant) }));
    setMonth("");
  };

  useEffect(() => {
    if (!month) {
      setMonthTrades([]);
      return;
    }
    setMonthLoading(true);
    fetch(`/api/backtest/orb/trades?${query}&month=${month}`)
      .then((r) => r.json())
      .then((payload) => setMonthTrades(payload.data || []))
      .catch(() => setMonthTrades([]))
      .finally(() => setMonthLoading(false));
  }, [month, query]);

  // Poll the download job while it runs; reload results when it finishes.
  const running = job?.status === "running";
  useEffect(() => {
    fetch("/api/backtest/orb/job")
      .then((r) => r.json())
      .then((payload) => setJob(payload.job))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      fetch("/api/backtest/orb/job")
        .then((r) => r.json())
        .then((payload) => {
          setJob(payload.job);
          if (payload.job?.status !== "running") {
            load();
            loadCompare();
          }
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, load, loadCompare]);

  const startDownload = () => {
    fetch("/api/backtest/orb/download", { method: "POST" })
      .then((r) => r.json())
      .then(() => setJob({ status: "running", phase: "download", done: 0, total: 55, symbol: "" }))
      .catch(() => setError("Could not start the download"));
  };

  const s = data?.summary;
  const run = data?.run;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {lockModel ? `Backtest · ${MODELS.find(([m]) => m === lockModel)[1]}` : "Backtest · All models"}
            </h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How this backtest works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            {lockModel && STRATEGY_SPECS[lockModel] ? (
              <>
                {STRATEGY_SPECS[lockModel].rules} 5 years of NSE cash data for the F&amp;O indices and the Nifty 50 stocks;
                net results are after NSE futures charges and slippage, rupees for one lot at today's lot sizes.
              </>
            ) : (
              <>
            The trading models over 5 years of NSE cash data: Key Breakout Dow Theory with 1, 3 or 5-day holds, and the
            intraday models (ORB in several stop and range settings). On the indices, ORB runs without its volume and
            VWAP filters (an index has no volume). Net results are after NSE futures charges and slippage; rupees are for
            one lot at today's lot sizes.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={startDownload}
            disabled={running}
            title="Download 5 years of 15m and daily data (only new bars after the first run), then rerun the backtest"
            className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
          >
            {running ? (job.phase === "backtest" ? "Running backtest…" : `Downloading ${job.done + 1}/${job.total}…`) : "Update data"}
          </button>
          <p className="font-mono text-xs text-[#6f6a62]">
            {running && job.symbol ? `${job.symbol} · ` : ""}
            {run ? `${run.first_day} → ${run.last_day} · ran ${run.ran_at.slice(0, 16).replace("T", " ")}` : "No run yet"}
            {job?.status === "error" && <span className="text-[#f0b4b4]"> · {job.message}</span>}
            {job?.errors?.length > 0 && !running && (
              <span className="text-[#f0b4b4]" title={job.errors.join("\n")}>
                {" "}
                · {job.errors.length} failed
              </span>
            )}
          </p>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        {!lockModel && (
          <Segmented
            options={MODELS}
            value={model}
            onChange={(v) => {
              setModel(v);
              setMonth("");
            }}
          />
        )}
        {STRATEGY_SPECS[model] &&
          STRATEGY_SPECS[model].dims.map((d) => (
            <div key={d.key} className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">{d.label}</span>
              <Segmented
                options={d.options}
                value={specParts[model][d.key]}
                onChange={(v) => setSpecParts((all) => ({ ...all, [model]: { ...all[model], [d.key]: v } }))}
              />
            </div>
          ))}
        {model === "kbdt" && (
          <>
            <div className="flex items-center gap-2" title="Exit at 15:15 on this trading day unless the stop is hit first">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Exit</span>
              <Segmented options={KBDT_EXITS} value={kbdtParts.exit} onChange={(exit) => setKbdtParts({ ...kbdtParts, exit })} />
            </div>
            <div
              className="flex items-center gap-2"
              title="Previous day: the model's stop (previous day's low for longs, high for shorts). Fixed: the stop sits this % from entry instead. Capped: the model stop, but never further than this %."
            >
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Stop</span>
              <Segmented options={KBDT_STOP_MODES} value={kbdtParts.mode} onChange={(mode) => setKbdtParts({ ...kbdtParts, mode })} />
              {kbdtParts.mode !== "model" && (
                <Segmented options={KBDT_STOP_PCTS} value={kbdtParts.pct} onChange={(pct) => setKbdtParts({ ...kbdtParts, pct })} />
              )}
            </div>
          </>
        )}
        {model === "orb" && (
          <>
            <div className="flex items-center gap-2" title="Opening range length">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Range</span>
              <Segmented options={RANGE_BARS} value={orbParts.bars} onChange={(bars) => setOrbParts({ ...orbParts, bars })} />
            </div>
            <div className="flex items-center gap-2" title="Stop: the tighter of the opposite range side and this ATR multiple">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Stop</span>
              <Segmented options={STOP_ATR} value={orbParts.atr} onChange={(atr) => setOrbParts({ ...orbParts, atr })} />
            </div>
            <div className="flex items-center gap-2" title="Skip trades whose stop is closer than this percent of price">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Min stop</span>
              <Segmented
                options={MIN_RISK}
                value={orbParts.minRisk}
                onChange={(minRisk) => setOrbParts({ ...orbParts, minRisk })}
              />
            </div>
            {variantId(orbParts) === variantId(LIVE) ? (
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-[#9b968c]">live settings</span>
            ) : (
              <button
                type="button"
                onClick={() => setOrbParts(LIVE)}
                className="rounded border border-[#2c313a] px-2 py-0.5 text-xs text-[#c8c3b8] hover:bg-white/5"
              >
                Reset to live
              </button>
            )}
          </>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          options={DATASETS}
          value={dataset}
          onChange={(v) => {
            setDataset(v);
            setMonth("");
          }}
        />
        <div title="Max trades per day across the dataset; first by entry time, ties go to the tighter stop">
          <Segmented options={CAPS} value={maxPerDay} onChange={setMaxPerDay} />
        </div>
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
        <div className="flex items-center gap-2" title="Show results in risk units or in rupees for one lot per trade">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Show</span>
          <Segmented options={UNITS} value={unit} onChange={setUnit} />
        </div>
        {loading && <span className="font-mono text-xs text-[#6f6a62]">Loading…</span>}
      </div>

      {error && <p className="mb-4 text-sm text-[#f0b4b4]">{error}</p>}
      {!error && !loading && !s && (
        <p className="rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-10 text-center text-sm text-[#9b968c]">
          No backtest yet. Click Update data to download 5 years of data and run it.
        </p>
      )}

      {s && (
        <>
          {unit === "rs" && (
            <p className="mb-2 font-mono text-xs text-[#9b968c]">
              One lot per trade at today's lot sizes
              {dataset === "indices" && data.lots?.length
                ? `: ${data.lots.map((l) => `${l.symbol} ${l.lot_size}`).join(" · ")}`
                : " (each stock's current futures lot)"}
              . Lot sizes changed over the 5 years, so older trades are shown as if traded at today's size.
              {s.no_lot_size > 0 && <span className="text-[#f0b4b4]"> {s.no_lot_size} trades have no lot size and count as ₹0.</span>}
            </p>
          )}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Trades" value={s.trades} title={`${s.long} long · ${s.short} short · ${s.days} days`} />
            <Stat
              label="Win rate"
              value={`${s.win_rate}%`}
              title={`After costs. Before costs: ${s.win_rate_gross}%`}
            />
            {unit === "rs" ? (
              <>
                <Stat label="Gross ₹" value={formatRs(s.gross_rs)} className={rClass(s.gross_rs)} title="Before costs" />
                <Stat label="Avg cost" value={formatRs(-s.avg_cost_rs)} title="Charges + slippage per trade, one lot" />
                <Stat label="Net ₹" value={formatRs(s.net_rs)} className={rClass(s.net_rs)} />
                <Stat label="Net / trade" value={formatRs(s.avg_net_rs)} className={rClass(s.avg_net_rs)} />
                <Stat
                  label="Risk / trade"
                  value={`₹${s.median_risk_rs.toLocaleString("en-IN")}`}
                  title="Median loss if the stop is hit (1R), one lot"
                />
                <Stat
                  label="Max drawdown"
                  value={formatRs(s.max_drawdown_rs)}
                  className="text-[#f0b4b4]"
                  title="Largest peak-to-trough fall in cumulative net rupees, one lot per trade"
                />
              </>
            ) : (
              <>
                <Stat label="Gross R" value={formatR(s.gross_r, 1)} className={rClass(s.gross_r)} title="Before costs" />
                <Stat label="Avg cost" value={`−${s.avg_cost_r.toFixed(2)}R`} title="Charges + slippage per trade, in R" />
                <Stat label="Net R" value={formatR(s.net_r, 1)} className={rClass(s.net_r)} />
                <Stat label="Net / trade" value={formatR(s.avg_net_r)} className={rClass(s.avg_net_r)} />
                <Stat
                  label="Profit factor"
                  value={s.profit_factor ?? "—"}
                  className={s.profit_factor >= 1 ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}
                  title="Net winning R ÷ net losing R"
                />
                <Stat
                  label="Max drawdown"
                  value={formatR(s.max_drawdown_r, 1)}
                  className="text-[#f0b4b4]"
                  title={`Largest peak-to-trough fall in cumulative net R. t-stat of net R per trade: ${s.t_stat ?? "—"}`}
                />
              </>
            )}
          </div>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {unit === "rs" ? "Cumulative ₹ (one lot per trade)" : "Cumulative R"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">
                <span className="text-[#e2c08a]">—</span> net · <span className="text-[#6f6a62]">—</span> gross (before
                costs) · t-stat {s.t_stat ?? "—"}
              </p>
            </div>
            <EquityChart equity={data.equity} unit={unit} />
          </section>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {unit === "rs" ? "Net ₹ by month (one lot per trade)" : "Net R by month"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Click a month to open its trades</p>
            </div>
            <MonthGrid months={data.months} years={data.years} selected={month} onSelect={setMonth} unit={unit} />
          </section>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {lockModel ? `All ${MODELS.find(([m]) => m === lockModel)[1]} settings` : "All models and settings"} ·{" "}
                {DATASETS.find(([d]) => d === dataset)[1]}
 · {cap ? `${cap}/day` : "no cap"} · {slippage}% slippage
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Best net per trade first · click a row to open it</p>
            </div>
            <CompareTable rows={compareRows} model={model} variant={variant} onSelect={selectVariant} unit={unit} />
          </section>

          {month && (
            <MonthTradesModal
              month={month}
              summary={data.months.find((m) => m.month === month)}
              trades={monthTrades}
              loading={monthLoading}
              settings={`${MODELS.find(([m]) => m === model)[1]} · ${
                model === "orb"
                  ? variantLabel("orb", { or_bars: orbParts.bars, stop_atr: orbParts.atr, min_risk_pct: orbParts.minRisk })
                  : model === "kbdt"
                    ? variantLabel("kbdt", {
                        hold_days: Number(kbdtParts.exit[0]),
                        stop_mode: kbdtParts.mode,
                        stop_pct: kbdtParts.pct,
                      })
                    : STRATEGY_SPECS[model]
                      ? specLabel(model, variant)
                      : "Live settings"
              } · ${DATASETS.find(([d]) => d === dataset)[1]} · ${cap ? `${cap}/day` : "no cap"} · ${slippage}% slippage`}
              onClose={() => setMonth("")}
            />
          )}
        </>
      )}

      {showInfo && (
        <ModelInfoModal title="How the backtest works" onClose={() => setShowInfo(false)}>
          <BacktestInfo />
        </ModelInfoModal>
      )}
    </div>
  );
}

