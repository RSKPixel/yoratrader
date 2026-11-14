import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineSeries } from "lightweight-charts";
import ModelInfoModal, { InfoButton, XsmrInfo } from "./ModelInfoModal";
import { formatRs, Segmented, SLIPPAGE, Stat } from "./backtestShared";

// Cross-sectional mean reversion (Chan ch. 4): a market-neutral portfolio, so results are
// daily % returns on gross exposure (long + short), summed at a fixed exposure, not R per trade.

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
const UNITS = [
  ["pct", "%"],
  ["rs", "₹"],
];
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
  const rs = (pct) => (pct * capital) / 100;
  return {
    big: (pct, digits = 1) => (pct == null ? "—" : unit === "rs" ? formatRs(rs(pct)) : fmtPct(pct, digits)),
    cell: (pct) => (unit === "rs" ? compactRs(rs(pct)) : fmtPct(pct)),
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
            <th className="px-2 py-1 font-medium">Win days</th>
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
                        title={`${m.days} days · ${m.win_days_pct}% winning days · net ${fmt.big(m.net_pct, 2)} · gross ${fmt.big(m.gross_pct, 2)} · click for the days`}
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
              <td className="px-2 py-1 text-center text-[#9b968c]">{y.win_days_pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayTrades({ trades, loading }) {
  if (loading) return <p className="px-3 py-2 font-mono text-xs text-[#6f6a62]">Loading trades…</p>;
  if (!trades.length) return <p className="px-3 py-2 font-mono text-xs text-[#6f6a62]">No trades stored for this day.</p>;
  const longs = trades.filter((t) => t.side === "long").length;
  return (
    <div className="max-h-96 overflow-auto px-3 py-2">
      <p className="mb-1 font-mono text-[0.7rem] text-[#9b968c]">
        {trades.length} stocks · {longs} long · {trades.length - longs} short · weight = share of gross exposure ·
        signal = the move the model fades · sorted by contribution
      </p>
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[#181b20] text-left uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Stock", "Side", "Weight", "Signal", "Entry", "Exit", "Move", "Contribution"].map((h) => (
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
              <td className={`px-2 py-1 ${pctClass(t.signal_pct)}`}>{fmtPct(t.signal_pct, 2)}</td>
              <td className="px-2 py-1 text-[#c8c3b8]">{t.entry}</td>
              <td className="px-2 py-1 text-[#c8c3b8]">{t.exit}</td>
              <td className={`px-2 py-1 ${pctClass(t.move_pct)}`}>{fmtPct(t.move_pct, 2)}</td>
              <td className={`px-2 py-1 ${pctClass(t.contribution_bps)}`}>
                {t.contribution_bps > 0 ? "+" : ""}
                {t.contribution_bps.toFixed(2)} bps
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthDays({ month, days, loading, fmt, onClose, variant, dataset }) {
  const [openDay, setOpenDay] = useState(null);
  const [trades, setTrades] = useState({ rows: [], loading: false });
  useEffect(() => setOpenDay(null), [month, variant, dataset]);
  useEffect(() => {
    if (!openDay) return undefined;
    const controller = new AbortController();
    setTrades({ rows: [], loading: true });
    fetch(`/api/backtest/portfolio/day?day=${openDay}&variant=${variant}&dataset=${dataset}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((payload) => setTrades({ rows: payload.status === "success" ? payload.trades : [], loading: false }))
      .catch(() => {});
    return () => controller.abort();
  }, [openDay, variant, dataset]);
  const [y, m] = month.split("-");
  const total = days.reduce((a, d) => a + d.net_pct, 0);
  return (
    <div className="mt-3 border-t border-[#2c313a] pt-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#9b968c]">
          {MONTHS[Number(m) - 1]} {y} · {days.length} days · net {fmt.big(total, 2)} · click a day for its trades
        </p>
        <button type="button" onClick={onClose} className="font-mono text-xs text-[#6f6a62] hover:text-[#e7e4dc]">
          close ✕
        </button>
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
                      <DayTrades trades={trades.rows} loading={trades.loading} />
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

export default function PortfolioBacktestPage() {
  const [version, setVersion] = useState("intraday");
  const [entry, setEntry] = useState("0915");
  const [dataset, setDataset] = useState("fno");
  const [slippage, setSlippage] = useState(0.02);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [unit, setUnit] = useState("rs");
  const [capital, setCapital] = useState(1000000);
  const fmt = useMemo(() => makeFmt(unit, capital), [unit, capital]);

  const variant = version === "daily" ? "daily" : `intraday-${entry}`;
  const [month, setMonth] = useState(null);
  const [monthDays, setMonthDays] = useState({ days: [], loading: false });

  useEffect(() => {
    if (!month) return undefined;
    const controller = new AbortController();
    setMonthDays({ days: [], loading: true });
    fetch(`/api/backtest/portfolio/month?month=${month}&variant=${variant}&dataset=${dataset}&slippage=${slippage}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((payload) => setMonthDays({ days: payload.status === "success" ? payload.days : [], loading: false }))
      .catch(() => {});
    return () => controller.abort();
  }, [month, variant, dataset, slippage]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/backtest/portfolio?variant=${variant}&dataset=${dataset}&slippage=${slippage}`)
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || payload.detail || "Could not load the backtest");
          return;
        }
        setError("");
        setData(payload);
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setLoading(false));
  }, [variant, dataset, slippage]);

  const selectVariant = (v) => {
    if (v === "daily") setVersion("daily");
    else {
      setVersion("intraday");
      setEntry(v.split("-")[1]);
    }
  };

  const s = data?.summary;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Backtest · Cross-sectional mean reversion</h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How this backtest works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            Market-neutral: every day, long the stocks that lagged and short the ones that led, in proportion to the move.
            Returns are % of gross exposure, summed at a fixed size.
          </p>
        </div>
        {s && (
          <p className="font-mono text-xs text-[#6f6a62]">
            {s.from} → {s.to} · {s.days} days · ~{s.avg_stocks} stocks a day
          </p>
        )}
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2" title="Intraday: signal previous close → open, held open → 15:15. Daily: signal last 15:15 → 15:15, held to the next 15:15.">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Version</span>
          <Segmented options={VERSIONS} value={version} onChange={setVersion} />
        </div>
        {version === "intraday" && (
          <div
            className="flex items-center gap-2"
            title="The book enters at the 09:15 open (the opening-auction price). 09:30 and 09:45 keep the same signal and enter later: a check on how much of the result depends on the auction fill."
          >
            <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Entry</span>
            <Segmented options={ENTRIES} value={entry} onChange={setEntry} />
          </div>
        )}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented options={DATASETS} value={dataset} onChange={setDataset} />
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
        <div className="flex items-center gap-2" title="Show results as % of gross exposure, or in rupees for the chosen gross exposure (long + short)">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Show</span>
          <Segmented options={UNITS} value={unit} onChange={setUnit} />
        </div>
        {unit === "rs" && (
          <div className="flex items-center gap-2" title="Gross exposure: half long, half short, the same every day">
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
          {unit === "rs" && (
            <p className="mb-2 font-mono text-xs text-[#9b968c]">
              {CAPITALS.find(([c]) => c === capital)[1]} gross exposure every day: half long, half short, spread over ~
              {s.avg_stocks} stocks. Rupees are the % results scaled to that size, not compounded.
            </p>
          )}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Net / year" value={fmt.big(s.net.ann_return_pct)} className={pctClass(s.net.ann_return_pct)} title="Mean daily net return × 248, at a fixed gross exposure (not compounded)" />
            <Stat label="Gross / year" value={fmt.big(s.gross.ann_return_pct)} className={pctClass(s.gross.ann_return_pct)} title="Before charges and slippage" />
            <Stat label="Cost / day" value={fmt.bps(-s.avg_cost_bps)} title={`${s.avg_turnover}× gross traded a day at ${data.cost_per_side_bps} bps per side`} />
            <Stat label="Net / day" value={fmt.bps(s.net.avg_day_bps)} className={pctClass(s.net.avg_day_bps)} />
            <Stat label="Net Sharpe" value={s.net.sharpe ?? "—"} className={pctClass(s.net.sharpe)} title={`Before costs: ${s.gross.sharpe}`} />
            <Stat label="Max drawdown" value={fmt.big(s.net.max_dd_pct)} className="text-[#f0b4b4]" title="Largest fall in cumulative net, at a fixed gross exposure" />
            <Stat label="Win days" value={`${s.net.win_days_pct}%`} title="Days with a positive net return" />
            <Stat label="Green years" value={`${s.green_years}/${s.years}`} title={`Gross bps a day: long side ${s.long_bps}, short side ${s.short_bps}`} />
          </div>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {unit === "rs" ? `Net ₹ by month (${CAPITALS.find(([c]) => c === capital)[1]} gross exposure)` : "Net % by month (of gross exposure)"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Click a month for its days</p>
            </div>
            <MonthGrid months={data.months} years={data.years} fmt={fmt} selected={month} onSelect={setMonth} />
            {month && (
              <MonthDays
                month={month}
                days={monthDays.days}
                loading={monthDays.loading}
                fmt={fmt}
                onClose={() => setMonth(null)}
                variant={variant}
                dataset={dataset}
              />
            )}
          </section>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                {unit === "rs" ? "Cumulative ₹ (fixed exposure, weekly)" : "Cumulative % (fixed exposure, weekly)"}
              </p>
              <p className="font-mono text-xs text-[#9b968c]">
                <span className="text-[#e2c08a]">—</span> net · <span className="text-[#6f6a62]">—</span> gross (before costs)
              </p>
            </div>
            <EquityChart equity={data.equity} fmt={fmt} />
          </section>

          <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">
                All versions · {DATASETS.find(([d]) => d === dataset)[1]} · {slippage}% slippage
              </p>
              <p className="font-mono text-xs text-[#9b968c]">Click a row to open it</p>
            </div>
            <CompareTable rows={data.compare} variant={variant} onSelect={selectVariant} fmt={fmt} />
          </section>
        </>
      )}

      {showInfo && (
        <ModelInfoModal title="Cross-sectional mean reversion · how it works" onClose={() => setShowInfo(false)}>
          <XsmrInfo />
        </ModelInfoModal>
      )}
    </div>
  );
}
