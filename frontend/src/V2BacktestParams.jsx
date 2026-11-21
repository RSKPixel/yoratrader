import { useSetting } from "./settings";
import { useEffect, useState } from "react";
import { Field, formatRs, inputStyle, Segmented, useReadOnly } from "./V2Controls";

// The parameters every backtest has: universe, capital, max open positions, and whether results show
// as % of capital or rupees. Each model keeps its own values, remembered per browser.

export const DEFAULT_PARAMS = {
  capital: 1000000,
  maxOpen: 5,
  show: "rs",
  universe: "fno",
};
export const UNIVERSES = {
  fno: "F&O stocks",
  stocks: "Nifty 50 stocks",
  indices: "Indices",
};
const CAPITAL_PICKS = [500000, 1000000, 2500000, 5000000, 10000000];
const MAX_OPEN = 10;

// A model's saved parameters without the hook (e.g. the dashboard reading what a page was set to)
export function savedParams(values, model, defaults = {}) {
  // values: the user's settings (useSettings().values)
  return {
    ...DEFAULT_PARAMS,
    ...defaults,
    ...(values[`params.${model}`] || {}),
  };
}

// Parameters for one model: its saved values, else the defaults (its first universe; long-short models
// start at max open 6).
export function useBacktestParams(model, defaults = {}) {
  // saved per user on the server (settings key params.<model>)
  const [saved, setSaved] = useSetting(`params.${model}`, null);
  const params = { ...DEFAULT_PARAMS, ...defaults, ...(saved || {}) };
  const update = (patch) =>
    setSaved((a) => ({
      ...DEFAULT_PARAMS,
      ...defaults,
      ...(a || {}),
      ...patch,
    }));
  return [params, update];
}

export function CapitalInput({ value, onChange }) {
  const ro = useReadOnly();
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
          readOnly={ro}
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
            disabled={ro}
            aria-pressed={c === value}
            className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-[var(--surface-2)]"
            style={
              c === value
                ? { borderColor: "var(--accent)", color: "var(--accent)" }
                : { borderColor: "var(--border)", color: "var(--muted)" }
            }
          >
            {formatRs(c)}
          </button>
        ))}
      </div>
    </div>
  );
}

function BookStepper({ value, onChange }) {
  const ro = useReadOnly();
  const btn =
    "grid h-8 w-8 place-items-center text-base transition-colors hover:bg-[var(--surface)] disabled:opacity-40";
  return (
    <div
      className="inline-flex items-center self-start overflow-hidden rounded-md border"
      style={inputStyle}
    >
      <button
        type="button"
        className={btn}
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={value <= 1 || ro}
        aria-label="Fewer positions"
      >
        −
      </button>
      <span className="w-10 text-center text-sm tabular-nums">{value}</span>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(Math.min(MAX_OPEN, value + 1))}
        disabled={value >= MAX_OPEN || ro}
        aria-label="More positions"
      >
        +
      </button>
    </div>
  );
}

// No "as per model" sizing: always a fixed number of positions (a saved 0 from before reads as the default).
function MaxOpenStepper({ value, onChange, step: by = 1 }) {
  const ro = useReadOnly();
  const book = !value;
  const start = by > 1 ? 6 : 5;
  const step = (d) =>
    onChange(Math.min(MAX_OPEN, Math.max(by, (book ? start : value) + d * by)));
  const btn =
    "grid h-8 w-8 place-items-center text-base transition-colors hover:bg-[var(--surface)] disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center overflow-hidden rounded-md border"
        style={inputStyle}
      >
        <button
          type="button"
          className={btn}
          onClick={() => step(-1)}
          disabled={!book && value <= by || ro}
          aria-label="Fewer positions"
        >
          −
        </button>
        <span className="w-10 text-center text-sm tabular-nums">
          {book ? "—" : value}
        </span>
        <button
          type="button"
          className={btn}
          onClick={() => step(1)}
          disabled={!book && value >= MAX_OPEN || ro}
          aria-label="More positions"
        >
          +
        </button>
      </div>
    </div>
  );
}

export function LiveMaxOpen({ value, onChange, saving, limit = MAX_OPEN }) {
  const ro = useReadOnly();
  // A paper trader's own slot count, saved on the server (no "As per model")
  const btn =
    "grid h-8 w-8 place-items-center text-base transition-colors hover:bg-[var(--surface)] disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center overflow-hidden rounded-md border"
        style={inputStyle}
      >
        <button
          type="button"
          className={btn}
          onClick={() => onChange(value - 1)}
          disabled={saving || value <= 1 || ro}
          aria-label="Fewer positions"
        >
          −
        </button>
        <span className="w-10 text-center text-sm tabular-nums">{value}</span>
        <button
          type="button"
          className={btn}
          onClick={() => onChange(value + 1)}
          disabled={saving || value >= limit || ro}
          aria-label="More positions"
        >
          +
        </button>
      </div>
      {saving && (
        <span className="text-xs" style={{ color: "var(--faint)" }}>
          Saving…
        </span>
      )}
    </div>
  );
}

