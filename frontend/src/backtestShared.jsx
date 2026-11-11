// Shared by the Backtest page and the KBDT Signals page.

// KBDT exit: 15:15 on the Nth trading day, entry day = day 1.
export const KBDT_EXITS = [
  ["1d", "Same day 15:15"],
  ["3d", "3rd day 15:15"],
  ["5d", "5th day 15:15"],
];

// KBDT stop: the model's previous-day low/high, a fixed % from entry, or the model stop capped at a %.
export const KBDT_STOP_MODES = [
  ["model", "Previous day"],
  ["fixed", "Fixed"],
  ["cap", "Capped"],
];

export const KBDT_STOP_PCTS = [
  [0.5, "0.5%"],
  [0.75, "0.75%"],
  [1, "1%"],
  [1.5, "1.5%"],
  [2, "2%"],
];

export const SLIPPAGE = [
  [0, "0%"],
  [0.01, "0.01%"],
  [0.02, "0.02%"],
  [0.05, "0.05%"],
];

export function formatR(value, digits = 2) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}R`;
}

export function formatRs(value) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}₹${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;
}

export function rClass(value) {
  if (value == null || value === 0) return "text-[#c8c3b8]";
  return value > 0 ? "text-[#8fbf9f]" : "text-[#f0b4b4]";
}

export function Segmented({ options, value, onChange, disabled }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-[#2c313a]">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          disabled={disabled}
          className={`px-3 py-1.5 text-sm disabled:opacity-60 ${
            value === id ? "bg-[#e2c08a]/15 text-[#e2c08a]" : "text-[#9b968c] hover:bg-white/5"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, className = "", title, sub }) {
  return (
    <div className="rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3" title={title}>
      <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">{label}</p>
      <p className={`mt-1 font-mono text-lg ${className}`}>{value}</p>
      {sub && <p className="mt-0.5 font-mono text-xs text-[#6f6a62]">{sub}</p>}
    </div>
  );
}
