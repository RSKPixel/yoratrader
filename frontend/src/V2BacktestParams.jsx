import { useEffect, useState } from "react";
import { Field, formatRs, inputStyle, Segmented } from "./V2Controls";

// The parameters every backtest has: universe, capital, max open positions, and whether results show
// as % of capital or rupees. Each model keeps its own values, remembered per browser.

const KEY = "yt-v2-backtest-params-by-model";
export const DEFAULT_PARAMS = { capital: 1000000, maxOpen: 5, show: "rs", universe: "fno" };
export const UNIVERSES = { fno: "F&O stocks", stocks: "Nifty 50 stocks", indices: "Indices" };
const CAPITAL_PICKS = [500000, 1000000, 2500000, 5000000, 10000000];
const MAX_OPEN = 10;

function loadAll() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") return saved;
  } catch {
    // nothing saved, or storage blocked
  }
  return {};
}

// Parameters for one model: its saved values, else the defaults (its first universe; long-short models
// start at max open 6).
export function useBacktestParams(model, defaults = {}) {
  const [all, setAll] = useState(loadAll);
  const params = { ...DEFAULT_PARAMS, ...defaults, ...(all[model] || {}) };
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // not saved: still applies for this visit
    }
  }, [all]);
  const update = (patch) => setAll((a) => ({ ...a, [model]: { ...DEFAULT_PARAMS, ...defaults, ...(a[model] || {}), ...patch } }));
  return [params, update];
}

function CapitalInput({ value, onChange }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(String(text).replace(/[^0-9.]/g, "")));
    if (n >= 10000) onChange(n);
    else setText(String(value));
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center rounded-md border" style={inputStyle}>
        <span className="pl-2.5 text-sm" style={{ color: "var(--faint)" }}>
          ₹
        </span>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && commit()}
          inputMode="numeric"
          aria-label="Capital in rupees"
          className="w-28 bg-transparent px-1.5 py-1.5 text-sm tabular-nums outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {CAPITAL_PICKS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-pressed={c === value}
            className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-2)]"
            style={c === value ? { borderColor: "var(--accent)", color: "var(--accent)" } : { borderColor: "var(--border)", color: "var(--muted)" }}
          >
            {formatRs(c)}
          </button>
        ))}
      </div>
    </div>
  );
}

function MaxOpenStepper({ value, onChange, step: by = 1 }) {
  const book = value === 0;
  const start = by > 1 ? 6 : 5;
  const step = (d) => onChange(Math.min(MAX_OPEN, Math.max(by, (book ? start : value) + d * by)));
  const btn = "grid h-8 w-8 place-items-center text-base transition-colors hover:bg-[var(--surface)] disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center overflow-hidden rounded-md border" style={inputStyle}>
        <button type="button" className={btn} onClick={() => step(-1)} disabled={!book && value <= by} aria-label="Fewer positions">
          −
        </button>
        <span className="w-10 text-center text-sm tabular-nums">{book ? "—" : value}</span>
        <button type="button" className={btn} onClick={() => step(1)} disabled={!book && value >= MAX_OPEN} aria-label="More positions">
          +
        </button>
      </div>
      <button
        type="button"
        onClick={() => onChange(book ? start : 0)}
        aria-pressed={book}
        className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-2)]"
        style={book ? { borderColor: "var(--accent)", color: "var(--accent)" } : { borderColor: "var(--border)", color: "var(--muted)" }}
        title="Each model's own sizing instead of a fixed number of positions"
      >
        As per model
      </button>
    </div>
  );
}

export default function V2BacktestParams({ params, onChange, universes = ["fno"], step = 1 }) {
  const per = params.maxOpen ? params.capital / params.maxOpen : null;
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-4 rounded-lg border px-4 py-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <Field label="Universe" hint="The stocks or indices the model trades; each model offers the ones it has">
        <Segmented
          label="Universe"
          options={Object.entries(UNIVERSES).map(([u, text]) => [u, text, !universes.includes(u), universes.includes(u) ? undefined : "Not available for this model"])}
          value={params.universe}
          onChange={(universe) => onChange({ universe })}
        />
      </Field>
      <Field label="Capital" hint="The value of the positions held (not margin: futures margin is roughly a fifth of it)">
        <CapitalInput value={params.capital} onChange={(capital) => onChange({ capital })} />
      </Field>
      <Field
        label="Max open"
        hint={
          step > 1
            ? "Long-short: as many shorts as longs, so this moves in 2s; Pairs picks how many of them are used. Capital ÷ N each. As per model: the model's own sizing."
            : "At most this many positions at once, capital ÷ N each. As per model: each model's own sizing."
        }
      >
        <MaxOpenStepper value={params.maxOpen} onChange={(maxOpen) => onChange({ maxOpen })} step={step} />
      </Field>
      <Field label="Show" hint="Results as % of capital or in rupees">
        <Segmented
          label="Show results as"
          options={[
            ["pct", "%"],
            ["rs", "₹"],
          ]}
          value={params.show}
          onChange={(show) => onChange({ show })}
        />
      </Field>
      <div className="ml-auto text-right text-sm" style={{ color: "var(--muted)" }}>
        {per ? (
          <>
            <span className="font-medium tabular-nums" style={{ color: "var(--text)" }}>
              {formatRs(per)}
            </span>{" "}
            per position · {params.maxOpen} max
          </>
        ) : (
          "Sized as per the model"
        )}
      </div>
    </div>
  );
}
