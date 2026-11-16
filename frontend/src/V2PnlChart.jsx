import { useEffect, useRef, useState } from "react";
import { formatRs } from "./V2Controls";
import { baseOptions, Chart, themeColors, watchTheme } from "./chartjs";

// A paper day's P&L through the session, every 15 minutes (v2pnl), on Chart.js: net after costs,
// green above zero and red below, with the gross move as a faint dashed line; hover for each point. `url` is the /api/v2/paper/<model>/pnl query;
// `refreshMs` re-fetches while the day is live.

export default function V2PnlChart({ url, refreshMs = 0, height = "h-48" }) {
  const canvas = useRef(null);
  const [theme, setTheme] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => watchTheme(canvas.current, () => setTheme((n) => n + 1)), []);

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

  useEffect(() => {
    if (!canvas.current || !data?.points?.length) return undefined;
    const c = themeColors(canvas.current);
    const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
    const chart = new Chart(canvas.current, {
      type: "line",
      data: {
        labels: data.points.map((p) => hhmm(p.time)),
        datasets: [
          {
            label: "Net",
            data: data.points.map((p) => p.net_rs),
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.15,
            // green above zero, red below; the area to zero tinted the same way
            segment: { borderColor: (ctx) => (ctx.p1.parsed.y >= 0 ? c.up : c.down) },
            pointBackgroundColor: data.points.map((p) => (p.net_rs >= 0 ? c.up : c.down)),
            pointBorderWidth: 0,
            fill: { target: "origin", above: `${c.up}22`, below: `${c.down}22` },
          },
          { label: "Gross", data: data.points.map((p) => p.gross_rs), borderColor: c.faint, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.15 },
        ],
      },
      options: (() => {
        // a session is ~25 points: a compact chart with a light grid reads better than a wide one
        const o = baseOptions(c, (v) => formatRs(v));
        o.scales.y.ticks.maxTicksLimit = 5;
        o.scales.x.ticks.maxTicksLimit = 7;
        return o;
      })(),
    });
    return () => chart.destroy();
  }, [data, theme]);

  const pts = data?.points || [];
  const last = pts[pts.length - 1];
  const show = last && { time: last.time, net: last.net_rs, gross: last.gross_rs };
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
  const best = pts.length ? pts.reduce((a, p) => (p.net_rs > a.net_rs ? p : a)) : null;
  const worst = pts.length ? pts.reduce((a, p) => (p.net_rs < a.net_rs ? p : a)) : null;
  return (
    <div className="max-w-xl">
      <p className="mb-1 text-xs tabular-nums" style={{ color: "var(--muted)" }}>
        {error ? (
          <span style={{ color: "var(--negative)" }}>{error}</span>
        ) : !data ? (
          "Loading the day's P&L…"
        ) : !pts.length ? (
          "No 15-minute candles yet."
        ) : (
          <>
            {hhmm(show.time)} · net <span style={{ color: show.net >= 0 ? "var(--positive)" : "var(--negative)" }}>{formatRs(show.net)}</span> · gross{" "}
            {formatRs(show.gross)} · high {formatRs(best.net_rs)} at {hhmm(best.time)} · low {formatRs(worst.net_rs)} at {hhmm(worst.time)}
            {data.size > 1 ? ` · at ${data.size} lots` : ""} · every 15 min, IST
          </>
        )}
      </p>
      <div className={`relative ${height} w-full`}>
        <canvas ref={canvas} />
      </div>
    </div>
  );
}
