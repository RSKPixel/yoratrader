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
      className="shrink-0 rounded px-1 py-px text-[0.5625rem] font-medium uppercase tracking-[0.08em]"
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
  // A second bar under the top nav: groups in order, each model with its Intraday / Positional tag.
  // Scrolls sideways when it doesn't fit.
  return (
    <nav
      className="shrink-0 overflow-x-auto border-b"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      aria-label="Backtests"
    >
      <div className="flex h-11 w-max min-w-full items-center gap-1 px-4 md:px-6">
        {BACKTEST_GROUPS.map((g, i) => (
          <div key={g.title} className="flex items-center gap-1">
            {i > 0 && <span className="mx-2 h-5 w-px" style={{ background: "var(--border)" }} aria-hidden="true" />}
            <span
              className="mr-1 whitespace-nowrap text-[0.625rem] font-semibold uppercase tracking-[0.14em]"
              style={{ color: "var(--faint)" }}
              title={g.source}
            >
              {g.title}
            </span>
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
                  title={`${m.label} · ${m.style}`}
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors hover:bg-[var(--surface-2)]"
                  style={active ? { background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 500 } : { color: "var(--text)" }}
                >
                  {m.label}
                  <StyleTag style={m.style} active={active} />
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

export default function V2Backtesting({ model, onSelect }) {
  const m = findBacktest(model) || findBacktest(DEFAULT_BACKTEST);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SubNav current={m.id} onSelect={onSelect} />
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
