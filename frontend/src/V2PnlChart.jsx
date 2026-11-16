import { useEffect, useRef, useState } from "react";
import { BaselineSeries, createChart, LineSeries, LineStyle } from "lightweight-charts";
import { formatRs } from "./V2Controls";

// A paper day's P&L through the session, every 15 minutes (v2pnl): net after costs, green above zero
// and red below, with the gross move as a faint line. `url` is the /api/v2/paper/<model>/pnl query;
// `refreshMs` re-fetches while the day is live.

function colors(el) {
  const css = getComputedStyle(el.closest(".v2") || document.body);
  const v = (n) => css.getPropertyValue(n).trim();
  return { text: v("--muted"), grid: v("--border"), up: v("--positive"), down: v("--negative"), faint: v("--faint") };
}

export default function V2PnlChart({ url, refreshMs = 0, height = "h-56" }) {
  const box = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState(null);

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
    if (!box.current || !data?.points?.length) return undefined;
    const c = colors(box.current);
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: c.text, fontFamily: "IBM Plex Sans, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      localization: { priceFormatter: (v) => formatRs(v) },
    });
    const gross = chart.addSeries(LineSeries, { color: c.faint, lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
    const net = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: c.up,
      topFillColor1: `${c.up}33`,
      topFillColor2: `${c.up}05`,
      bottomLineColor: c.down,
      bottomFillColor1: `${c.down}05`,
      bottomFillColor2: `${c.down}33`,
      lineWidth: 2,
    });
    gross.setData(data.points.map((p) => ({ time: p.time, value: p.gross_rs })));
    net.setData(data.points.map((p) => ({ time: p.time, value: p.net_rs })));
    net.createPriceLine({ price: 0, color: c.text, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((p) => {
      const n = p.seriesData?.get(net);
      setHover(n ? { time: p.time, net: n.value, gross: p.seriesData.get(gross)?.value } : null);
    });
    return () => chart.remove();
  }, [data]);

  const pts = data?.points || [];
  const last = pts[pts.length - 1];
  const show = hover || (last && { time: last.time, net: last.net_rs, gross: last.gross_rs });
  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
  const best = pts.length ? pts.reduce((a, p) => (p.net_rs > a.net_rs ? p : a)) : null;
  const worst = pts.length ? pts.reduce((a, p) => (p.net_rs < a.net_rs ? p : a)) : null;
  return (
    <div>
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
      <div ref={box} className={`${height} w-full`} />
    </div>
  );
}
