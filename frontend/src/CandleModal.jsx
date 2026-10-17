import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";

function formatPrice(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function swingLinePoints(candles) {
  const points = [];
  for (const candle of candles) {
    let value = candle.swing_point;
    if (value == null) value = candle.swing_high;
    if (value == null) value = candle.swing_low;
    const number = Number(value);
    if (value == null || Number.isNaN(number)) continue;
    points.push({ time: candle.time, value: number });
  }
  return points;
}

function nearlyEqual(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  const tol = Math.max(0.05, Math.abs(right) * 1e-4);
  return Math.abs(left - right) <= tol;
}

/** Horizontal entry segment from the Dow swing that set the level → signal bar. */
function entryFromDowPoint(candles, signal) {
  const entry = Number(signal?.signal_price);
  if (signal?.datetime == null || Number.isNaN(entry)) return null;

  const signalIndex = candles.findIndex((candle) => candle.time === signal.datetime);
  if (signalIndex < 0) return null;

  const isBuy = String(signal.signal || "").toLowerCase() === "buy";
  let originIndex = -1;

  for (let i = signalIndex - 1; i >= 0; i -= 1) {
    const candle = candles[i];
    const swing = isBuy ? candle.swing_high : candle.swing_low;
    if (swing != null && nearlyEqual(swing, entry)) {
      originIndex = i;
      break;
    }
    if (
      candle.swing_point != null &&
      nearlyEqual(candle.swing_point, entry) &&
      ((isBuy && candle.swing_high != null) || (!isBuy && candle.swing_low != null))
    ) {
      originIndex = i;
      break;
    }
  }

  if (originIndex < 0) {
    for (let i = signalIndex - 1; i >= 0; i -= 1) {
      const candle = candles[i];
      if (
        (candle.dow_point != null && nearlyEqual(candle.dow_point, entry)) ||
        (candle.dow_cross != null && nearlyEqual(candle.dow_cross, entry))
      ) {
        originIndex = i;
      } else if (originIndex >= 0) {
        break;
      }
    }
  }

  if (originIndex < 0) originIndex = Math.max(0, signalIndex - 1);

  return [
    { time: candles[originIndex].time, value: entry },
    { time: candles[signalIndex].time, value: entry },
  ];
}

function timeOrder(a, b) {
  return String(a) <= String(b) ? -1 : 1;
}

export default function CandleModal({ contract, signal = null, onClose }) {
  const paneRef = useRef(null);
  const measureModeRef = useRef(false);
  const measureAnchorRef = useRef(null);
  const clearMeasureRef = useRef(() => {});

  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bar, setBar] = useState(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureInfo, setMeasureInfo] = useState(null);
  const [lotSize, setLotSize] = useState(
    () => Number(contract.lot_size || signal?.lot_size) || null
  );
  const symbolName = contract.name || contract.symbol;

  useEffect(() => {
    measureModeRef.current = measureMode;
  }, [measureMode]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (measureModeRef.current || measureAnchorRef.current || measureInfo) {
        setMeasureMode(false);
        clearMeasureRef.current();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, measureInfo]);

  useEffect(() => {
    const fromProps = Number(contract.lot_size || signal?.lot_size);
    if (fromProps && !Number.isNaN(fromProps)) {
      setLotSize(fromProps);
      return undefined;
    }
    const controller = new AbortController();
    fetch(`/api/contracts?exchange=${encodeURIComponent(contract.exchange || "ALL")}`, {
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((payload) => {
        const rows = payload.status === "success" ? payload.data || [] : [];
        const match = rows.find(
          (row) =>
            row.name === symbolName &&
            (!contract.exchange || row.exchange === contract.exchange)
        );
        if (match?.lot_size) setLotSize(Number(match.lot_size));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [contract, signal, symbolName]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      exchange: contract.exchange,
      symbol: symbolName,
    });

    Promise.all([
      fetch(`/api/ut-data?${params}`, { signal: controller.signal }).then((r) => r.json()),
      fetch(`/api/candles?${params}&enrich=true`, { signal: controller.signal }).then((r) => r.json()),
    ])
      .then(([utPayload, candlePayload]) => {
        const utRows = utPayload.status === "success" ? utPayload.data || [] : [];
        const candleRows = candlePayload.status === "success" ? candlePayload.data || [] : [];
        const rows = utRows.length > 0 ? utRows : candleRows;
        if (utPayload.status !== "success" && candlePayload.status !== "success") {
          setCandles([]);
          setError(candlePayload.message || utPayload.message || "Could not load candles");
          return;
        }
        setCandles(rows);
        const signalBar = signal?.datetime
          ? rows.find((row) => row.time === signal.datetime)
          : null;
        setBar(signalBar || rows.at(-1) || null);
      })
      .catch((fetchError) => {
        if (fetchError.name === "AbortError") return;
        setError("Could not reach the API");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [contract, signal, symbolName]);

  useEffect(() => {
    if (!paneRef.current || candles.length === 0) return undefined;

    measureAnchorRef.current = null;
    setMeasureInfo(null);

    const chart = createChart(paneRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0e1116" },
        textColor: "#9b968c",
        fontFamily: "IBM Plex Sans, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(42, 46, 54, 0.6)" },
        horzLines: { color: "rgba(42, 46, 54, 0.6)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2c313a" },
      timeScale: { borderColor: "#2c313a", rightOffset: 6 },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#089981",
      downColor: "#f23645",
      borderUpColor: "#089981",
      borderDownColor: "#f23645",
      wickUpColor: "#089981",
      wickDownColor: "#f23645",
    });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.08 } });
    const isbColor = "#f0e6a8";
    series.setData(
      candles.map(({ time, open, high, low, close, bar_type }) => {
        const bar = { time, open, high, low, close };
        if (String(bar_type || "").toUpperCase() === "ISB") {
          bar.color = isbColor;
          bar.borderColor = isbColor;
          bar.wickColor = isbColor;
        }
        return bar;
      })
    );

    const swingPoints = swingLinePoints(candles);
    if (swingPoints.length >= 2) {
      const swings = chart.addSeries(LineSeries, {
        color: "#e2c08a",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
      });
      swings.setData(swingPoints);
    }

    if (signal?.datetime) {
      const side = String(signal.signal || "").toLowerCase();
      const isBuy = side === "buy";
      const markerColor = isBuy ? "#7dcca8" : "#f0b4b4";
      createSeriesMarkers(series, [
        {
          time: signal.datetime,
          position: isBuy ? "belowBar" : "aboveBar",
          shape: isBuy ? "arrowUp" : "arrowDown",
          color: markerColor,
          size: 0.8,
          text: isBuy ? "BUY" : "SELL",
        },
      ]);

      const entryLine = entryFromDowPoint(candles, signal);
      if (entryLine && entryLine.length >= 2) {
        const entrySeries = chart.addSeries(LineSeries, {
          color: markerColor,
          lineWidth: 2,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 3,
        });
        entrySeries.setData(entryLine);
      }

      if (signal.stop_loss != null && !Number.isNaN(Number(signal.stop_loss))) {
        const signalIndex = candles.findIndex((candle) => candle.time === signal.datetime);
        if (signalIndex > 0) {
          const slSeries = chart.addSeries(LineSeries, {
            color: "#e2c08a",
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          slSeries.setData([
            { time: candles[signalIndex - 1].time, value: Number(signal.stop_loss) },
            { time: candles[signalIndex].time, value: Number(signal.stop_loss) },
          ]);
        }
      }

      const index = candles.findIndex((candle) => candle.time === signal.datetime);
      if (index >= 0) {
        const from = Math.max(0, index - 40);
        const to = Math.min(candles.length - 1, index + 10);
        chart.timeScale().setVisibleLogicalRange({ from, to });
      } else {
        chart.timeScale().fitContent();
      }
    } else {
      chart.timeScale().fitContent();
    }

    let measureSeries = null;
    const clearMeasure = () => {
      measureAnchorRef.current = null;
      setMeasureInfo(null);
      if (measureSeries) {
        try {
          chart.removeSeries(measureSeries);
        } catch {
          /* chart may already be gone */
        }
        measureSeries = null;
      }
    };
    clearMeasureRef.current = clearMeasure;

    const byTime = new Map(candles.map((candle) => [candle.time, candle]));
    chart.subscribeCrosshairMove((param) => {
      const next = param.seriesData?.get(series);
      if (!next) return;
      const time = param.time;
      const full = byTime.get(time) || {};
      setBar({ ...full, ...next, time });
    });

    chart.subscribeClick((param) => {
      if (!measureModeRef.current) return;
      if (!param.point || param.time == null) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price == null || Number.isNaN(Number(price))) return;

      const point = { time: param.time, price: Number(price) };
      const anchor = measureAnchorRef.current;

      if (!anchor) {
        measureAnchorRef.current = point;
        if (measureSeries) {
          try {
            chart.removeSeries(measureSeries);
          } catch {
            /* ignore */
          }
          measureSeries = null;
        }
        setMeasureInfo({ pending: true, from: point });
        return;
      }

      const delta = point.price - anchor.price;
      const pct = anchor.price !== 0 ? (delta / anchor.price) * 100 : null;
      const i0 = candles.findIndex((candle) => candle.time === anchor.time);
      const i1 = candles.findIndex((candle) => candle.time === point.time);
      const bars = i0 >= 0 && i1 >= 0 ? Math.abs(i1 - i0) : null;

      const sameBar = String(anchor.time) === String(point.time);
      if (!sameBar) {
        const ordered =
          timeOrder(anchor.time, point.time) <= 0
            ? [
                { time: anchor.time, value: anchor.price },
                { time: point.time, value: point.price },
              ]
            : [
                { time: point.time, value: point.price },
                { time: anchor.time, value: anchor.price },
              ];
        if (!measureSeries) {
          measureSeries = chart.addSeries(LineSeries, {
            color: "#c4b5fd",
            lineWidth: 2,
            lineStyle: 0,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 5,
          });
        }
        measureSeries.setData(ordered);
      }

      setMeasureInfo({
        pending: false,
        from: anchor,
        to: point,
        delta,
        pct,
        bars,
      });
      measureAnchorRef.current = null;
    });

    return () => {
      clearMeasureRef.current = () => {};
      chart.remove();
    };
  }, [candles, signal]);

  const up = bar && bar.close >= bar.open;
  const measureUp = measureInfo && !measureInfo.pending && measureInfo.delta >= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${symbolName} chart`}
        className="flex h-[min(720px,86vh)] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-[#2c313a] bg-[#0e1116] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#2c313a] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-lg font-semibold">{symbolName}</h2>
              {contract.tradingsymbol && (
                <span className="font-mono text-sm text-[#9b968c]">{contract.tradingsymbol}</span>
              )}
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                  contract.exchange === "NSE" ? "bg-[#1d3148] text-[#9ec4ef]" : "bg-[#3a2d1c] text-[#e2c08a]"
                }`}
              >
                {contract.exchange}
              </span>
              {signal && (
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-xs uppercase ${
                    signal.signal === "buy"
                      ? "bg-[#14352f] text-[#7dcca8]"
                      : "bg-[#3a1c1c] text-[#f0b4b4]"
                  }`}
                >
                  KBDT {signal.signal} · {signal.datetime}
                </span>
              )}
            </div>
            {bar && (
              <p className="mt-2 font-mono text-xs text-[#c8c3b8]">
                <span className="mr-3 text-[#9b968c]">{bar.time}</span>
                <span className="mr-3">O {formatPrice(bar.open)}</span>
                <span className="mr-3">H {formatPrice(bar.high)}</span>
                <span className="mr-3">L {formatPrice(bar.low)}</span>
                <span className={up ? "text-[#089981]" : "text-[#f23645]"}>C {formatPrice(bar.close)}</span>
                {(bar.swing_high != null || bar.swing_low != null) && (
                  <span className="ml-3 text-[#e2c08a]">
                    Swing {bar.swing_high != null ? `H ${formatPrice(bar.swing_high)}` : `L ${formatPrice(bar.swing_low)}`}
                  </span>
                )}
              </p>
            )}
            {measureInfo?.pending && (
              <p className="mt-2 font-mono text-xs text-[#c4b5fd]">
                Measure: click second point · Esc to cancel
              </p>
            )}
            {measureInfo && !measureInfo.pending && (
              <p className="mt-2 font-mono text-xs text-[#c8c3b8]">
                <span className="mr-3 text-[#c4b5fd]">Measure</span>
                <span className="mr-3 text-[#9b968c]">
                  {measureInfo.from.time} → {measureInfo.to.time}
                </span>
                <span className={`mr-3 ${measureUp ? "text-[#089981]" : "text-[#f23645]"}`}>
                  Δ {measureInfo.delta >= 0 ? "+" : ""}
                  {formatPrice(measureInfo.delta)}
                </span>
                <span className={`mr-3 ${measureUp ? "text-[#089981]" : "text-[#f23645]"}`}>
                  {formatPct(measureInfo.pct)}
                </span>
                {measureInfo.bars != null && (
                  <span className="mr-3 text-[#9b968c]">
                    {measureInfo.bars} bar{measureInfo.bars === 1 ? "" : "s"}
                  </span>
                )}
                {lotSize != null && (
                  <>
                    <span className="mr-3 text-[#9b968c]">
                      Lot {lotSize.toLocaleString("en-IN")}
                    </span>
                    <span className={measureUp ? "text-[#089981]" : "text-[#f23645]"}>
                      P/L {measureInfo.delta * lotSize >= 0 ? "+" : ""}
                      {(measureInfo.delta * lotSize).toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </>
                )}
              </p>
            )}
            <p className="mt-1 text-[0.65rem] text-[#6f6a62]">
              <span className="mr-3 text-[#e2c08a]">— swing line</span>
              <span className="mr-3 text-[#f0e6a8]">ISB</span>
              {signal && (
                <>
                  <span className="mr-3 text-[#7dcca8]">▲ buy / ▼ sell</span>
                  <span className="mr-3 text-[#e2c08a]">entry from Dow point · short SL</span>
                </>
              )}
              <span className="text-[#c4b5fd]">measure: two clicks</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !measureMode;
                setMeasureMode(next);
                if (!next) clearMeasureRef.current();
              }}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                measureMode
                  ? "border-[#c4b5fd] bg-[#c4b5fd]/15 text-[#c4b5fd]"
                  : "border-[#2c313a] text-[#c8c3b8] hover:bg-white/5"
              }`}
            >
              {measureMode ? "Measuring…" : "Measure"}
            </button>
            {measureInfo && (
              <button
                type="button"
                onClick={() => clearMeasureRef.current()}
                className="rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#9b968c] hover:bg-white/5"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5"
            >
              Close
            </button>
          </div>
        </div>

        <div className={`relative min-h-0 flex-1 ${measureMode ? "cursor-crosshair" : ""}`}>
          {loading && <p className="absolute inset-0 grid place-items-center text-sm text-[#9b968c]">Loading chart...</p>}
          {!loading && error && <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[#f0b4b4]">{error}</p>}
          {!loading && !error && candles.length === 0 && (
            <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[#9b968c]">
              No daily bars for {symbolName} yet. Download EOD first.
            </p>
          )}
          <div ref={paneRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
