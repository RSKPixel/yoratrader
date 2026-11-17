import { StatusButtons } from "./modelStatus";
import { SideNav, StyleTag, useSideNav } from "./V2SideNav";
import V2BacktestParams, { useBacktestParams } from "./V2BacktestParams";
import V2BuyOnGap from "./V2BuyOnGap";
import V2Kbdt from "./V2Kbdt";
import V2Xsmr from "./V2Xsmr";
import V2Pairs from "./V2Pairs";
import V2Xsmom from "./V2Xsmom";
import V2Qmom from "./V2Qmom";
import V2Connors from "./V2Connors";
import V2Oops from "./V2Oops";
import V2Tom from "./V2Tom";
import V2Ltlv from "./V2Ltlv";

// v2 Backtesting: a sub nav of every model with a backtest, grouped by where it comes from. Each
// model has its own page below the shared parameters.

export const BACKTEST_GROUPS = [
  {
    title: "YoraTrader",
    source: "Our own model",
    models: [{ id: "kbdt", universes: ["indices", "stocks", "fno"], short: "KB", label: "Key Breakout Dow Theory", style: "Positional" }],
  },
  {
    title: "Ernest Chan",
    source: "Algorithmic Trading (Wiley, 2013)",
    models: [
      { id: "buy-on-gap", universes: ["fno", "stocks", "indices"], short: "BG", label: "Buy/Sell on gap", style: "Intraday" },
      { id: "gap-momentum", universes: ["indices", "fno"], short: "GM", label: "Opening gap momentum", style: "Intraday" },
      { id: "xs-mean-reversion", step: 2, universes: ["fno", "stocks"], short: "XR", label: "Cross-sectional mean reversion", style: "Intraday" },
      { id: "pairs", step: 2, universes: ["fno"], short: "PT", label: "Pairs trading", style: "Positional" },
      { id: "xs-momentum", step: 2, universes: ["fno", "stocks"], short: "XM", label: "Cross-sectional momentum", style: "Positional" },
    ],
  },
  {
    title: "Gray & Vogel",
    source: "Quantitative Momentum (Wiley, 2016)",
    models: [{ id: "quant-momentum", universes: ["fno", "stocks"], short: "QM", label: "Quantitative momentum", style: "Positional" }],
  },
  {
    title: "Larry Connors",
    source: "How Markets Really Work (2nd ed., 2012)",
    models: [{ id: "short-term-reversion", universes: ["fno", "stocks"], short: "SR", label: "Short-term mean reversion", style: "Positional" }],
  },
  {
    title: "Larry Williams",
    source: "Long-Term Secrets to Short-Term Trading (Wiley, 2011)",
    models: [
      { id: "oops", universes: ["fno"], short: "OP", label: "Oops gap reversal", style: "Intraday" },
      { id: "turn-of-month", universes: ["indices"], short: "TM", label: "Turn of the month", style: "Positional" },
    ],
  },
  {
    title: "Laurens Bensdorp",
    source: "Automated Stock Trading Systems (2020)",
    models: [{ id: "low-volatility", universes: ["fno"], short: "LV", label: "Long trend low volatility", style: "Positional", defaultOpen: 10 }],
  },
];

const ALL = BACKTEST_GROUPS.flatMap((g) => g.models.map((m) => ({ ...m, group: g })));
export const DEFAULT_BACKTEST = ALL[0].id;

export function findBacktest(id) {
  return ALL.find((m) => m.id === id);
}

export default function V2Backtesting({ model, onSelect }) {
  const m = findBacktest(model) || findBacktest(DEFAULT_BACKTEST);
  const { open, toggle, select } = useSideNav("yt-v2-backtest-nav", onSelect);
  const [params, setParams] = useBacktestParams(m.id, { universe: m.universes[0], maxOpen: m.defaultOpen || (m.step > 1 ? 6 : 5) });
  // Per model; a saved universe the model no longer has falls back to its first.
  const universe = m.universes.includes(params.universe) ? params.universe : m.universes[0];
  // Long-short models need as many shorts as longs: Max open moves in 2s (an odd choice rounds up).
  const step = m.step || 1;
  const maxOpen = params.maxOpen && step > 1 ? Math.min(10, Math.ceil(params.maxOpen / step) * step) : params.maxOpen;
  const modelParams = { ...params, universe, maxOpen };
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SideNav groups={BACKTEST_GROUPS} base="/v2/backtesting" title="Backtests" current={m.id} onSelect={select} open={open} onToggle={toggle} pinKey="backtesting" />
      <section className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          {m.group.title} · {m.group.source}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{m.label}</h1>
          <StyleTag style={m.style} />
          <span className="ml-auto">
            <StatusButtons id={m.id} />
          </span>
        </div>
        <div className="mt-4">
          <V2BacktestParams params={modelParams} onChange={setParams} universes={m.universes} step={step} />
        </div>
        {m.id === "buy-on-gap" && <V2BuyOnGap params={modelParams} />}
        {m.id === "oops" && <V2Oops params={modelParams} />}
        {m.id === "turn-of-month" && <V2Tom params={modelParams} />}
        {m.id === "low-volatility" && <V2Ltlv params={modelParams} />}
        {m.id === "gap-momentum" && <V2BuyOnGap params={modelParams} model="gapmom" key="gapmom" />}
        {m.id === "kbdt" && <V2Kbdt params={modelParams} />}
        {m.id === "xs-mean-reversion" && <V2Xsmr params={modelParams} />}
        {m.id === "pairs" && <V2Pairs params={modelParams} />}
        {m.id === "xs-momentum" && <V2Xsmom params={modelParams} />}
        {m.id === "quant-momentum" && <V2Qmom params={modelParams} />}
        {m.id === "short-term-reversion" && <V2Connors params={modelParams} />}
      </section>
    </div>
  );
}
