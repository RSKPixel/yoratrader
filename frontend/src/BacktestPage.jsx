import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import ModelInfoModal, { BacktestInfo, GapBacktestInfo, GapMomentumInfo, InfoButton } from "./ModelInfoModal";
import { formatR, formatRs, KBDT_EXITS, KBDT_STOP_MODES, KBDT_STOP_PCTS, rClass, Segmented, SLIPPAGE, Stat } from "./backtestShared";

const ALL_DATASETS = [
  ["indices", "F&O indices"],
  ["stocks", "Nifty 50 stocks"],
  ["fno", "All F&O stocks"],
];
// KBDT isn't run on the full F&O stock list (its day-by-day replay is too slow for ~180 symbols).
const MODEL_DATASETS = { kbdt: ["indices", "stocks"], gap: ["indices", "stocks", "fno"], gapmom: ["indices", "fno"] };

const MODEL_NAMES = { kbdt: "Key Breakout Dow Theory", gap: "Buy on gap", gapmom: "Opening gap momentum" };

// Buy-on-gap variant id: "<threshold>sd-top<N>-<sides>-<stop>-<hold>", e.g. "1sd-top10-long-none-1d" (Chan's version).
// Threshold (1σ) and exit (same day) are fixed at the book's values; only Take, Side and Stop vary.
const GAP_DIMS = [
  { key: "top", label: "Take", options: [["5", "Top 5"], ["10", "Top 10"]], title: "Biggest gaps of the day across the dataset" },
  { key: "sides", label: "Side", options: [["long", "Long only"], ["both", "Long & short"]], title: "Long & short also sells opens above the previous high, below the 20-day average" },
  { key: "stop", label: "Stop", options: [["none", "None"], ["1sd", "1σ"]], title: "None is the book's rule (exit only at 15:15). 1σ: stop one standard deviation from entry. Either way 1R = 1σ." },
];
const GAP_INITIAL = { threshold: "1", top: "10", sides: "long", stop: "none", hold: "1d" };

// Opening gap momentum (Chan ch. 7): same variant id shape with "all" for top (no ranking);
// the 0.1σ threshold and same-day exit are the book's. Book: both sides, no stop.
const GAPMOM_DIMS = [
  { key: "sides", label: "Side", options: [["both", "Long & short"], ["long", "Long only"]], title: "Long & short is the book's version: buy gap-ups above the previous high, short gap-downs below the previous low" },
  GAP_DIMS[2],
];
const GAPMOM_INITIAL = { threshold: "0.1", top: "all", sides: "both", stop: "none", hold: "1d" };

function gapVariant({ threshold, top, sides, stop, hold }) {
  return `${threshold}sd-${top === "all" ? "all" : `top${top}`}-${sides}-${stop}-${hold}`;
}

function parseGapVariant(id) {
  const [threshold, top, sides, stop, hold] = id.split("-");
  return { threshold: threshold.replace("sd", ""), top: top.replace("top", ""), sides, stop, hold };
}

function gapLabel(params) {
  const stop = params.stop === "none" ? "no stop" : "1σ stop";
  const side = params.sides === "long" ? "long only" : "long & short";
  return params.top == null || params.top === "all" ? `${side} · ${stop}` : `Top ${params.top} · ${side} · ${stop}`;
}

function kbdtVariant({ exit, mode, pct }) {
  return mode === "model" ? exit : `${exit}-${mode}-${pct}`;
}

function parseKbdtVariant(id) {
  const [exit, mode, pct] = id.split("-");
  return { exit, mode: mode || "model", pct: pct ? Number(pct) : 0.75 };
}

