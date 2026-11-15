import { useState } from "react";
import { Card, Panel, tone } from "./V2BacktestView";

// Pieces the v2 paper pages share: the summary cards, the day's positions table and the daily log
// (a row a day, expandable to its positions). API values are fractions of capital in %.

export function PaperCards({ s, value, extra = [] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
      <Card label="Days" value={s.days} hint="Closed paper days" />
      <Card label="Trades" value={s.trades} hint="Closed positions" />
      <Card label="Win rate" value={s.win_rate == null ? "—" : `${s.win_rate}%`} hint={s.win_days == null ? undefined : `${s.win_days}% of days net positive`} />
      <Card label="Net" value={value(s.net_pct)} color={tone(s.net_pct)} hint="After charges and slippage on both sides" />
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

export function DayLog({ days, columns, value, empty, minWidth = 900 }) {
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
              </span>
              <span className="ml-auto font-semibold tabular-nums" style={{ color: tone(d.net_pct) }}>
                {value(d.net_pct, 3)}
              </span>
            </button>
            {isOpen && (
              <div className="pb-2">
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
