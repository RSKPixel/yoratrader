import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import ModelInfoModal, { InfoButton, PairsInfo, QmomInfo, XsmomInfo, XsmrInfo } from "./ModelInfoModal";
import { formatRs, Segmented, SLIPPAGE, Stat } from "./backtestShared";

// Portfolio-return backtests from Chan's book: cross-sectional mean reversion (ch. 4) and pairs
// trading (ch. 2-4). Both are market-neutral books, so results are daily % returns on capital,
// summed at a fixed size, not R per trade.

const DATASETS = [
  ["fno", "All F&O stocks"],
  ["stocks", "Nifty 50 stocks"],
];
const VERSIONS = [
  ["intraday", "Intraday"],
  ["daily", "Daily"],
];
const ENTRIES = [
  ["0915", "09:15 (book)"],
  ["0916", "09:16"],
  ["0930", "09:30"],
  ["0945", "09:45"],
];
const XSMR_STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];
const XSMR_TAKES = [
  ["all", "All (book)"],
  ["top5", "5 + 5"],
  ["top3", "3 + 3"],
  ["top1", "1 + 1"],
];
const PAIR_METHODS = [
  ["bollinger", "Bollinger"],
  ["kalman", "Kalman filter"],
];
const PAIR_FILLS = [
  ["close", "Signal close (book)"],
  ["next", "Next close"],
];
const PAIR_TAKES = [
  ["all", "All (book)"],
  ["top10", "Top 10"],
  ["top5", "Top 5"],
];
const MOM_FILLS = [
  ["book", "Signal close (book)"],
  ["next", "Next close"],
];
const QM_VERSIONS = [
  ["book", "Momentum + FIP (book)"],
  ["generic", "Momentum only"],
  ["monthly", "Monthly"],
  ["universe", "All stocks (benchmark)"],
];
const MOM_TAKES = [
  ["all", "Top / bottom 10% (book)"],
  ["top5", "5 + 5"],
  ["top1", "1 + 1"],
];
const UNITS = [
  ["pct", "%"],
  ["rs", "₹"],
];
// Cross-sectional books can also be shown as one futures lot per stock (today's lot sizes).
const UNITS_LOTS = [...UNITS, ["lots", "1 lot / stock"]];
// Gross exposure (long + short) the rupee figures are scaled to.
const CAPITALS = [
  [500000, "₹5L"],
  [1000000, "₹10L"],
  [2500000, "₹25L"],
  [5000000, "₹50L"],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtPct = (v, digits = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(digits)}%`);
// Short rupees for the month grid: 1.2L, 45k.
function compactRs(value) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${Math.round(abs / 1000)}k`;
  return `${sign}${Math.round(abs)}`;
}

