import { useEffect, useState } from "react";

const COLUMNS = [
  { key: "time", label: "Date" },
  { key: "open", label: "O" },
  { key: "high", label: "H" },
  { key: "low", label: "L" },
  { key: "close", label: "C" },
  { key: "volume", label: "Vol" },
  { key: "bar_type", label: "Bar" },
  { key: "swing_point", label: "Swing" },
  { key: "direction", label: "Dir" },
  { key: "dow_cross", label: "Dow X" },
  { key: "dow_point", label: "Dow Pt" },
  { key: "mvf", label: "MVF" },
  { key: "ldv", label: "LDV" },
  { key: "lwv", label: "LWV" },
  { key: "atr", label: "ATR" },
  { key: "sma200", label: "SMA200" },
];

function formatCell(key, value) {
  if (value == null || value === "") return "—";
  if (key === "time" || key === "bar_type") return String(value);
  if (key === "volume") return Number(value).toLocaleString("en-IN");
  if (key === "direction" || key === "ldv" || key === "lwv") return String(value);
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);
  return number.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export default function UtDataModal({ contract, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      exchange: contract.exchange,
      symbol: contract.name,
    });

    fetch(`/api/ut-data?${params}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setRows([]);
          setError(payload.message || "Could not load UT data");
          return;
        }
        setRows(payload.data || []);
      })
      .catch((fetchError) => {
        if (fetchError.name === "AbortError") return;
        setError("Could not reach the API");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [contract]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-[#2c313a] bg-[#12151a] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[#2c313a] px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold text-[#f3efe6]">
              UT Data · {contract.name}
            </h2>
            <p className="mt-0.5 font-mono text-xs text-[#9b968c]">
              {contract.exchange} · {contract.tradingsymbol}
              {!loading && ` · ${rows.length} bars`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading && <p className="px-5 py-8 text-sm text-[#9b968c]">Loading UT dataset…</p>}
          {error && (
            <p className="m-4 rounded-md border border-[#6b3030] bg-[#2a1616] px-3 py-2 text-sm text-[#f0b4b4]">
              {error}
            </p>
          )}
          {!loading && !error && rows.length === 0 && (
            <p className="px-5 py-8 text-sm text-[#9b968c]">
              No UT data yet. Run <span className="text-[#e2c08a]">UT Data</span> after downloading EOD.
            </p>
          )}
          {!loading && rows.length > 0 && (
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              <thead className="sticky top-0 z-10 bg-[#1e2128] text-[0.65rem] uppercase tracking-wide text-[#9b968c]">
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      className="whitespace-nowrap border-b border-[#2c313a] px-3 py-2 font-medium"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono text-[#c8c3b8]">
                {[...rows].reverse().map((row) => (
                  <tr key={row.time} className="hover:bg-white/[0.03]">
                    {COLUMNS.map((column) => (
                      <td key={column.key} className="whitespace-nowrap border-b border-[#2c313a] px-3 py-1.5">
                        {formatCell(column.key, row[column.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
