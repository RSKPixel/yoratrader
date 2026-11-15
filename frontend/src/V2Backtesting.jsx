// v2 Backtesting: a sub nav of every model with a backtest, grouped by where it comes from. Each
// model's page is blank for now; they move over from the classic app one by one.

export const BACKTEST_GROUPS = [
  {
    title: "YoraTrader",
    source: "Our own model",
    models: [{ id: "kbdt", label: "Key Breakout Dow Theory", style: "Positional" }],
  },
  {
    title: "Ernest Chan",
    source: "Algorithmic Trading (Wiley, 2013)",
    models: [
      { id: "buy-on-gap", label: "Buy on gap", style: "Intraday" },
      { id: "gap-momentum", label: "Opening gap momentum", style: "Intraday" },
      { id: "xs-mean-reversion", label: "Cross-sectional mean reversion", style: "Intraday" },
      { id: "pairs", label: "Pairs trading", style: "Positional" },
      { id: "xs-momentum", label: "Cross-sectional momentum", style: "Positional" },
    ],
  },
  {
    title: "Gray & Vogel",
    source: "Quantitative Momentum (Wiley, 2016)",
    models: [{ id: "quant-momentum", label: "Quantitative momentum", style: "Positional" }],
  },
  {
    title: "Larry Connors",
    source: "How Markets Really Work (2nd ed., 2012)",
    models: [{ id: "short-term-reversion", label: "Short-term mean reversion", style: "Positional" }],
  },
];

const ALL = BACKTEST_GROUPS.flatMap((g) => g.models.map((m) => ({ ...m, group: g })));
export const DEFAULT_BACKTEST = ALL[0].id;

export function findBacktest(id) {
  return ALL.find((m) => m.id === id);
}

function StyleTag({ style, active }) {
  const intraday = style === "Intraday";
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-[0.08em]"
      style={{
        background: active ? "var(--surface)" : "var(--surface-2)",
        color: intraday ? "var(--accent)" : "var(--muted)",
      }}
    >
      {intraday ? "Intraday" : "Positional"}
    </span>
  );
}

function SubNav({ current, onSelect }) {
  return (
    <nav className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r p-4 md:flex" style={{ borderColor: "var(--border)", background: "var(--surface)" }} aria-label="Backtests">
      {BACKTEST_GROUPS.map((g) => (
        <div key={g.title}>
          <p className="px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }} title={g.source}>
            {g.title}
          </p>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {g.models.map((m) => {
              const active = m.id === current;
              return (
                <a
                  key={m.id}
                  href={`/v2/backtesting/${m.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(m.id);
                  }}
                  aria-current={active ? "page" : undefined}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)]"
                  style={active ? { background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 500 } : { color: "var(--text)" }}
                >
                  <span className="truncate">{m.label}</span>
                  <StyleTag style={m.style} active={active} />
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function SubNavSelect({ current, onSelect }) {
  return (
    <div className="border-b p-3 md:hidden" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <label className="sr-only" htmlFor="v2-backtest">
        Backtest
      </label>
      <select
        id="v2-backtest"
        value={current}
        onChange={(event) => onSelect(event.target.value)}
        className="w-full rounded-md border px-3 py-2 text-sm"
        style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
      >
        {BACKTEST_GROUPS.map((g) => (
          <optgroup key={g.title} label={g.title}>
            {g.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.style})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export default function V2Backtesting({ model, onSelect }) {
  const m = findBacktest(model) || findBacktest(DEFAULT_BACKTEST);
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <SubNav current={m.id} onSelect={onSelect} />
      <SubNavSelect current={m.id} onSelect={onSelect} />
      <section className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          {m.group.title} · {m.group.source}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{m.label}</h1>
          <StyleTag style={m.style} />
        </div>
      </section>
    </div>
  );
}
