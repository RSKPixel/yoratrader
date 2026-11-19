import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, createChart, HistogramSeries, LineSeries, LineStyle } from "lightweight-charts";
import { Segmented } from "./V2Controls";

// A candlestick chart with volume for one symbol, on the v2 theme. Daily or 15 min.
// source "kite": the stock straight from Kite with today's candles (paper pages), refreshed while open;
// lines: price lines to mark, e.g. [{ price, label, color }] for a position's entry / stop / exit.
// indicators (daily): { sma: 200, rsi: { period: 2, level: 10 } } draws the average on the price and
// Wilder's RSI in a pane below with its level marked; ~300 extra days are fetched so the average
// is complete from the first visible candle.

const DAILY_RANGES = [
  [90, "3M"],
  [365, "1Y"],
  [1825, "5Y"],
  [0, "All"],
];
const INTRADAY_RANGES = [
  [5, "5D"],
  [30, "1M"],
  [90, "3M"],
];
const KITE_DAILY_RANGES = [
  [90, "3M"],
  [180, "6M"],
  [365, "1Y"],
];
const KITE_RANGES = [
  [1, "Today"],
  [5, "5D"],
  [30, "1M"],
];

function withIndicators(k, ind) {
  // SMA over `ind.sma` closes and Wilder's RSI (smoothing 1 / period), as the model computes them
  const n = ind.sma;
  const a = 1 / (ind.rsi?.period || 2);
  let sum = 0;
  let up = null;
  let dn = null;
  return k.map((c, i) => {
    sum += c.close;
    if (i >= n) sum -= k[i - n].close;
    const out = { ...c, sma: n && i >= n - 1 ? sum / n : null, rsi: null };
    if (i > 0) {
      const d = c.close - k[i - 1].close;
      up = up == null ? Math.max(d, 0) : a * Math.max(d, 0) + (1 - a) * up;
      dn = dn == null ? Math.max(-d, 0) : a * Math.max(-d, 0) + (1 - a) * dn;
      if (i > 10) out.rsi = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
    }
    return out;
  });
}

function colors(el) {
  const css = getComputedStyle(el.closest(".v2") || document.body);
  const v = (n) => css.getPropertyValue(n).trim();
  return { text: v("--muted"), grid: v("--border"), up: v("--positive"), down: v("--negative"), faint: v("--faint"), accent: v("--accent"), warning: v("--warning") };
}

