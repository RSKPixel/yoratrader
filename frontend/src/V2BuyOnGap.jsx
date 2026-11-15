import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRs, Segmented, Field } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";

// Buy on gap (Chan, Algorithmic Trading ch. 4) on v2: the stored backtest trades sized by the common
// parameters (capital, max open, % or ₹). The API returns fractions of capital in %.

const DATASETS = [
  ["fno", "F&O stocks"],
  ["stocks", "Nifty 50 stocks"],
  ["indices", "Indices"],
];
const SIDES = [
  ["long", "Long (book)"],
  ["both", "Long & short"],
];
const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];
const SLIPPAGE = [
  [0, "0%"],
  [0.01, "0.01%"],
  [0.02, "0.02%"],
  [0.05, "0.05%"],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const tone = (v) => (v == null || v === 0 ? "var(--muted)" : v > 0 ? "var(--positive)" : "var(--negative)");

function makeValue(show, capital) {
  // pct: a fraction of capital in %; shown as % or as rupees of the chosen capital.
  return (pct, digits = 2) => {
    if (pct == null) return "—";
    if (show === "rs") return formatRs((pct / 100) * capital);
    return `${pct > 0 ? "+" : ""}${pct.toFixed(digits)}%`;
  };
}

function Card({ label, value, color, hint }) {
  return (
    <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }} title={hint}>
      <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--faint)" }}>
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums" style={{ color: color || "var(--text)" }}>
        {value}
      </p>
    </div>
  );
}

