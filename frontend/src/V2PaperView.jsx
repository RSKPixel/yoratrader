import { ChartCandlestick } from "lucide-react";
import { useState } from "react";
import V2CandleChart from "./V2CandleChart";
import { Card, Panel, tone } from "./V2BacktestView";
import { formatRs } from "./V2Controls";

// Pieces the v2 paper pages share: the summary cards, the day's positions table and the daily log
// (a row a day, expandable to its positions). API values are fractions of capital in %.

// A position's chart: the stock's 15-minute candles from Kite (today's included), with its entry,
// stop and exit / last price marked. usePaperChart() gives the chart column and the open dialog.
export function usePaperChart({ days = 1 } = {}) {
  const [row, setRow] = useState(null);
  const column = {
    h: "",
    cell: (t) => (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setRow(t);
        }}
        className="grid h-6 w-6 place-items-center rounded border transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        title={t.fut ? `${t.fut}: the future's 15-minute chart` : `${t.symbol}: 15-minute chart`}
        aria-label={`${t.symbol} chart`}
      >
        <ChartCandlestick className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
      </button>
    ),
  };
  // A position traded on the future (Oops, SR, CR) charts its contract, with the future's prices marked
  const fut = row?.fut;
  const entry = fut ? row.fut_buy ?? row.entry ?? row.buy : row?.entry ?? row?.buy;
  const exit = fut ? row.fut_sell ?? row.fut_ltp ?? (row.fut_buy == null ? row.exit : null) : row?.exit ?? row?.sell;
  const dialog = row ? (
    <V2CandleChart
      row={fut ? { symbol: fut, exchange: "NFO" } : { symbol: row.symbol, exchange: "NSE" }}
      source="kite"
      initialInterval="15m"
      initialDays={days}
      lines={[
        { price: entry, label: row.side === "short" ? "Sell" : "Buy", color: "var(--accent)" },
        row.stop != null ? { price: row.stop, label: "Stop", color: "var(--negative)" } : null,
        exit != null ? { price: exit, label: row.closed || row.sell || row.fut_sell ? "Exit" : "Last", color: "var(--muted)" } : null,
      ]
        .filter(Boolean)
        .map((l) => ({ ...l, color: cssVar(l.color) }))}
      onClose={() => setRow(null)}
    />
  ) : null;
  return { column, dialog };
}

function cssVar(v) {
  // lightweight-charts needs a real colour, not var(--x)
  const m = /^var\((--[\w-]+)\)$/.exec(v || "");
  if (!m) return v;
  const el = document.querySelector(".v2") || document.body;
  return getComputedStyle(el).getPropertyValue(m[1]).trim() || undefined;
}

// One F&O lot a position: results in rupees, or as % of the contract value traded (the % of margin is in the hover).
export function lotMoney(show) {
  return (rs, pct, digits = 2) => {
    if (show === "rs") return rs == null ? "—" : `${rs > 0 ? "+" : ""}${formatRs(rs)}`;
    return pct == null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(digits)}%`;
  };
}

// A day's net in rupees and as % of its contract value, whichever way results are shown
export function netBoth(rs, pct) {
  if (rs == null) return "—";
  return `${rs > 0 ? "+" : ""}${formatRs(rs)}${pct == null ? "" : ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}% of value)`}`;
}

export function LotCards({ s, money, extra = [] }) {
  // s: capital_rs, contract_peak_rs, margins_as_of, days, trades, win_rate, win_days, net_rs / net_margin_pct, ...
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      <Card
        label="Capital required"
        value={s.capital_rs ? `${s.capital_estimate ? "≈ " : ""}${formatRs(s.capital_rs)}` : "—"}
        color="var(--accent)"
        hint={`Futures margin (SPAN + exposure) for one lot of each position, on the busiest day${s.contract_peak_rs ? `; contract value ${formatRs(s.contract_peak_rs)}` : ""}${s.margins_as_of ? ` · Kite margins of ${s.margins_as_of}` : ""}`}
      />
      <Card label="Days" value={s.days ?? "—"} hint="Closed paper days" />
      <Card label="Trades" value={s.trades ?? "—"} hint="Closed positions" />
      <Card label="Win rate" value={s.win_rate == null ? "—" : `${s.win_rate}%`} hint={s.win_days == null ? undefined : `${s.win_days}% of days net positive`} />
      <Card
        label="Net"
        value={money(s.net_rs, s.net_value_pct)}
        color={tone(s.net_rs)}
        hint={`One lot each, after slippage (in the prices) and charges on both sides; % of the contract value (busiest day)${s.net_margin_pct == null ? "" : ` · ${s.net_margin_pct > 0 ? "+" : ""}${s.net_margin_pct.toFixed(2)}% of the margin`}`}
      />
      <Card label="Net / day" value={money(s.avg_day_rs, s.avg_day_value_pct, 3)} color={tone(s.avg_day_rs)} />
      <Card label="Costs" value={money(s.cost_rs == null ? null : -s.cost_rs, s.cost_value_pct == null ? null : -s.cost_value_pct)} color="var(--negative)" hint="Charges only: brokerage, STT, exchange and SEBI fees, GST, stamp. Slippage is in the P&L (the prices)." />
      {extra.map((c) => (
        <Card key={c.label} {...c} />
      ))}
    </div>
  );
}