function variantLabel(params) {
  if (params.threshold != null) return gapLabel(params);
  const exit = KBDT_EXITS.find(([v]) => v === `${params.hold_days}d`)?.[1].toLowerCase();
  const stop =
    params.stop_mode === "fixed"
      ? `stop ${params.stop_pct}%`
      : params.stop_mode === "cap"
        ? `prev-day stop, max ${params.stop_pct}%`
        : "prev-day stop";
  return `Exit ${exit} · ${stop}`;
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

function CompareTable({ rows, variant, onSelect, unit }) {
  const rs = unit === "rs";
  const sorted = useMemo(() => [...rows].sort((a, b) => b.avg_net_r - a.avg_net_r), [rows]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Settings", "Trades", "Gross / trade", "Cost / trade", "Net / trade", rs ? "Net ₹ / lot" : "Net R", "Profit factor", "t-stat", "Green years"].map(
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
            const active = r.variant === variant;
            return (
              <tr
                key={r.variant}
                onClick={() => onSelect(r.variant)}
                className={`cursor-pointer ${active ? "bg-[#e2c08a]/10" : "hover:bg-white/[0.03]"}`}
              >
                <td className="px-3 py-2 text-[#e7e4dc]">
                  {variantLabel(r.params)}
                  {r.live && (
                    <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[0.65rem] text-[#9b968c]">
                      {r.model === "kbdt" ? "model stop" : "book"}
                    </span>
                  )}
                </td>
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

export default function BacktestPage({ model = "kbdt" }) {
  const isGap = model === "gap" || model === "gapmom";
  const dims = model === "gapmom" ? GAPMOM_DIMS : GAP_DIMS;
  const MODEL_NAME = MODEL_NAMES[model];
  const DATASETS = ALL_DATASETS.filter(([d]) => MODEL_DATASETS[model].includes(d));
  const [kbdtParts, setKbdtParts] = useState({ exit: "5d", mode: "model", pct: 0.75 });
  const [gapParts, setGapParts] = useState(model === "gapmom" ? GAPMOM_INITIAL : GAP_INITIAL);
  const [compareRows, setCompareRows] = useState([]);
  const [dataset, setDataset] = useState(model === "gap" ? "fno" : "indices");
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

  // Buy-on-gap ranks and caps each day itself (top N), so the page cap is off.
  const cap = isGap ? 0 : maxPerDay;
  const variant = isGap ? gapVariant(gapParts) : kbdtVariant(kbdtParts);
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
    fetch(`/api/backtest/orb/compare?${baseQuery}&model=${model}`)
      .then((r) => r.json())
      .then((payload) => setCompareRows(payload.data || []))
      .catch(() => setCompareRows([]));
  }, [baseQuery, model]);

  useEffect(() => {
    loadCompare();
  }, [loadCompare]);

  const selectVariant = (nextVariant) => {
    if (isGap) setGapParts(parseGapVariant(nextVariant));
    else setKbdtParts(parseKbdtVariant(nextVariant));
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
              Backtest · {MODEL_NAME}
            </h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How this backtest works" />
          </div>
          {!isGap && (
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            Key Breakout Dow Theory over NSE cash data for the F&amp;O indices and the Nifty 50 stocks, with 1, 3 or
            5-day holds and the model, fixed or capped stop. Net results are after NSE futures charges and slippage;
            rupees are for one lot at today's lot sizes.
          </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={startDownload}
            disabled={running}
            title="Download 15m and daily data (F&amp;O indices and F&amp;O stocks: daily from 2000, 15m from 2015, as far as Kite has them; Nifty 50 stocks 5 years; only missing bars after the first run), then rerun the backtest"
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

      {isGap ? (
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {dims.map((dim) => (
          <div key={dim.key} className="flex items-center gap-2" title={dim.title}>
            <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">{dim.label}</span>
            <Segmented
              options={dim.options}
              value={gapParts[dim.key]}
              onChange={(v) => {
                setGapParts({ ...gapParts, [dim.key]: v });
                setMonth("");
              }}
            />
          </div>
        ))}
      </div>
      ) : (
      <div className="mb-3 flex flex-wrap items-center gap-3">
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
      </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          options={DATASETS}
          value={dataset}
          onChange={(v) => {
            setDataset(v);
            setMonth("");
          }}
        />
        {!isGap && (
          <div title="Max trades per day across the dataset; first by entry time, ties go to the tighter stop">
            <Segmented options={CAPS} value={maxPerDay} onChange={setMaxPerDay} />
          </div>
        )}
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
          No backtest yet. Click Update data to download the data and run it.
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
              . Lot sizes changed over the years, so older trades are shown as if traded at today's size.
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
                {unit === "rs" ? "Net ₹ by month (one lot per trade)" : "Net R by month"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Click a month to open its trades</p>
            </div>
            <MonthGrid months={data.months} years={data.years} selected={month} onSelect={setMonth} unit={unit} />
          </section>

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
                All {MODEL_NAME} settings ·{" "}
                {DATASETS.find(([d]) => d === dataset)[1]}
 · {cap ? `${cap}/day` : "no cap"} · {slippage}% slippage
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Best net per trade first · click a row to open it</p>
            </div>
            <CompareTable rows={compareRows} variant={variant} onSelect={selectVariant} unit={unit} />
          </section>

          {month && (
            <MonthTradesModal
              month={month}
              summary={data.months.find((m) => m.month === month)}
              trades={monthTrades}
              loading={monthLoading}
              settings={`${MODEL_NAME} · ${
                isGap
                  ? gapLabel(gapParts)
                  : variantLabel({ hold_days: Number(kbdtParts.exit[0]), stop_mode: kbdtParts.mode, stop_pct: kbdtParts.pct })
              } · ${DATASETS.find(([d]) => d === dataset)[1]} · ${cap ? `${cap}/day` : "no cap"} · ${slippage}% slippage`}
              onClose={() => setMonth("")}
            />
          )}
        </>
      )}

      {showInfo && (
        <ModelInfoModal title={isGap ? `${MODEL_NAME} · how it works` : "How the backtest works"} onClose={() => setShowInfo(false)}>
          {model === "gapmom" ? <GapMomentumInfo /> : isGap ? <GapBacktestInfo /> : <BacktestInfo />}
        </ModelInfoModal>
      )}
    </div>
  );
}

