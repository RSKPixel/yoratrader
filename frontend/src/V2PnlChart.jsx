import { useEffect, useRef, useState } from "react";
import { formatRs } from "./V2Controls";
import { baseOptions, Chart, themeColors, watchTheme } from "./chartjs";

// A paper day through the session, every 15 minutes (v2pnl), on Chart.js, as three small bordered
// charts: net P&L (green above zero, red below; gross dashed), longs vs shorts, and each position's
// net at the latest point. `url` is the /api/v2/paper/<model>/pnl query; `refreshMs` re-fetches while
// the day is live. `compact` (the paper log) makes the charts shorter.

const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// over several days the axis needs the date too
const stamp = (t, multi) => {
  if (!multi) return hhmm(t);
  const d = new Date(t * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hhmm(t)}`;
};
const multiDay = (points) => points.length > 1 && new Date(points[0].time * 1000).toISOString().slice(0, 10) !== new Date(points[points.length - 1].time * 1000).toISOString().slice(0, 10);

function compactOptions(c, opts = {}) {
  const o = baseOptions(c, (v) => formatRs(v));
  o.scales.y.ticks.maxTicksLimit = 5;
  o.scales.x.ticks.maxTicksLimit = 6;
  return { ...o, ...opts };
}

function useChart(build, deps) {
  const canvas = useRef(null);
  const [theme, setTheme] = useState(0);
  useEffect(() => watchTheme(canvas.current, () => setTheme((n) => n + 1)), []);
  useEffect(() => {
    if (!canvas.current) return undefined;
    const config = build(themeColors(canvas.current));
    if (!config) return undefined;
    const chart = new Chart(canvas.current, config);
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, theme]);
  return canvas;
}

function Card({ title, note, height, children }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {note && (
          <span className="truncate text-[0.6875rem] tabular-nums" style={{ color: "var(--muted)" }}>
            {note}
          </span>
        )}
      </div>
      <div className={`relative ${height} w-full`}>{children}</div>
    </div>
  );
}

function NetChart({ points, height }) {
  const multi = multiDay(points);
  const canvas = useChart(
    (c) => ({
      type: "line",
      data: {
        labels: points.map((p) => stamp(p.time, multi)),
        datasets: [
          {
            label: "Net",
            data: points.map((p) => p.net_rs),
            borderWidth: 2,
            pointRadius: 2,
            pointBorderWidth: 0,
            tension: 0.15,
            segment: { borderColor: (ctx) => (ctx.p1.parsed.y >= 0 ? c.up : c.down) },
            pointBackgroundColor: points.map((p) => (p.net_rs >= 0 ? c.up : c.down)),
            fill: { target: "origin", above: `${c.up}22`, below: `${c.down}22` },
          },
          { label: "Gross", data: points.map((p) => p.gross_rs), borderColor: c.faint, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.15 },
        ],
      },
      options: compactOptions(c),
    }),
    [points],
  );
  const last = points[points.length - 1];
  const best = points.reduce((a, p) => (p.net_rs > a.net_rs ? p : a));
  const worst = points.reduce((a, p) => (p.net_rs < a.net_rs ? p : a));
  return (
    <Card
      title="Net P&L"
      note={`${last.live ? "now" : stamp(last.time, multi)} ${formatRs(last.net_rs)} · high ${formatRs(best.net_rs)} ${stamp(best.time, multi)} · low ${formatRs(worst.net_rs)} ${stamp(worst.time, multi)}`}
      height={height}
    >
      <canvas ref={canvas} />
    </Card>
  );
}

function SidesChart({ points, sides, height }) {
  const canvas = useChart(
    (c) => ({
      type: "line",
      data: {
        labels: points.map((p) => hhmm(p.time)),
        datasets: [
          sides.includes("long") && { label: "Longs", data: points.map((p) => p.long_rs), borderColor: c.up, borderWidth: 2, pointRadius: 0, tension: 0.15 },
          sides.includes("short") && { label: "Shorts", data: points.map((p) => p.short_rs), borderColor: c.down, borderWidth: 2, pointRadius: 0, tension: 0.15 },
        ].filter(Boolean),
      },
      options: compactOptions(c),
    }),
    [points, sides],
  );
  const last = points[points.length - 1];
  return (
    <Card
      title={sides.length > 1 ? "Longs vs shorts" : "Longs"}
      note={[sides.includes("long") && `longs ${formatRs(last.long_rs)}`, sides.includes("short") && `shorts ${formatRs(last.short_rs)}`].filter(Boolean).join(" · ")}
      height={height}
    >
      <canvas ref={canvas} />
    </Card>
  );
}

// Held positions (short-term mean reversion): one line a stock, its net since its own buy
function EachChart({ points, symbols, height }) {
  const multi = multiDay(points);
  const canvas = useChart(
    (c) => {
      const palette = [c.accent, c.warning, c.up, c.down, c.faint, "#8b5cf6", "#ec4899", "#0ea5e9", "#84cc16", "#f97316"];
      return {
        type: "line",
        data: {
          labels: points.map((p) => stamp(p.time, multi)),
          datasets: symbols.map((s, i) => ({
            label: s,
            data: points.map((p) => (p.by && s in p.by ? p.by[s] : null)),
            borderColor: palette[i % palette.length],
            borderWidth: 2,
            pointRadius: points.length < 3 ? 3 : 0,
            tension: 0.15,
            spanGaps: true,
          })),
        },
        options: compactOptions(c),
      };
    },
    [points, symbols],
  );
  return (
    <Card title="Each position" note={symbols.join(" · ")} height={height}>
      <canvas ref={canvas} />
    </Card>
  );
}

function PositionsChart({ rows, height }) {
  const canvas = useChart(
    (c) => ({
      type: "bar",
      data: {
        labels: rows.map((r) => r.symbol),
        datasets: [
          {
            label: "Net",
            data: rows.map((r) => r.net_rs),
            backgroundColor: rows.map((r) => `${r.net_rs >= 0 ? c.up : c.down}aa`),
            borderRadius: 3,
            barThickness: "flex",
            maxBarThickness: 14,
          },
        ],
      },
      options: (() => {
        const o = compactOptions(c, { indexAxis: "y" });
        o.scales = {
          x: { ...o.scales.y, position: "bottom", ticks: { ...o.scales.y.ticks, maxTicksLimit: 4 } },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: c.text, autoSkip: false, font: { size: 10 } } },
        };
        o.plugins.tooltip.callbacks.label = (ctx) => ` ${rows[ctx.dataIndex].side}: ${formatRs(ctx.parsed.x)}`;
        return o;
      })(),
    }),
    [rows],
  );
  return (
    <Card title="By position" note={`${rows.length} positions, now`} height={height}>
      <canvas ref={canvas} />
    </Card>
  );
}

export default function V2PnlChart({ url, refreshMs = 0, compact = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!refreshMs) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => (p.status === "success" ? (setData(p), setError("")) : setError(p.message || "Could not load the P&L")))
      .catch((e) => e.name !== "AbortError" && setError("Could not reach the API"));
    return () => controller.abort();
  }, [url, tick]);

  const pts = data?.points || [];
  if (error) return <p className="text-xs" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!data) return <p className="text-xs" style={{ color: "var(--muted)" }}>Loading the day's P&L…</p>;
  if (!pts.length) return <p className="text-xs" style={{ color: "var(--muted)" }}>{data.positions === 0 ? "No open positions." : "No 15-minute candles yet."}</p>;
  const height = compact ? "h-36" : "h-44";
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <NetChart points={pts} height={height} />
        {data.symbols ? (
          <EachChart points={pts} symbols={data.symbols} height={height} />
        ) : (
          <SidesChart points={pts} sides={data.sides || []} height={height} />
        )}
        <PositionsChart rows={data.by_position || []} height={height} />
      </div>
      <p className="mt-1.5 text-[0.6875rem]" style={{ color: "var(--faint)" }}>
        One lot each{data.size > 1 ? ` (× ${data.size})` : ""}, after costs · every 15-minute close from Kite{data.symbols ? ", stock prices, the last point live" : ""}, IST · hover for values
      </p>
    </div>
  );
}
