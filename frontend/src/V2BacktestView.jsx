import { useEffect, useMemo, useState } from "react";
import { formatRs } from "./V2Controls";

// Pieces every v2 backtest page shares: value formatting (% of capital or rupees), cards, panels,
// the month grid and the month's-trades dialog. API values are fractions of capital in %.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const tone = (v) => (v == null || v === 0 ? "var(--muted)" : v > 0 ? "var(--positive)" : "var(--negative)");

export function makeValue(show, capital) {
  return (pct, digits = 2) => {
    if (pct == null) return "—";
    if (show === "rs") return formatRs((pct / 100) * capital);
    return `${pct > 0 ? "+" : ""}${pct.toFixed(digits)}%`;
  };
}

export function Card({ label, value, color, hint }) {
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

export function Panel({ title, right, children }) {
  return (
    <section className="rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-sm font-semibold">{title}</h2>
        {right && (
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            {right}
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function SummaryCards({ s, value }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      <Card
        label={s.trades_label || "Trades"}
        value={s.trades.toLocaleString("en-IN")}
        hint={s.trades_label ? `${s.trades_label}: one stock on one day · ${s.days_traded} trading days` : "Closed trades · results count on the exit day"}
      />
      <Card label="Win rate" value={`${s.win_rate}%`} hint={`After costs. Before costs: ${s.win_rate_gross}%`} />
      <Card label="Gross" value={value(s.gross_pct)} color={tone(s.gross_pct)} hint="Before costs" />
      <Card label="Costs" value={value(-s.cost_pct)} color="var(--negative)" hint={`Charges + slippage (${s.cost_per_side_bps} bps a side); ${value(-s.avg_cost_pct, 3)} a trade`} />
      <Card label="Net" value={value(s.net_pct)} color={tone(s.net_pct)} hint={`${value(s.net_year_pct)} a year`} />
      <Card label="Net / trade" value={value(s.avg_net_pct, 3)} color={tone(s.avg_net_pct)} hint={`Each trade on its own position: ${s.avg_trade_net_pct}%`} />
      <Card label="Profit factor" value={s.profit_factor ?? "—"} color={s.profit_factor >= 1 ? "var(--positive)" : "var(--negative)"} hint="Net winning trades ÷ net losing trades" />
      <Card label="Max drawdown" value={value(s.max_dd_pct)} color="var(--negative)" hint="Largest fall in cumulative net, at a fixed capital" />
    </div>
  );
}

export function MonthGrid({ years, months, value, onOpen }) {
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

// columns: [{ h: "Header", cell: (row) => node, style?: (row) => style, title?: (row) => text }]
export function MonthTradesModal({ month, url, columns, value, note, onClose, minWidth = 960, groupByDay = false }) {
  const [rows, setRows] = useState(null);
  const [openDays, setOpenDays] = useState({});
  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    fetch(url, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => setRows(p.status === "success" ? p.trades : []))
      .catch(() => {});
    return () => controller.abort();
  }, [url]);
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
        className="flex max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="text-base font-semibold">
              {MONTHS[Number(m) - 1]} {y}
            </h2>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {rows ? `${rows.length} trades · net ${value(total)}` : "Loading…"}
              {note ? ` · ${note}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>
            Close
          </button>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-xs tabular-nums" style={{ minWidth }}>
            <thead className="sticky top-0 text-left" style={{ background: "var(--surface)", color: "var(--faint)" }}>
              <tr>
                {columns.map((c) => (
                  <th key={c.h} className="px-3 py-2 font-medium">
                    {c.h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupByDay
                ? Object.entries(
                    (rows || []).reduce((acc, t) => {
                      (acc[t.day] ||= []).push(t);
                      return acc;
                    }, {}),
                  ).map(([day, list]) => {
                    const net = list.reduce((a, t) => a + t.book_net_pct, 0);
                    const open = openDays[day];
                    return [
                      <tr key={day} className="border-t" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
                        <td colSpan={columns.length} className="px-3 py-1.5">
                          <button
                            type="button"
                            onClick={() => setOpenDays((d) => ({ ...d, [day]: !open }))}
                            className="flex w-full items-center gap-3 text-left"
                            aria-expanded={!!open}
                          >
                            <span style={{ color: "var(--faint)" }}>{open ? "▾" : "▸"}</span>
                            <span className="font-medium">{day}</span>
                            <span style={{ color: "var(--muted)" }}>{list.length} positions</span>
                            <span className="ml-auto font-medium" style={{ color: tone(net) }}>
                              {value(net, 3)}
                            </span>
                          </button>
                        </td>
                      </tr>,
                      ...(open
                        ? list.map((t, i) => (
                            <tr key={`${day}-${i}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                              {columns.map((c) => (
                                <td key={c.h} className="px-3 py-1.5" style={c.style?.(t)} title={c.title?.(t)}>
                                  {c.cell(t)}
                                </td>
                              ))}
                            </tr>
                          ))
                        : []),
                    ];
                  })
                : rows?.map((t, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: "var(--border)" }}>
                      {columns.map((c) => (
                        <td key={c.h} className="px-3 py-1.5" style={c.style?.(t)} title={c.title?.(t)}>
                          {c.cell(t)}
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