// Columns every lot-sized positions table shares
export function lotColumns(money) {
  return {
    qty: { h: "Qty", cell: (t) => (t.qty == null ? "—" : t.qty.toLocaleString("en-IN")), title: (t) => (t.qty == null ? "No F&O lot size for this stock" : `1 lot = ${t.qty}`) },
    value: { h: "Value", cell: (t) => formatRs(t.contract_rs), title: (t) => (t.qty ? `Contract value: ${t.qty} × ${t.entry ?? t.buy ?? t.fut_buy}` : undefined) },
    margin: { h: "Margin", cell: (t) => formatRs(t.margin_rs), style: () => ({ color: "var(--muted)" }), title: () => "Futures margin (SPAN + exposure) for one lot, from Kite" },
    slip: {
      h: "Slippage in / out",
      cell: (t) =>
        t.slip_rate_in_pct == null ? "—" : (
          <span style={{ color: t.thin ? "var(--warning)" : "var(--muted)" }}>
            {t.slip_rate_in_pct}% / {t.slip_rate_out_pct == null ? "—" : `${t.slip_rate_out_pct}%`}
          </span>
        ),
      title: (t) =>
        t.slip_rate_in_pct == null
          ? undefined
          : `Prices after slippage: in ${t.entry_slipped} (paper ${t.entry})${t.exit_slipped == null ? "" : `, out ${t.exit_slipped} (paper ${t.exit})`} · slippage ${formatRs(t.slip_rs)}` +
            (t.thin ? " · a thin future: the recorded order book's cost, above the model's fixed slippage" : " · the model's fixed slippage") +
            (t.slip_rate_in_pct === 0 ? " · in: a capped fill at its real price" : ""),
    },
    paperNet: {
      h: "Net @ paper price",
      cell: (t) => money(t.net_paper_rs, t.net_paper_value_pct),
      style: (t) => ({ color: tone(t.net_paper_rs) }),
      title: () => "At the paper prices: charges only, no slippage",
    },
    result: {
      h: "Net after slippage",
      cell: (t) => (
        <span className="font-medium">
          {money(t.net_rs, t.net_value_pct)}
          {t.thin && (
            <span className="ml-1.5 rounded px-1 text-[0.625rem] font-semibold uppercase" style={{ color: "var(--warning)", border: "1px solid var(--warning)" }}>
              thin
            </span>
          )}
        </span>
      ),
      style: (t) => ({ color: tone(t.net_rs) }),
      title: (t) => {
        if (t.net_rs == null) return undefined;
        const thin = t.thin
          ? ` · costs include extra slippage from the recorded order book (a thin future): ${t.slip_in_pct}% at entry, ${t.slip_out_pct}% at exit`
          : "";
        return `P&L ${formatRs(t.pnl_rs)} − costs ${formatRs(t.cost_rs)} = ${formatRs(t.net_rs)} · ${t.net_value_pct}% of the value ${formatRs(t.contract_rs)} · ${t.net_margin_pct}% of the margin ${formatRs(t.margin_rs)}${thin}`;
      },
    },
  };
}

export function PaperCards({ s, value, extra = [] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
      <Card label="Days" value={s.days} hint="Closed paper days" />
      <Card label="Trades" value={s.trades} hint="Closed positions" />
      <Card label="Win rate" value={s.win_rate == null ? "—" : `${s.win_rate}%`} hint={s.win_days == null ? undefined : `${s.win_days}% of days net positive`} />
      <Card label="Net" value={value(s.net_pct)} color={tone(s.net_pct)} hint="After slippage (in the prices) and charges on both sides" />
      <Card label="Net / day" value={value(s.avg_day_pct, 3)} color={tone(s.avg_day_pct)} />
      <Card label="Costs" value={value(-s.cost_pct)} color="var(--negative)" />
      {extra.map((c) => (
        <Card key={c.label} {...c} />
      ))}
    </div>
  );
}

export function PositionsTable({ rows, columns, minWidth = 900, empty = "No positions." }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums" style={{ minWidth }}>
        <thead className="text-left" style={{ color: "var(--faint)" }}>
          <tr>
            {columns.map((c) => (
              <th key={c.h} className="px-3 py-2 font-medium">
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-5 text-center" style={{ color: "var(--muted)" }}>
                {empty}
              </td>
            </tr>
          )}
          {rows.map((t, i) => (
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
  );
}

export function DayLog({ days, columns, value, empty, minWidth = 900, dayValue, dayNote, extra }) {
  const [open, setOpen] = useState({});
  if (!days.length) {
    return (
      <p className="py-4 text-center text-sm" style={{ color: "var(--muted)" }}>
        {empty}
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {days.map((d) => {
        const isOpen = open[d.day];
        return (
          <div key={d.day} className="border-t first:border-t-0" style={{ borderColor: "var(--border)" }}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [d.day]: !isOpen }))}
              className="flex w-full items-center gap-3 px-2 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
              aria-expanded={!!isOpen}
            >
              <span style={{ color: "var(--faint)" }}>{isOpen ? "▾" : "▸"}</span>
              <span className="font-medium tabular-nums">{d.day}</span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {d.picks.length} positions · {d.status === "open" ? "open (live)" : "closed"}
                {dayNote ? ` · ${dayNote(d)}` : ""}
              </span>
              <span className="ml-auto font-semibold tabular-nums" style={{ color: tone(dayValue ? d.net_rs : d.net_pct) }}>
                {dayValue ? dayValue(d) : value(d.net_pct, 3)}
              </span>
            </button>
            {isOpen && (
              <div className="pb-2">
                {extra && <div className="px-2 pb-2">{extra(d)}</div>}
                <PositionsTable rows={d.picks} columns={columns} minWidth={minWidth} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function StatusLine({ children }) {
  return (
    <p className="text-xs" style={{ color: "var(--muted)" }}>
      {children}
    </p>
  );
}

export { Panel };
