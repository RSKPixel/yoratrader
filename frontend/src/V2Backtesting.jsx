import { useState } from "react";
import V2BacktestParams, { useBacktestParams } from "./V2BacktestParams";

// v2 Backtesting: a sub nav of every model with a backtest, grouped by where it comes from. Each
// model's page is blank for now; they move over from the classic app one by one.

export const BACKTEST_GROUPS = [
  {
    title: "YoraTrader",
    source: "Our own model",
    models: [{ id: "kbdt", short: "KB", label: "Key Breakout Dow Theory", style: "Positional" }],
  },
  {
    title: "Ernest Chan",
    source: "Algorithmic Trading (Wiley, 2013)",
    models: [
      { id: "buy-on-gap", short: "BG", label: "Buy on gap", style: "Intraday" },
      { id: "gap-momentum", short: "GM", label: "Opening gap momentum", style: "Intraday" },
      { id: "xs-mean-reversion", short: "XR", label: "Cross-sectional mean reversion", style: "Intraday" },
      { id: "pairs", short: "PT", label: "Pairs trading", style: "Positional" },
      { id: "xs-momentum", short: "XM", label: "Cross-sectional momentum", style: "Positional" },
    ],
  },
  {
    title: "Gray & Vogel",
    source: "Quantitative Momentum (Wiley, 2016)",
    models: [{ id: "quant-momentum", short: "QM", label: "Quantitative momentum", style: "Positional" }],
  },
  {
    title: "Larry Connors",
    source: "How Markets Really Work (2nd ed., 2012)",
    models: [{ id: "short-term-reversion", short: "SR", label: "Short-term mean reversion", style: "Positional" }],
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

const NAV_KEY = "yt-v2-backtest-nav";

function Chevron({ left }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {left ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

function SubNav({ current, onSelect, open, onToggle }) {
  const item = (m, active) => ({
    href: `/v2/backtesting/${m.id}`,
    onClick: (event) => {
      event.preventDefault();
      onSelect(m.id);
    },
    "aria-current": active ? "page" : undefined,
  });
  if (!open) {
    return (
      <nav
        className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-3"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        aria-label="Backtests"
      >
        <button
          type="button"
          onClick={onToggle}
          className="mb-2 grid h-8 w-8 place-items-center rounded-md hover:bg-[var(--surface-2)]"
          style={{ color: "var(--muted)" }}
          aria-label="Show the model list"
          title="Show the model list"
        >
          <Chevron />
        </button>
        {BACKTEST_GROUPS.map((g, i) => (
          <div key={g.title} className="flex flex-col items-center gap-1">
            {i > 0 && <span className="my-1 h-px w-6" style={{ background: "var(--border)" }} aria-hidden="true" />}
            {g.models.map((m) => {
              const active = m.id === current;
              return (
                <a
                  key={m.id}
                  {...item(m, active)}
                  title={`${m.label} · ${m.style} (${g.title})`}
                  className="grid h-8 w-8 place-items-center rounded-md text-[0.6875rem] font-semibold transition-colors hover:bg-[var(--surface-2)]"
                  style={active ? { background: "var(--accent-soft)", color: "var(--accent)" } : { color: "var(--muted)" }}
                >
                  {m.short}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
    );
  }
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-10 bg-black/40 md:hidden"
        onClick={onToggle}
        aria-label="Close the model list"
      />
      <nav
        className="absolute inset-y-0 left-0 z-20 flex w-80 shrink-0 flex-col overflow-y-auto border-r md:static md:z-auto"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        aria-label="Backtests"
      >
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
            Backtests
          </span>
          <button
            type="button"
            onClick={onToggle}
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--surface-2)]"
            style={{ color: "var(--muted)" }}
            aria-label="Collapse the model list"
            title="Collapse"
          >
            <Chevron left />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-3 pb-4 pt-2">
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
                      {...item(m, active)}
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
        </div>
      </nav>
    </>
  );
}

function initialOpen() {
  try {
    const saved = localStorage.getItem(NAV_KEY);
    if (saved === "open" || saved === "closed") return saved === "open";
  } catch {
    // storage blocked: use the default
  }
  return window.matchMedia?.("(min-width: 768px)").matches ?? true;
}

export default function V2Backtesting({ model, onSelect }) {
  const m = findBacktest(model) || findBacktest(DEFAULT_BACKTEST);
  const [open, setOpen] = useState(initialOpen);
  const [params, setParams] = useBacktestParams();
  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem(NAV_KEY, was ? "closed" : "open");
      } catch {
        // not saved: still toggles for this visit
      }
      return !was;
    });
  };
  const select = (id) => {
    onSelect(id);
    if (!window.matchMedia?.("(min-width: 768px)").matches) setOpen(false); // narrow screens: close after picking
  };
  return (
    <div className="relative flex min-h-0 flex-1">
      <SubNav current={m.id} onSelect={select} open={open} onToggle={toggle} />
      <section className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          {m.group.title} · {m.group.source}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{m.label}</h1>
          <StyleTag style={m.style} />
        </div>
        <div className="mt-4">
          <V2BacktestParams params={params} onChange={setParams} />
        </div>
      </section>
    </div>
  );
}