export default function V2CandleChart({ row, source, onClose, lines = [], initialInterval = "day", initialDays = null, indicators = null }) {
  const box = useRef(null);
  const kite = source === "kite";
  const [interval, setInterval] = useState(initialInterval);
  const [days, setDays] = useState(initialDays ?? (initialInterval === "day" ? 365 : kite ? 1 : 30));
  const [tick, setTick] = useState(0);
  const [candles, setCandles] = useState(null);
  const [hover, setHover] = useState(null);
  const [theme, setTheme] = useState(0);
  const has15 = kite || row.m15?.bars > 0;
  useEffect(() => {
    if (!kite) return undefined;
    const timer = window.setInterval(() => setTick((n) => n + 1), 30000); // today's candle keeps forming
    return () => window.clearInterval(timer);
  }, [kite]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    const root = box.current?.closest(".v2");
    if (!root) return undefined;
    const observer = new MutationObserver(() => setTheme((n) => n + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (!tick) setCandles(null);
    const ex = row.exchange || "NSE";
    // "Today" asks Kite for a few days (weekends, holidays) and shows the latest session
    const ind = indicators && interval === "day" ? indicators : null;
    const ask = kite && days === 1 ? 5 : ind ? Math.min(2000, (days || 365) + Math.ceil((ind.sma || 0) * 1.5)) : days;
    fetch(`/api/v2/data/candles?symbol=${encodeURIComponent(row.symbol)}&interval=${interval}&source=${source}&exchange=${ex}&days=${ask}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((p) => {
        let k = p.status === "success" ? p.candles : [];
        if (kite && days === 1 && interval === "15m" && k.length) {
          const lastDay = new Date(k[k.length - 1].time * 1000).toISOString().slice(0, 10);
          k = k.filter((c) => new Date(c.time * 1000).toISOString().slice(0, 10) === lastDay);
        }
        if (ind && k.length) {
          k = withIndicators(k, ind);
          const from = new Date(new Date(`${k[k.length - 1].time}T00:00:00Z`).getTime() - (days || 365) * 86400000).toISOString().slice(0, 10);
          k = k.filter((c) => c.time >= from);
        }
        setCandles(k);
      })
      .catch(() => {});
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, source, interval, days, tick, kite]);
  useEffect(() => setTick(0), [interval, days]);

  // The chart is built once per interval / range / theme; a refresh only updates the candles and the
  // marked lines, so the zoom and scroll the user set are kept. It fits the view on its first data only.
  const chartRef = useRef(null);
  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    if (!box.current) return undefined;
    const c = colors(box.current);
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: c.text, fontFamily: "IBM Plex Sans, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: interval !== "day", secondsVisible: false },
    });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down,
    });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.subscribeCrosshairMove((p) => {
      const k = p.seriesData?.get(price);
      setHover(k ? { ...k, volume: p.seriesData.get(volume)?.value } : null);
    });
    let sma = null;
    let rsi = null;
    if (indicators && interval === "day") {
      sma = chart.addSeries(LineSeries, { color: c.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      rsi = chart.addSeries(LineSeries, { color: c.warning, lineWidth: 2, priceLineVisible: false, lastValueVisible: true }, 1);
      if (indicators.rsi?.level != null) {
        rsi.createPriceLine({ price: indicators.rsi.level, color: c.up, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "buy" });
      }
      rsi.createPriceLine({ price: 50, color: c.grid, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
      chart.panes()[1]?.setHeight(150);
    }
    chartRef.current = { chart, price, volume, sma, rsi, c, fitted: false, priceLines: [] };
    return () => {
      chartRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, days, theme]);

  useEffect(() => {
    const ref = chartRef.current;
    if (!ref) return;
    if (candles == null) {
      ref.fitted = false; // a new range / interval is loading: fit its candles when they arrive
      return;
    }
    if (!candles.length) return;
    const { chart, price, volume, c } = ref;
    price.setData(candles.map(({ volume: _, ...k }) => k));
    volume.setData(candles.map((k) => ({ time: k.time, value: k.volume, color: k.close >= k.open ? `${c.up}55` : `${c.down}55` })));
    if (ref.sma) ref.sma.setData(candles.filter((k) => k.sma != null).map((k) => ({ time: k.time, value: k.sma })));
    if (ref.rsi) ref.rsi.setData(candles.filter((k) => k.rsi != null).map((k) => ({ time: k.time, value: k.rsi })));
    if (!ref.fitted) {
      chart.timeScale().fitContent();
      ref.fitted = true;
    }
  }, [candles, interval, days, theme]);

  useEffect(() => {
    const ref = chartRef.current;
    if (!ref) return;
    ref.priceLines.forEach((pl) => ref.price.removePriceLine(pl));
    ref.priceLines = JSON.parse(linesKey)
      .filter((l) => l.price != null)
      .map((l) => ref.price.createPriceLine({ price: l.price, color: l.color || ref.c.text, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.label || "" }));
  }, [linesKey, interval, days, theme]);

  const last = candles?.[candles.length - 1];
  const show = hover || last;
  const ranges = interval === "day" ? (kite ? KITE_DAILY_RANGES : DAILY_RANGES) : kite ? KITE_RANGES : INTRADAY_RANGES;
  const fmt = (v) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const when = (t) => (typeof t === "number" ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : t);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-2" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${row.symbol} chart`}
        className="flex h-[95vh] w-[95vw] flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-base font-semibold">
            {row.symbol}
            {row.exchange ? <span className="ml-2 text-xs font-normal" style={{ color: "var(--faint)" }}>{row.exchange}</span> : null}
          </h2>
          <Segmented
            view
            label="Interval"
            options={[
              ["day", "Daily"],
              ["15m", "15 min", !has15, has15 ? undefined : "No 15-minute candles stored"],
            ]}
            value={interval}
            onChange={(v) => {
              setInterval(v);
              setDays(v === "day" ? (kite ? 180 : 365) : kite ? 1 : 30);
            }}
          />
          <Segmented view label="Range" options={ranges} value={days} onChange={setDays} />
          <button type="button" onClick={onClose} className="ml-auto rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>
            Close
          </button>
        </div>
        <p className="px-4 pt-2 text-xs tabular-nums" style={{ color: "var(--muted)" }}>
          {show ? (
            <>
              {when(show.time)} · O {fmt(show.open)} · H {fmt(show.high)} · L {fmt(show.low)} · C{" "}
              <span style={{ color: show.close >= show.open ? "var(--positive)" : "var(--negative)" }}>{fmt(show.close)}</span>
              {show.volume != null ? ` · Vol ${show.volume.toLocaleString("en-IN")}` : ""}
              {indicators && interval === "day" && candles?.length ? (() => {
                const k = candles.find((x) => x.time === show.time) || last;
                return (
                  <>
                    {" · "}
                    <span style={{ color: "var(--accent)" }}>SMA {indicators.sma} {fmt(k?.sma)}</span>
                    {" · "}
                    <span style={{ color: k?.rsi != null && k.rsi < (indicators.rsi?.level ?? 0) ? "var(--positive)" : "var(--warning)" }}>
                      RSI({indicators.rsi?.period}) {k?.rsi == null ? "—" : k.rsi.toFixed(1)}
                    </span>
                  </>
                );
              })() : null}
            </>
          ) : candles == null ? (
            "Loading…"
          ) : (
            "No candles."
          )}
          {interval !== "day" && " · times in IST"}
          {kite && " · live from Kite, refreshed every 30 s"}
        </p>
        <div ref={box} className="min-h-0 w-full flex-1 px-2 pb-3" />
      </div>
    </div>
  );
}