// A % of gross exposure shown as % or as rupees at the chosen capital.
function makeFmt(unit, capital) {
  // "lots": the API sends rupees in the "_pct" fields (rupees / 100 stored, x100 in the stats), so
  // values are shown as they are.
  if (unit === "lots")
    return {
      big: (v) => (v == null ? "—" : formatRs(v)),
      cell: (v) => compactRs(v),
      bps: (bps) => formatRs(bps / 100),
      axis: (v) => `₹${(v / 100000).toFixed(1)}L`,
    };
  const rs = (pct) => (pct * capital) / 100;
  return {
    big: (pct, digits = 1) => (pct == null ? "—" : unit === "rs" ? formatRs(rs(pct)) : fmtPct(pct, digits)),
    cell: (pct) => (unit === "rs" ? compactRs(rs(pct)) : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}`),
    bps: (bps) => (unit === "rs" ? formatRs((bps / 10000) * capital) : `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps).toFixed(1)} bps`),
    axis: (pct) => (unit === "rs" ? `₹${(rs(pct) / 100000).toFixed(1)}L` : `${pct.toFixed(0)}%`),
  };
}

const pctClass = (v) => (v == null ? "" : v > 0 ? "text-[#8fbf9f]" : v < 0 ? "text-[#f0b4b4]" : "");

function cellStyle(value, scale) {
  if (value == null || !scale) return undefined;
  const alpha = Math.min(0.55, 0.1 + (Math.abs(value) / scale) * 0.45);
  return { backgroundColor: value >= 0 ? `rgba(8,153,129,${alpha})` : `rgba(242,54,69,${alpha})` };
}

function EquityChart({ equity, fmt }) {
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
    const format = { type: "custom", formatter: fmt.axis };
    const gross = chart.addSeries(LineSeries, { color: "#6f6a62", lineWidth: 1, priceLineVisible: false, priceFormat: format });
    gross.setData(equity.map((p) => ({ time: p.date, value: p.gross })));
    const net = chart.addSeries(LineSeries, { color: "#e2c08a", lineWidth: 2, priceLineVisible: false, priceFormat: format });
    net.setData(equity.map((p) => ({ time: p.date, value: p.net })));
    net.createPriceLine({ price: 0, color: "#6f6a62", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [equity, fmt]);
  return <div ref={container} className="h-72 w-full" />;
}

function MonthGrid({ months, years, fmt, selected, onSelect }) {
  const byMonth = useMemo(() => Object.fromEntries(months.map((m) => [m.month, m])), [months]);
  const scale = useMemo(() => Math.max(0.5, ...months.map((m) => Math.abs(m.net_pct))), [months]);
  const yearScale = useMemo(() => Math.max(1, ...years.map((y) => Math.abs(y.net_pct))), [years]);
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
                const m = byMonth[`${y.year}-${String(i + 1).padStart(2, "0")}`];
                return (
                  <td key={i} className="p-0">
                    {m ? (
                      <button
                        type="button"
                        onClick={() => onSelect(m.month === selected ? null : m.month)}
                        title={`${m.trades} trades · ${m.win_rate ?? "—"}% win · net ${fmt.big(m.net_pct, 2)} · gross ${fmt.big(m.gross_pct, 2)} · click for the days`}
                        style={cellStyle(m.net_pct, scale)}
                        className={`block w-full cursor-pointer rounded px-1 py-1.5 text-center text-[#e7e4dc] hover:ring-1 hover:ring-[#e2c08a]/60 ${
                          m.month === selected ? "ring-2 ring-[#e2c08a]" : ""
                        }`}
                      >
                        {fmt.cell(m.net_pct)}
                      </button>
                    ) : (
                      <span className="block px-1 py-1.5 text-center text-[#3a3f48]">·</span>
                    )}
                  </td>
                );
              })}
              <td className="rounded px-2 py-1.5 text-center text-[#e7e4dc]" style={cellStyle(y.net_pct, yearScale)}>
                {fmt.big(y.net_pct)}
              </td>
              <td className="px-2 py-1 text-center text-[#9b968c]">{y.trades}</td>
              <td className="px-2 py-1 text-center text-[#9b968c]">{y.win_rate == null ? "—" : `${y.win_rate}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayTrades({ trades, loading, model }) {
  if (loading) return <p className="px-3 py-2 font-mono text-xs text-[#6f6a62]">Loading trades…</p>;
  if (!trades.length) return <p className="px-3 py-2 font-mono text-xs text-[#6f6a62]">No trades stored for this day.</p>;
  const longs = trades.filter((t) => t.side === "long").length;
  const hasStop = trades.some((t) => t.stop != null);
  const stopped = trades.filter((t) => t.stopped).length;
  return (
    <div className="max-h-96 overflow-auto px-3 py-2">
      <p className="mb-1 font-mono text-[0.7rem] text-[#9b968c]">
        {trades.length} stocks · {longs} long · {trades.length - longs} short · weight = share of {model === "qmom" ? "capital" : "gross exposure"} ·
        {model === "qmom"
          ? `signal = 12-to-1-month return at the ${trades[0]?.ranked} rebalance · FIP: lower = smoother · entry/exit = previous close/this close`
          : model === "xsmom"
          ? "signal = 12-month return when ranked · entry/exit = previous close/this close"
          : "signal = the move the model fades"}{" "}
        {hasStop && ` · ${stopped} stopped out (exit at the stop)`} · sorted by contribution
      </p>
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[#181b20] text-left uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Stock", "Side", "Weight", "Signal", ...(model === "qmom" ? ["FIP"] : []), "Entry", ...(hasStop ? ["Stop"] : []), "Exit", "Move", "Contribution", "Lot", "1 lot ₹"].map((h) => (
              <th key={h} className="px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#23272e] whitespace-nowrap font-mono">
          {trades.map((t) => (
            <tr key={t.symbol}>
              <td className="px-2 py-1 text-[#e7e4dc]">{t.symbol}</td>
              <td className={`px-2 py-1 ${t.side === "long" ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>{t.side}</td>
              <td className="px-2 py-1 text-[#9b968c]">{t.weight_pct.toFixed(2)}%</td>
              <td className={`px-2 py-1 ${pctClass(t.signal_pct)}`}>{fmtPct(t.signal_pct, model === "xsmom" || model === "qmom" ? 1 : 2)}</td>
              {model === "qmom" && <td className="px-2 py-1 text-[#9b968c]">{t.fip ?? "—"}</td>}
              <td className="px-2 py-1 text-[#c8c3b8]">{t.entry}</td>
              {hasStop && <td className="px-2 py-1 text-[#f0b4b4]">{t.stop ?? "—"}</td>}
              <td className={`px-2 py-1 ${t.stopped ? "text-[#f0b4b4]" : "text-[#c8c3b8]"}`}>
                {t.exit}
                {t.stopped && " · stop"}
              </td>
              <td className={`px-2 py-1 ${pctClass(t.move_pct)}`}>{fmtPct(t.move_pct, 2)}</td>
              <td className={`px-2 py-1 ${pctClass(t.contribution_bps)}`}>
                {t.contribution_bps > 0 ? "+" : ""}
                {t.contribution_bps.toFixed(2)} bps
              </td>
              <td className="px-2 py-1 text-[#9b968c]">{t.lot_size ?? "—"}</td>
              <td className={`px-2 py-1 ${pctClass(t.pnl_rs)}`}>{t.pnl_rs == null ? "—" : formatRs(t.pnl_rs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthModal({ month, settings, onClose, children }) {
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border border-[#2c313a] px-2 py-0.5 text-sm text-[#c8c3b8] hover:bg-white/5"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function MonthDays({ month, days, loading, fmt, onClose, variant, dataset, model }) {
  const [openDay, setOpenDay] = useState(null);
  const [trades, setTrades] = useState({ rows: [], loading: false });
  useEffect(() => setOpenDay(null), [month, variant, dataset]);
  useEffect(() => {
    if (!openDay) return undefined;
    const controller = new AbortController();
    setTrades({ rows: [], loading: true });
    fetch(`/api/backtest/portfolio/day?model=${model}&day=${openDay}&variant=${variant}&dataset=${dataset}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((payload) => setTrades({ rows: payload.status === "success" ? payload.trades : [], loading: false }))
      .catch(() => {});
    return () => controller.abort();
  }, [openDay, variant, dataset, model]);
  const total = days.reduce((a, d) => a + d.net_pct, 0);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#9b968c]">
          {days.length} days · net {fmt.big(total, 2)} · click a day for its trades
        </p>
      </div>
      {loading ? (
        <p className="font-mono text-xs text-[#6f6a62]">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Day", "Long side", "Short side", "Gross", "Cost", "Net", "Stocks"].map((h) => (
                  <th key={h} className="px-3 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
              {days.map((d) => [
                <tr
                  key={d.day}
                  onClick={() => setOpenDay(openDay === d.day ? null : d.day)}
                  className={`cursor-pointer ${openDay === d.day ? "bg-[#e2c08a]/10" : "hover:bg-white/[0.03]"}`}
                >
                  <td className="px-3 py-1.5 text-[#e7e4dc]">
                    <span className="mr-1 text-[#6f6a62]">{openDay === d.day ? "▾" : "▸"}</span>
                    {d.day}
                  </td>
                  <td className={`px-3 py-1.5 ${pctClass(d.long_pct)}`}>{fmt.big(d.long_pct, 2)}</td>
                  <td className={`px-3 py-1.5 ${pctClass(d.short_pct)}`}>{fmt.big(d.short_pct, 2)}</td>
                  <td className={`px-3 py-1.5 ${pctClass(d.gross_pct)}`}>{fmt.big(d.gross_pct, 2)}</td>
                  <td className="px-3 py-1.5 text-[#9b968c]">{fmt.big(-d.cost_pct, 2)}</td>
                  <td className={`px-3 py-1.5 ${pctClass(d.net_pct)}`}>{fmt.big(d.net_pct, 2)}</td>
                  <td className="px-3 py-1.5 text-[#9b968c]">{d.stocks}</td>
                </tr>,
                openDay === d.day && (
                  <tr key={`${d.day}-trades`}>
                    <td colSpan={7} className="bg-[#14161a] p-0">
                      <DayTrades trades={trades.rows} loading={trades.loading} model={model} />
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CompareTable({ rows, variant, onSelect, fmt }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Version", "Gross / yr", "Cost / day", "Net / yr", "Net Sharpe", "Max drawdown", "Win days", "Green years"].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
          {rows.map((r) => (
            <tr
              key={r.variant}
              onClick={() => onSelect(r.variant)}
              className={`cursor-pointer ${r.variant === variant ? "bg-[#e2c08a]/10" : "hover:bg-white/[0.03]"}`}
            >
              <td className="px-3 py-2 text-[#e7e4dc]">
                {r.label}
                {!r.book && <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[0.65rem] text-[#9b968c]">fill check</span>}
              </td>
              <td className={`px-3 py-2 ${pctClass(r.gross.ann_return_pct)}`}>{fmt.big(r.gross.ann_return_pct)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{fmt.bps(-r.avg_cost_bps)}</td>
              <td className={`px-3 py-2 ${pctClass(r.net.ann_return_pct)}`}>{fmt.big(r.net.ann_return_pct)}</td>
              <td className={`px-3 py-2 ${pctClass(r.net.sharpe)}`}>{r.net.sharpe ?? "—"}</td>
              <td className="px-3 py-2 text-[#f0b4b4]">{fmt.big(r.net.max_dd_pct)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{r.net.win_days_pct}%</td>
              <td className="px-3 py-2 text-[#9b968c]">
                {r.green_years}/{r.years}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PairMonthTrades({ month, trades, loading, fmt, onClose }) {
  const total = trades.reduce((a, t) => a + t.book_pct, 0);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#9b968c]">
          {trades.length} trades closed · net {fmt.big(total, 2)} of the book
        </p>
      </div>
      <p className="mb-1 font-mono text-[0.7rem] text-[#6f6a62]">
        Long the spread = buy y, short x. "On pair" is the return on that pair's capital; "of book" is its share of the
        whole account. The month cell also includes P&amp;L of trades still open at month end.
      </p>
      {loading ? (
        <p className="font-mono text-xs text-[#6f6a62]">Loading…</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="sticky top-0 bg-[#181b20] text-left uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Pair (y / x)", "Rank", "Side", "Entry", "Exit", "Days", "Gross on pair", "Net on pair", "Net of book"].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#23272e] whitespace-nowrap font-mono">
              {trades.map((t, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">
                    {t.y} / {t.x}
                  </td>
                  <td className="px-2 py-1.5 text-[#9b968c]">#{t.rank}</td>
                  <td className={`px-2 py-1.5 ${t.side === "long" ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>{t.side}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.entry}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.exit}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.days}</td>
                  <td className={`px-2 py-1.5 ${pctClass(t.gross_pct)}`}>{fmtPct(t.gross_pct, 2)}</td>
                  <td className={`px-2 py-1.5 ${pctClass(t.net_pct)}`}>{fmtPct(t.net_pct, 2)}</td>
                  <td className={`px-2 py-1.5 ${pctClass(t.book_pct)}`}>{fmt.big(t.book_pct, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PairsByYear({ years, variant, slippage }) {
  const [year, setYear] = useState(null);
  const [rows, setRows] = useState({ pairs: [], loading: false });
  const active = year ?? years[years.length - 1]?.year;
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    setRows({ pairs: [], loading: true });
    fetch(`/api/backtest/pairs/year?year=${active}&variant=${variant}&slippage=${slippage}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((payload) => setRows({ pairs: payload.status === "success" ? payload.pairs : [], loading: false }))
      .catch(() => {});
    return () => controller.abort();
  }, [active, variant, slippage]);
  const summary = years.find((y) => y.year === active);
  return (
    <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Pairs by year · picked on the year before</p>
        {summary && (
          <p className="font-mono text-xs text-[#9b968c]">
            {summary.pairs} pairs · {summary.traded} traded · {summary.trades} trades · {summary.green} net positive
          </p>
        )}
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {years.map((y) => (
          <button
            key={y.year}
            type="button"
            onClick={() => setYear(y.year)}
            className={`rounded px-2 py-1 font-mono text-xs ${
              y.year === active ? "bg-[#e7e4dc] text-[#14110c]" : "text-[#9b968c] hover:bg-white/5"
            }`}
          >
            {y.year}
          </button>
        ))}
      </div>
      {rows.loading ? (
        <p className="font-mono text-xs text-[#6f6a62]">Loading…</p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full min-w-[860px] text-xs">
            <thead className="sticky top-0 bg-[#181b20] text-left uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Rank", "Pair (y / x)", "Industry", "Hedge", "Test t", "Half-life", "Trades", "Days open", "Gross", "Net"].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#23272e] whitespace-nowrap font-mono">
              {rows.pairs.map((p) => (
                <tr key={`${p.y}-${p.x}`}>
                  <td className="px-2 py-1.5 text-[#9b968c]">#{p.rank}</td>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">
                    {p.y} / {p.x}
                    {p.stopped && (
                      <span title={`Stopped ${p.stopped}: a move over 20% or a missing price`} className="ml-2 rounded bg-[#f0b4b4]/15 px-1.5 py-0.5 text-[0.65rem] text-[#f0b4b4]">
                        stopped
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{p.industry}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{p.hedge}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{p.tstat}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{p.half_life} d</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{p.trades}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{p.days_open}</td>
                  <td className={`px-2 py-1.5 ${pctClass(p.gross_pct)}`}>{fmtPct(p.gross_pct, 2)}</td>
                  <td className={`px-2 py-1.5 ${pctClass(p.net_pct)}`}>{fmtPct(p.net_pct, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 font-mono text-[0.7rem] text-[#6f6a62]">
        Gross and net are on the pair's own capital for the year. Hedge: shares of x per share of y (Bollinger). Test t:
        the Engle–Granger statistic in the pick year; more negative = stronger.
      </p>
    </section>
  );
}

const PAGES = {
  xsmr: {
    title: "Cross-sectional mean reversion",
    blurb:
      "Market-neutral: every day, long the stocks that lagged and short the ones that led, in proportion to the move. Returns are % of gross exposure, summed at a fixed size.",
    info: XsmrInfo,
  },
  xsmom: {
    title: "Cross-sectional momentum",
    blurb:
      "Market-neutral: every day, buy the stocks with the best 12-month return and short the worst, each day's picks held 25 trading days (25 overlapping books). Returns are % of gross exposure, summed at a fixed size.",
    info: XsmomInfo,
  },
  qmom: {
    title: "Quantitative momentum",
    blurb:
      "Long only (Gray & Vogel): every quarter, buy the F&O stocks with the best 12-to-1-month return whose climb was smoothest, equal weight, held three months. Returns are % of capital, summed at a fixed size.",
    info: QmomInfo,
  },
  pairs: {
    title: "Pairs trading",
    blurb:
      "Same-industry F&O pairs that passed a cointegration test on last year's prices, traded this year when their spread stretches. Returns are % of total capital, split equally across the year's pairs.",
    info: PairsInfo,
  },
};

export default function PortfolioBacktestPage({ model = "xsmr" }) {
  const page = PAGES[model];
  const isPairs = model === "pairs";
  const isMom = model === "xsmom";
  const isQm = model === "qmom";
  const [momFill, setMomFill] = useState("book");
  const [qmVersion, setQmVersion] = useState("book");
  const [version, setVersion] = useState("intraday");
  const [entry, setEntry] = useState("0915");
  const [stop, setStop] = useState("none");
  const [dataset, setDataset] = useState("fno");
  const [take, setTake] = useState("all");
  const [method, setMethod] = useState("bollinger");
  const [fill, setFill] = useState("close");
  const [slippage, setSlippage] = useState(0.02);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [unit, setUnit] = useState("rs");
  const [capital, setCapital] = useState(1000000);
  const lots = unit === "lots";
  // Format by what the loaded data is, so a switch never shows % numbers as rupees mid-load.
  const shownUnit = data ? (data.lotsMode ? "lots" : unit === "lots" ? "pct" : unit) : unit;
  const fmt = useMemo(() => makeFmt(shownUnit, capital), [shownUnit, capital]);

  const base = isQm ? qmVersion : isMom ? momFill : isPairs ? `${method}${fill === "next" ? "-next" : ""}` : version === "daily" ? "daily" : `intraday-${entry}${entry === "0915" && stop === "1sd" ? "-1sd" : ""}`;
  const variant = take === "all" ? base : `${base}-${take}`;
  const [month, setMonth] = useState(null);
  const [monthRows, setMonthRows] = useState({ rows: [], loading: false });

  useEffect(() => {
    if (!month) return undefined;
    const controller = new AbortController();
    setMonthRows({ rows: [], loading: true });
    fetch(`/api/backtest/portfolio/month?model=${model}&month=${month}&variant=${variant}&dataset=${dataset}&slippage=${slippage}&lots=${lots}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((payload) =>
        setMonthRows({ rows: payload.status === "success" ? payload.days || payload.trades : [], loading: false }),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [model, month, variant, dataset, slippage, lots]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/backtest/portfolio?model=${model}&variant=${variant}&dataset=${dataset}&slippage=${slippage}&lots=${lots}`)
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || payload.detail || "Could not load the backtest");
          return;
        }
        setError("");
        setData({ ...payload, lotsMode: lots });
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setLoading(false));
  }, [model, variant, dataset, slippage, lots]);

  const selectVariant = (v) => {
    const b = take === "all" ? v : v.slice(0, -(take.length + 1));
    if (isQm) setQmVersion(b);
    else if (isMom) setMomFill(b);
    else if (isPairs) {
      setMethod(b.split("-")[0]);
      setFill(b.endsWith("-next") ? "next" : "close");
    } else if (b === "daily") setVersion("daily");
    else {
      setVersion("intraday");
      setEntry(b.split("-")[1]);
      setStop(b.endsWith("-1sd") ? "1sd" : "none");
    }
  };

  const s = data?.summary;
  const capitalLabel = CAPITALS.find(([c]) => c === capital)[1];
  const Info = page.info;
  const unitSign = shownUnit === "pct" ? "%" : "₹";
  const variantLabel = data?.compare?.find((r) => r.variant === variant)?.label;
  const monthSettings = [
    page.title,
    variantLabel,
    !isPairs && DATASETS.find(([d]) => d === dataset)[1],
    `${slippage}% slippage`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Backtest · {page.title}</h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How this backtest works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">{page.blurb}</p>
        </div>
        {s && (
          <p className="font-mono text-xs text-[#6f6a62]">
            {s.from} → {s.to} · {s.days} days · ~{s.avg_stocks} {isPairs ? "pairs open" : "stocks"} a day
          </p>
        )}
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        {isPairs ? (
          <>
            <div className="flex items-center gap-2" title="Bollinger: fixed hedge, z-score over the half-life. Kalman filter: hedge re-estimated daily.">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Method</span>
              <Segmented options={PAIR_METHODS} value={method} onChange={setMethod} />
            </div>
            <div className="flex items-center gap-2" title="The book trades at the close the signal is computed from; next close is the fill check.">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Fill</span>
              <Segmented options={PAIR_FILLS} value={fill} onChange={setFill} />
            </div>
          </>
        ) : isQm ? (
          <div
            className="flex items-center gap-2"
            title="Book: top 10% by 12-to-1-month return, then the smoother half by FIP, rebalanced at the end of Feb/May/Aug/Nov. Momentum only drops the FIP filter; Monthly rebalances every month; All stocks is the equal-weight benchmark."
          >
            <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Version</span>
            <Segmented options={QM_VERSIONS} value={qmVersion} onChange={setQmVersion} />
          </div>
        ) : isMom ? (
          <div className="flex items-center gap-2" title="The book trades at the close the ranking is computed from; next close is the fill check.">
            <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Fill</span>
            <Segmented options={MOM_FILLS} value={momFill} onChange={setMomFill} />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2" title="Intraday: signal previous close → open, held open → 15:15. Daily: signal last 15:15 → 15:15, held to the next 15:15.">
              <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Version</span>
              <Segmented options={VERSIONS} value={version} onChange={setVersion} />
            </div>
            {version === "intraday" && (
              <div
                className="flex items-center gap-2"
                title="The book enters at the 09:15 open (the opening-auction price). 09:16, 09:30 and 09:45 keep the same signal and enter later: a check on how much of the result depends on the auction fill."
              >
                <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Entry</span>
                <Segmented options={ENTRIES} value={entry} onChange={setEntry} />
              </div>
            )}
            {version === "intraday" && entry === "0915" && (
              <div
                className="flex items-center gap-2"
                title="None is the book's rule (exit only at 15:15). 1σ: as in Buy on gap, a stop one standard deviation of the stock's last 90 daily returns from entry; hit on the 15m candles to 15:15, out at the stop price. Same positions either way."
              >
                <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Stop</span>
                <Segmented options={XSMR_STOPS} value={stop} onChange={setStop} />
              </div>
            )}
          </>
        )}
        {!isQm && (
        <div
          className="flex items-center gap-2"
          title={
            isMom
              ? "Top / bottom 10%: the book (about 22 stocks a side on the F&O list, 5 on the Nifty 50). 5 + 5 / 1 + 1: only the strongest and weakest each day."
              : isPairs
              ? "All: every selected pair (the book). Top 10 / 5: only the pairs with the strongest cointegration test, fixed before the year."
              : "All: every stock with linear weights (the book). 5 + 5 / 3 + 3 / 1 + 1: only the stocks furthest from the average move per side, equal rupees each."
          }
        >
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Take</span>
          <Segmented options={isMom ? MOM_TAKES : isPairs ? PAIR_TAKES : XSMR_TAKES} value={take} onChange={setTake} />
        </div>
        )}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {!isPairs && <Segmented options={DATASETS} value={dataset} onChange={setDataset} />}
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
        <div className="flex items-center gap-2" title="Show results as % of capital, or in rupees for the chosen capital">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Show</span>
          <Segmented options={isPairs ? UNITS : UNITS_LOTS} value={unit} onChange={setUnit} />
        </div>
        {unit === "rs" && (
          <div className="flex items-center gap-2" title={isPairs ? "Total capital, split equally across the year's pairs" : isQm ? "Capital, fully invested long, the same every day" : "Gross exposure: half long, half short, the same every day"}>
            <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Capital</span>
            <Segmented options={CAPITALS} value={capital} onChange={setCapital} />
          </div>
        )}
        {loading && <span className="font-mono text-xs text-[#6f6a62]">Loading…</span>}
      </div>

      {error && <p className="mb-4 text-sm text-[#f0b4b4]">{error}</p>}
      {!error && !loading && !s && (
        <p className="rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-10 text-center text-sm text-[#9b968c]">No results stored yet.</p>
      )}

      {s && (
        <>
          {shownUnit === "lots" && data.lots && (
            <p className="mb-2 font-mono text-xs text-[#9b968c]">
              One futures lot of every stock the book holds, at today's lot sizes (older years use today's lot with that
              year's price, so they are smaller in rupees). ~{data.lots.avg_positions} lots held a day. Value of the lots
              held (long + short): {data.lots.recent_year} average {formatRs(data.lots.recent_notional)}, peak{" "}
              {formatRs(data.lots.max_notional)}; the margin needed is a fraction of that.
              {isMom && " The 25 overlapping slices collapse to one lot per stock, so this is not the equal-weight book."}
            </p>
          )}
          {shownUnit === "rs" && (
            <p className="mb-2 font-mono text-xs text-[#9b968c]">
              {isPairs
                ? `${capitalLabel} capital split equally across the year's pairs (${data.take_n ? `${data.take_n}` : "all selected"}), ~${s.avg_stocks} open on an average day.`
                : isQm
                ? `${capitalLabel} invested long every day, spread over ~${s.avg_stocks} stocks.`
                : `${capitalLabel} gross exposure every day: half long, half short, spread over ~${s.avg_stocks} stocks.`}{" "}
              Rupees are the % results scaled to that size, not compounded.
            </p>
          )}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat
              label="Trades"
              value={s.trades.toLocaleString("en-IN")}
              title={isPairs ? `Pair trades closed · ${s.days} days` : `One trade = one day's book (${s.days} days, ~${s.avg_stocks} stocks a day)`}
            />
            <Stat label="Win rate" value={`${s.win_rate}%`} title={`After costs. Before costs: ${s.win_rate_gross}%`} />
            <Stat label={`Gross ${unitSign}`} value={fmt.big(s.gross_total_pct)} className={pctClass(s.gross_total_pct)} title={`Before costs. ${s.gross.ann_return_pct}% a year`} />
            <Stat label="Avg cost" value={fmt.big(-s.avg_cost_pct, 3)} title={`Charges + slippage per trade (${data.cost_per_side_bps} bps per side)`} />
            <Stat label={`Net ${unitSign}`} value={fmt.big(s.net_total_pct)} className={pctClass(s.net_total_pct)} title={`${s.net.ann_return_pct}% a year · Sharpe ${s.net.sharpe ?? "—"}`} />
            <Stat label="Net / trade" value={fmt.big(s.avg_net_pct, 3)} className={pctClass(s.avg_net_pct)} />
            <Stat
              label="Profit factor"
              value={s.profit_factor ?? "—"}
              className={s.profit_factor >= 1 ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}
              title={isPairs ? "Net winning trades ÷ net losing trades" : "Net winning days ÷ net losing days"}
            />
            <Stat label="Max drawdown" value={fmt.big(s.net.max_dd_pct)} className="text-[#f0b4b4]" title="Largest peak-to-trough fall in cumulative net, at a fixed size" />
          </div>
          <p className="-mt-2 mb-4 font-mono text-xs text-[#6f6a62]">
            {fmt.big(s.net.ann_return_pct)} net a year · Sharpe {s.net.sharpe ?? "—"} · {s.green_years}/{s.years} green years · gross bps a day: long {s.long_bps}, short {s.short_bps}
          </p>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {shownUnit === "lots" ? "Net ₹ by month (1 lot / stock)" : shownUnit === "rs" ? `Net ₹ by month (${capitalLabel})` : "Net % by month"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Click a month to open its trades</p>
            </div>
            <MonthGrid months={data.months} years={data.years} fmt={fmt} selected={month} onSelect={setMonth} />
          </section>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {shownUnit === "lots" ? "Cumulative ₹ (1 lot / stock, weekly)" : shownUnit === "rs" ? "Cumulative ₹ (fixed size, weekly)" : "Cumulative % (fixed size, weekly)"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">
                <span className="text-[#e2c08a]">—</span> net · <span className="text-[#6f6a62]">—</span> gross (before costs)
              </p>
            </div>
            <EquityChart equity={data.equity} fmt={fmt} />
          </section>

          {isPairs && data.pair_years?.length > 0 && <PairsByYear years={data.pair_years} variant={variant} slippage={slippage} />}

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                All versions · {isPairs ? PAIR_TAKES.find(([t]) => t === take)[1] : isQm ? DATASETS.find(([d]) => d === dataset)[1] : `${DATASETS.find(([d]) => d === dataset)[1]} · ${(isMom ? MOM_TAKES : XSMR_TAKES).find(([t]) => t === take)[1]}`} ·{" "}
                {slippage}% slippage
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Click a row to open it</p>
            </div>
            <CompareTable rows={data.compare} variant={variant} onSelect={selectVariant} fmt={fmt} />
          </section>
        </>
      )}

      {month && (
        <MonthModal month={month} settings={monthSettings} onClose={() => setMonth(null)}>
          {isPairs ? (
            <PairMonthTrades month={month} trades={monthRows.rows} loading={monthRows.loading} fmt={fmt} onClose={() => setMonth(null)} />
          ) : (
            <MonthDays
              month={month}
              days={monthRows.rows}
              loading={monthRows.loading}
              fmt={fmt}
              onClose={() => setMonth(null)}
              variant={variant}
              dataset={dataset}
              model={model}
            />
          )}
        </MonthModal>
      )}

      {showInfo && (
        <ModelInfoModal title={`${page.title} · how it works`} onClose={() => setShowInfo(false)}>
          <Info />
        </ModelInfoModal>
      )}
    </div>
  );
}