function Panel({ title, right, children }) {
  return (
    <section className="rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-sm font-semibold">{title}</h2>
        {right && <span className="text-xs" style={{ color: "var(--muted)" }}>{right}</span>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function MonthGrid({ years, months, value, onOpen }) {
  const byMonth = useMemo(() => Object.fromEntries(months.map((m) => [m.month, m])), [months]);
  const scale = Math.max(0.01, ...months.map((m) => Math.abs(m.net_pct)));
  const cell = (v) => {
    if (v == null) return {};
    const a = Math.min(1, Math.abs(v) / scale);
    const c = v > 0 ? "var(--positive)" : "var(--negative)";
    return { background: `color-mix(in srgb, ${c} ${Math.round(8 + 32 * a)}%, transparent)` };
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-1 text-xs tabular-nums">
        <thead>
          <tr style={{ color: "var(--faint)" }}>
            <th className="px-2 py-1 text-left font-medium">Year</th>
            {MONTHS.map((m) => (
              <th key={m} className="px-2 py-1 font-medium">
                {m}
              </th>
            ))}
            <th className="px-2 py-1 font-medium">Year</th>
            <th className="px-2 py-1 font-medium">Trades</th>
            <th className="px-2 py-1 font-medium">Win</th>
          </tr>
        </thead>
        <tbody>
          {[...years].reverse().map((y) => (
            <tr key={y.year}>
              <td className="px-2 py-1.5 font-medium">{y.year}</td>
              {MONTHS.map((_, i) => {
                const key = `${y.year}-${String(i + 1).padStart(2, "0")}`;
                const m = byMonth[key];
                return (
                  <td key={key} className="rounded p-0 text-center" style={cell(m?.net_pct)}>
                    {m ? (
                      <button
                        type="button"
                        onClick={() => onOpen(key)}
                        className="w-full px-1.5 py-1.5 hover:underline"
                        style={{ color: "var(--text)" }}
                        title={`${m.trades} trades · ${m.win_rate}% win · net ${value(m.net_pct)}`}
                      >
                        {value(m.net_pct, 2)}
                      </button>
                    ) : (
                      <span className="block px-1.5 py-1.5" style={{ color: "var(--faint)" }}>
                        ·
                      </span>
                    )}
                  </td>
                );
              })}
              <td className="rounded px-2 py-1.5 text-center font-semibold" style={cell(y.net_pct)}>
                {value(y.net_pct, 2)}
              </td>
              <td className="px-2 py-1.5 text-center" style={{ color: "var(--muted)" }}>
                {y.trades}
              </td>
              <td className="px-2 py-1.5 text-center" style={{ color: "var(--muted)" }}>
                {y.win_rate}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthTrades({ month, query, value, capital, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    fetch(`/api/v2/backtest/gap/month?month=${month}&${query}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => setRows(p.status === "success" ? p.trades : []))
      .catch(() => {});
    return () => controller.abort();
  }, [month, query]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const total = rows?.reduce((a, t) => a + t.book_net_pct, 0) ?? 0;
  const [y, m] = month.split("-");
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Trades in ${MONTHS[Number(m) - 1]} ${y}`}
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="text-base font-semibold">
              {MONTHS[Number(m) - 1]} {y}
            </h2>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {rows ? `${rows.length} trades · net ${value(total)}` : "Loading…"} · in at the 09:15 open, out at 15:15 (or the stop)
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>
            Close
          </button>
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[960px] text-xs tabular-nums">
            <thead className="sticky top-0 text-left" style={{ background: "var(--surface)", color: "var(--faint)" }}>
              <tr>
                {["Day", "Stock", "Side", "Gap", "Entry", "Qty", "Stop", "Exit", "Reason", "Return", "Net", "Size", "Cost", "Net result"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows?.map((t, i) => (
                <tr key={i} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="px-3 py-1.5">{t.day}</td>
                  <td className="px-3 py-1.5 font-medium">{t.symbol}</td>
                  <td className="px-3 py-1.5" style={{ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }}>
                    {t.side}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: "var(--muted)" }} title={`Rank ${t.rank} that day`}>
                    {t.gap_pct.toFixed(2)}%
                  </td>
                  <td className="px-3 py-1.5">{t.entry}</td>
                  <td className="px-3 py-1.5" title={`${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`}>
                    {Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN")}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: "var(--muted)" }}>
                    {t.stop}
                  </td>
                  <td className="px-3 py-1.5">{t.exit}</td>
                  <td className="px-3 py-1.5" style={{ color: t.reason.startsWith("stop") ? "var(--negative)" : "var(--muted)" }}>
                    {t.reason}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: tone(t.ret_pct) }}>
                    {t.ret_pct.toFixed(2)}%
                  </td>
                  <td className="px-3 py-1.5" style={{ color: tone(t.net_pct) }}>
                    {t.net_pct.toFixed(2)}%
                  </td>
                  <td className="px-3 py-1.5" style={{ color: "var(--muted)" }}>
                    {value(t.weight_pct)}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: "var(--negative)" }}>
                    {value(-t.book_cost_pct, 3)}
                  </td>
                  <td className="px-3 py-1.5 font-medium" style={{ color: tone(t.book_net_pct) }}>
                    {value(t.book_net_pct, 3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function V2BuyOnGap({ params }) {
  const [dataset, setDataset] = useState("fno");
  const [side, setSide] = useState("long");
  const [stop, setStop] = useState("none");
  const [slippage, setSlippage] = useState(0.02);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(null);

  const query = `dataset=${dataset}&side=${side}&stop=${stop}&slippage=${slippage}&max_open=${params.maxOpen}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/v2/backtest/gap?${query}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success") setError(p.message || p.detail || "Could not load the backtest");
        else {
          setError("");
          setData(p);
        }
      })
      .catch((e) => e.name !== "AbortError" && setError("Could not reach the API"))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [query]);

  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Universe">
          <Segmented label="Universe" options={DATASETS} value={dataset} onChange={setDataset} />
        </Field>
        <Field label="Side" hint="Long: buy gaps down (the book). Long & short: also short the mirror image.">
          <Segmented label="Side" options={SIDES} value={side} onChange={setSide} />
        </Field>
        <Field label="Stop" hint="None: out at 15:15 (the book). 1σ: a stop one 90-day standard deviation from the entry.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && (
          <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
            Loading…
          </span>
        )}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!error && data && !s && <p className="text-sm" style={{ color: "var(--muted)" }}>No trades for these settings.</p>}

      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <Card label="Trades" value={s.trades.toLocaleString("en-IN")} hint={`${s.days_traded} days traded of ${s.days} · ~${s.avg_positions} a trading day`} />
            <Card label="Win rate" value={`${s.win_rate}%`} hint={`After costs. Before costs: ${s.win_rate_gross}%`} />
            <Card label="Gross" value={value(s.gross_pct)} color={tone(s.gross_pct)} hint="Before costs" />
            <Card label="Costs" value={value(-s.cost_pct)} color="var(--negative)" hint={`Charges + slippage (${s.cost_per_side_bps} bps a side); ${value(-s.avg_cost_pct, 3)} a trade`} />
            <Card label="Net" value={value(s.net_pct)} color={tone(s.net_pct)} hint={`${value(s.net_year_pct)} a year`} />
            <Card label="Net / trade" value={value(s.avg_net_pct, 3)} color={tone(s.avg_net_pct)} hint={`Each trade on its own position: ${s.avg_trade_net_pct}%`} />
            <Card label="Profit factor" value={s.profit_factor ?? "—"} color={s.profit_factor >= 1 ? "var(--positive)" : "var(--negative)"} hint="Net winning trades ÷ net losing trades" />
            <Card label="Max drawdown" value={value(s.max_dd_pct)} color="var(--negative)" hint="Largest fall in cumulative net, at a fixed capital" />
          </div>
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {s.from} → {s.to} · {value(s.net_year_pct)} net a year · Sharpe {s.sharpe ?? "—"} · {s.green_years}/{s.years} green years ·
            traded on {s.days_traded} of {s.days} days (intraday: capital sits idle on the rest)
          </p>

          <Panel title="Net by month" right="click a month for its trades">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>

          <Panel title="Equity" right="cumulative, fixed capital, not compounded · accent = net, grey = gross">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
      {month && <MonthTrades month={month} query={query} value={value} capital={params.capital} onClose={closeMonth} />}
    </div>
  );
}
