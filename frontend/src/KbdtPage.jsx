import { useEffect, useRef, useState } from "react";
import CandleModal from "./CandleModal";

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function KbdtPage({ scanning, onScan }) {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyBars, setHistoryBars] = useState(40);
  const [chartSignal, setChartSignal] = useState(null);
  const wasScanning = useRef(false);

  const loadSignals = ({ quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    return fetch("/api/kbdt/signals")
      .then((response) => response.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setSignals([]);
          setError(payload.message || "Could not load signals");
          return;
        }
        setSignals(payload.data || []);
      })
      .catch(() => {
        setSignals([]);
        setError("Could not reach the API");
      })
      .finally(() => {
        if (!quiet) setLoading(false);
      });
  };

  useEffect(() => {
    loadSignals();
  }, []);

  // Reload when a scan finishes (scanning true → false). More reliable than WS alone.
  useEffect(() => {
    if (wasScanning.current && !scanning) {
      loadSignals({ quiet: true });
    }
    wasScanning.current = scanning;
  }, [scanning]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Key Breakout Dow Theory</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#9b968c]">
            Scans UT-enriched EOD with <span className="font-mono text-[#c8c3b8]">signals2</span>{" "}
            (KBDT): dow cross with trend, opposing setup, negative prior profit, weekly LV on.
          </p>
          <p className="mt-2 font-mono text-xs text-[#e2c08a]">
            {loading ? "Loading…" : `${signals.length} signal${signals.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[#9b968c]">
            Lookback bars
            <input
              type="text"
              inputMode="numeric"
              value={historyBars}
              onChange={(event) => {
                const next = event.target.value.replace(/\D/g, "");
                setHistoryBars(next === "" ? "" : Number(next));
              }}
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              className="w-16 rounded-md border border-[#2c313a] bg-[#181b20] px-2 py-1.5 font-mono text-sm text-[#e7e4dc] outline-none focus:border-[#8d877c]"
            />
          </label>
          <button
            type="button"
            onClick={() => onScan({ history_bars: Number(historyBars) || 40 })}
            disabled={scanning}
            className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
          >
            {scanning ? "Scanning" : "Generate signals"}
          </button>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-[#6b3030] bg-[#2a1616] px-3 py-2 text-sm text-[#f0b4b4]">
          {error}
        </p>
      )}

      <section className="min-h-0 flex-1 overflow-auto rounded-md border border-[#2c313a] bg-[#181b20]" style={{ minHeight: "12rem" }}>
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-[#1e2128] text-left text-xs uppercase tracking-wide text-[#9b968c]">
            <tr>
              <th className="border-b border-[#2c313a] px-4 py-3 font-medium">Date</th>
              <th className="border-b border-[#2c313a] px-4 py-3 font-medium">Exchange</th>
              <th className="border-b border-[#2c313a] px-4 py-3 font-medium">Script</th>
              <th className="border-b border-[#2c313a] px-4 py-3 font-medium">Signal</th>
              <th className="border-b border-[#2c313a] px-4 py-3 text-right font-medium">Entry</th>
              <th className="border-b border-[#2c313a] px-4 py-3 text-right font-medium">Stop</th>
              <th className="border-b border-[#2c313a] px-4 py-3 text-right font-medium">Close</th>
              <th className="border-b border-[#2c313a] px-4 py-3 text-right font-medium">Dir</th>
              <th className="border-b border-[#2c313a] px-4 py-3 text-right font-medium">Chart</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((row) => (
              <tr key={`${row.exchange}-${row.symbol}-${row.datetime}-${row.signal}`}>
                <td className="border-b border-[#2c313a] px-4 py-2.5 font-mono text-[#c8c3b8]">
                  {row.datetime}
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                      row.exchange === "NSE"
                        ? "bg-[#1d3148] text-[#9ec4ef]"
                        : "bg-[#3a2d1c] text-[#e2c08a]"
                    }`}
                  >
                    {row.exchange}
                  </span>
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 font-medium">{row.symbol}</td>
                <td className="border-b border-[#2c313a] px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-xs uppercase ${
                      row.signal === "buy"
                        ? "bg-[#14352f] text-[#7dcca8]"
                        : "bg-[#3a1c1c] text-[#f0b4b4]"
                    }`}
                  >
                    {row.signal}
                  </span>
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right font-mono">
                  {formatPrice(row.signal_price)}
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right font-mono text-[#9b968c]">
                  {formatPrice(row.stop_loss)}
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right font-mono">
                  {formatPrice(row.close)}
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right font-mono text-[#9b968c]">
                  {row.direction == null ? "—" : row.direction > 0 ? "+1" : "−1"}
                </td>
                <td className="border-b border-[#2c313a] px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => setChartSignal(row)}
                    className="rounded border border-[#2c313a] px-2 py-1 text-xs text-[#e2c08a] hover:bg-white/5"
                    aria-label={`Open chart for ${row.symbol} ${row.signal}`}
                  >
                    Chart
                  </button>
                </td>
              </tr>
            ))}
            {!loading && signals.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-[#9b968c]">
                  No signals yet. Download EOD, run UT Data, then Generate signals.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-[#9b968c]">
                  Loading signals…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {chartSignal && (
        <CandleModal
          contract={{
            exchange: chartSignal.exchange,
            name: chartSignal.symbol,
            symbol: chartSignal.symbol,
            lot_size: chartSignal.lot_size,
          }}
          signal={chartSignal}
          onClose={() => setChartSignal(null)}
        />
      )}
    </div>
  );
}