export default function V2BacktestParams({
  params,
  onChange,
  universes = ["fno"],
  step = 1,
  live = null,
  lots = false,
  pit = null,
  fixedOpen = null,
  books = null,
}) {
  // books: a page that sizes several books ([{ label, value, onChange, hint }]): a stepper each instead of Max open
  // fixedOpen: a page whose sizing is fixed by its own rules (text shown instead of the Max open stepper)
  // pit: a backtest page's survivorship choice ({ ok: the model can use it, value: "today" | "pit" }); null on paper pages
  // lots: paper trading in F&O, where each position is one lot: no capital input (the page shows the
  // capital required, the margin), and % results are of that margin.
  // live: a paper trader whose universe and max open are server settings the scheduler reads
  // ({ universe, universes, maxOpen, limit, saving, onUniverse, onMaxOpen }); changes apply from its next run.
  const maxOpen = live ? live.maxOpen : params.maxOpen;
  const per = maxOpen ? params.capital / maxOpen : null;
  return (
    <div
      className="flex flex-wrap items-end gap-x-8 gap-y-4 rounded-lg border px-4 py-3"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      {live ? (
        <Field
          label="Universe"
          hint="The stocks the scheduler looks for signals in, saved on the server: it applies from the next run. Open positions are still sold as usual."
        >
          <Segmented
            label="Universe"
            options={Object.entries(UNIVERSES).map(([u, text]) => [
              u,
              text,
              live.saving || !live.universes.includes(u),
              live.universes.includes(u)
                ? undefined
                : "Not available for this model",
            ])}
            value={live.universe}
            onChange={(u) => u !== live.universe && live.onUniverse(u)}
          />
        </Field>
      ) : (
        <Field
          label="Universe"
          hint="The stocks or indices the model trades; each model offers the ones it has"
        >
          <Segmented
            label="Universe"
            options={Object.entries(UNIVERSES).map(([u, text]) => [
              u,
              text,
              !universes.includes(u),
              universes.includes(u)
                ? undefined
                : "Not available for this model",
            ])}
            value={params.universe}
            onChange={(universe) => onChange({ universe })}
          />
        </Field>
      )}
      {pit && (
        <Field
          label="Survivorship bias"
          hint={
            pit.ok
              ? "On: today's F&O list for the whole history (only today's survivors: flatters the results). Off: each month's actual F&O list from NSE, 2007 on, including the stocks dropped since (the honest numbers; daily prices only, so an intraday model exits at the official close). F&O stocks only."
              : "Survivorship-free data is daily: this model needs 15-minute or 1-minute candles (or stored intraday trades), which don't exist for stocks dropped from F&O"
          }
        >
          <div className="self-start">
            <Segmented
              label="Survivorship bias"
              options={[
                [
                  "today",
                  "On",
                  params.universe === "cash500",
                  params.universe === "cash500"
                    ? "Top 500 is always survivorship-free: each month's list from the data known then"
                    : undefined,
                ],
                [
                  "pit",
                  "Off",
                  !pit.ok || !["fno", "cash500"].includes(params.universe),
                  !pit.ok
                    ? "Not available for this model"
                    : !["fno", "cash500"].includes(params.universe)
                      ? "F&O stocks or Top 500 only"
                      : undefined,
                ],
              ]}
              value={
                params.universe === "cash500"
                  ? "pit"
                  : pit.ok && params.universe === "fno"
                    ? pit.value
                    : "today"
              }
              onChange={(survivor) => onChange({ survivor })}
            />
          </div>
        </Field>
      )}
      {lots ? (
        <Field
          label="Size"
          hint="F&O trades in whole lots: each position is one lot of its future (today's lot sizes). The capital required is the margin, shown with the results."
        >
          <span className="block py-1.5 text-sm">1 lot per position</span>
        </Field>
      ) : (
        <Field
          label="Capital"
          hint="The value of the positions held (not margin: futures margin is roughly a fifth of it)"
        >
          <CapitalInput
            value={params.capital}
            onChange={(capital) => onChange({ capital })}
          />
        </Field>
      )}
      {books &&
        books.map((b) => (
          <Field key={b.label} label={b.label} hint={b.hint}>
            <BookStepper value={b.value} onChange={b.onChange} />
          </Field>
        ))}
      {!books && (
        <Field
          label="Max open"
          hint={
            fixedOpen
              ? "Fixed by each book's own rules (no option, so nothing to tune): RSI(2) holds up to 3 stocks, low volatility up to 10, each a share of its book"
              : live
                ? "How many positions the scheduler may hold, saved on the server: it applies from the next run. Open positions keep the size they were bought at (1 / the max open then); lowering it only stops new buys until enough are sold."
                : step > 1
                  ? "Long-short: as many shorts as longs, so this moves in 2s; Pairs picks how many of them are used. Capital ÷ N each."
                  : "At most this many positions at once, capital ÷ N each."
          }
        >
          {fixedOpen ? (
            <span className="block py-1.5 text-sm">{fixedOpen}</span>
          ) : live ? (
            <LiveMaxOpen
              value={live.maxOpen}
              onChange={live.onMaxOpen}
              saving={live.saving}
              limit={live.limit}
            />
          ) : (
            <MaxOpenStepper
              value={params.maxOpen}
              onChange={(maxOpen) => onChange({ maxOpen })}
              step={step}
            />
          )}
        </Field>
      )}
      <Field
        label="Show"
        hint={
          lots
            ? "Results in rupees (one lot each), or as % of the contract value traded"
            : "Results as % of capital or in rupees"
        }
      >
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
      <div
        className="ml-auto text-right text-sm"
        style={{ color: "var(--muted)" }}
      >
        {lots ? (
          <>1 lot each · {maxOpen} max</>
        ) : fixedOpen || books ? (
          "Each book: its share of capital ÷ its max open"
        ) : per ? (
          <>
            <span
              className="font-medium tabular-nums"
              style={{ color: "var(--text)" }}
            >
              {formatRs(per)}
            </span>{" "}
            per position · {maxOpen} max
          </>
        ) : (
          "Sized as per the model"
        )}
      </div>
    </div>
  );
}
