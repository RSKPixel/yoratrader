import { Schedule } from "../V2Dashboard";

// The phone app's schedule tab: what's next, the day's schedule and how fresh the data is.

export default function MobileSchedule({ d }) {
  const next = d.schedule.find((s) => s.state === "running") || d.schedule.find((s) => s.state === "pending");
  const f = d.freshness || {};
  const data = [
    ["Backtest · daily", f.backtest_daily], ["Backtest · index daily", f.backtest_index_daily], ["Backtest · 15 min", f.backtest_15m],
    ["Live futures · daily", f.live_daily], ["Live futures · 15 min", f.live_15m],
  ];
  const box = { borderColor: "var(--border)", background: "var(--surface)" };
  return (
    <div className="flex flex-col gap-4">
      {next && (
        <div className="rounded-xl border p-4" style={box}>
          <div className="text-xs" style={{ color: "var(--muted)" }}>{next.state === "running" ? "Due now" : "Next up"}</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-2xl font-semibold tabular-nums">{next.at}</span>
            <span className="text-sm font-medium">{next.label}</span>
          </div>
        </div>
      )}
      <div className="rounded-xl border px-4 py-1" style={box}>
        <Schedule steps={d.schedule} />
      </div>
      <div className="rounded-xl border" style={box}>
        <div className="px-4 pt-3 text-xs font-semibold">Data</div>
        {data.map(([label, day]) => {
          const stale = !day || day < d.expected_data;
          return (
            <div key={label} className="flex items-center justify-between border-t px-4 py-2 text-sm first:border-t-0" style={{ borderColor: "var(--border)" }}>
              <span>{label}</span>
              <span className="tabular-nums text-xs font-medium" style={{ color: stale ? "var(--warning)" : "var(--positive)" }}>{day || "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

