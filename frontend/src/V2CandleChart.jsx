import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, createChart, HistogramSeries, LineStyle } from "lightweight-charts";
import { Segmented } from "./V2Controls";

// A candlestick chart with volume for one symbol, on the v2 theme. Daily or 15 min.
// source "kite": the stock straight from Kite with today's candles (paper pages), refreshed while open;
// lines: price lines to mark, e.g. [{ price, label, color }] for a position's entry / stop / exit.

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
const KITE_RANGES = [
  [1, "Today"],
  [5, "5D"],
  [30, "1M"],
];

function colors(el) {
  const css = getComputedStyle(el.closest(".v2") || document.body);
  const v = (n) => css.getPropertyValue(n).trim();
  return { text: v("--muted"), grid: v("--border"), up: v("--positive"), down: v("--negative"), faint: v("--faint") };
}

export default function V2CandleChart({ row, source, onClose, lines = [], initialInterval = "day", initialDays = null }) {
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
    const ask = kite && days === 1 ? 5 : days;
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
        setCandles(k);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [row, source, interval, days, tick, kite]);
  useEffect(() => setTick(0), [interval, days]);

  useEffect(() => {
    if (!box.current || !candles?.length) return undefined;
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
    price.setData(candles.map(({ volume: _, ...k }) => k));
    volume.setData(candles.map((k) => ({ time: k.time, value: k.volume, color: k.close >= k.open ? `${c.up}55` : `${c.down}55` })));
    for (const l of lines) {
      if (l.price != null) {
        price.createPriceLine({ price: l.price, color: l.color || c.text, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.label || "" });
      }
    }
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((p) => {
      const k = p.seriesData?.get(price);
      setHover(k ? { ...k, volume: p.seriesData.get(volume)?.value } : null);
    });
    return () => chart.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, interval, theme, lines]);

  const last = candles?.[candles.length - 1];
  const show = hover || last;
  const ranges = interval === "day" ? DAILY_RANGES : kite ? KITE_RANGES : INTRADAY_RANGES;
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
            label="Interval"
            options={[
              ["day", "Daily"],
              ["15m", "15 min", !has15, has15 ? undefined : "No 15-minute candles stored"],
            ]}
            value={interval}
            onChange={(v) => {
              setInterval(v);
              setDays(v === "day" ? 365 : kite ? 1 : 30);
            }}
          />
          <Segmented label="Range" options={ranges} value={days} onChange={setDays} />
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
