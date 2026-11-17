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
import V2Mix from "./V2Mix";
import { Models } from "./V2Dashboard";
import { Panel } from "./V2BacktestView";

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
      { id: "xs-mean-reversion", step: 2, universes: ["fno", "stocks"], short: "XR", label: "Cross-sectional mean reversion", style: "Intraday", noBook: true },
      { id: "pairs", step: 2, universes: ["fno"], short: "PT", label: "Pairs trading", style: "Positional" },
      { id: "xs-momentum", step: 2, universes: ["fno", "stocks"], short: "XM", label: "Cross-sectional momentum", style: "Positional", pit: true },
    ],
  },
  {
    title: "Gray & Vogel",
    source: "Quantitative Momentum (Wiley, 2016)",
    models: [{ id: "quant-momentum", universes: ["fno", "stocks"], short: "QM", label: "Quantitative momentum", style: "Positional", pit: true }],
  },
  {
    title: "Larry Connors",
    source: "How Markets Really Work (2nd ed., 2012)",
    models: [{ id: "short-term-reversion", universes: ["fno", "stocks"], short: "SR", label: "Short-term mean reversion", style: "Positional", pit: true }],
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
    models: [{ id: "low-volatility", universes: ["fno"], short: "LV", label: "Long trend low volatility", style: "Positional", defaultOpen: 10, pit: true }],
  },
  {
    title: "Portfolio",
    source: "Our books together, with gold",
    models: [{ id: "books-gold", universes: ["fno"], short: "PG", label: "Books + gold", style: "Positional", pit: true, books: true }],
  },
];

const ALL = BACKTEST_GROUPS.flatMap((g) => g.models.map((m) => ({ ...m, group: g })));
export const DEFAULT_BACKTEST = ALL[0].id;

export function findBacktest(id) {
  return ALL.find((m) => m.id === id);
}

// The landing page (no model picked): every backtest at its default settings, as on the dashboard
function Landing({ onSelect }) {
  const { open, toggle, select } = useSideNav("yt-v2-backtest-nav", onSelect);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SideNav groups={BACKTEST_GROUPS} base="/v2/backtesting" title="Backtests" current={null} onSelect={select} open={open} onToggle={toggle} pinKey="backtesting" />
      <section className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Backtesting
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">All backtests</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Every model at its default settings (today's F&O list, survivorship bias on). Open one to change its settings or turn survivorship bias off.
        </p>
        <div className="mt-4">
          <Panel title="Strategies" right="click a model for its backtest">
            <Models />
          </Panel>
        </div>
      </section>
    </div>
  );
}

export default function V2Backtesting({ model, onSelect }) {
  const m = findBacktest(model);
  if (!m) return <Landing onSelect={onSelect} />;
  return <Model m={m} onSelect={onSelect} />;
}

function Model({ m, onSelect }) {
  const { open, toggle, select } = useSideNav("yt-v2-backtest-nav", onSelect);
  const [params, setParams] = useBacktestParams(m.id, { universe: m.universes[0], maxOpen: m.defaultOpen || (m.step > 1 ? 6 : 5) });
  // Per model; a saved universe the model no longer has falls back to its first.
  const universe = m.universes.includes(params.universe) ? params.universe : m.universes[0];
  // Long-short models need as many shorts as longs: Max open moves in 2s (an odd choice rounds up).
  const step = m.step || 1;
  // noBook: the model has no "As per model" sizing on its page (cross-sectional: always k + k, never Chan's every-stock book)
  const savedOpen = m.noBook && !params.maxOpen ? 6 : params.maxOpen;
  const maxOpen = savedOpen && step > 1 ? Math.min(10, Math.ceil(savedOpen / step) * step) : savedOpen;
  // Survivorship-free (each month's F&O list): the "fnopit" dataset, for daily-close models on F&O stocks
  const pit = !!m.pit && universe === "fno" && params.survivor === "pit";
  const modelParams = { ...params, universe: pit ? "fnopit" : universe, maxOpen };
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
          <V2BacktestParams params={{ ...modelParams, universe }} onChange={setParams} universes={m.universes} step={step}
            pit={{ ok: !!m.pit, value: pit ? "pit" : "today" }}
            fixedOpen={m.fixedOpen}
            noBook={!!m.noBook}
            books={
              m.books
                ? [
                    { label: "Mean reversion max open", value: params.rsiOpen ?? 3, onChange: (n) => setParams({ rsiOpen: n }), hint: "Up to this many short-term mean reversion stocks at once (RSI(2) or cumulative RSI(2)), that book's share of capital ÷ N each (the book: 3)" },
                    { label: "Low volatility max open", value: params.lvOpen ?? 10, onChange: (n) => setParams({ lvOpen: n }), hint: "Up to this many low volatility stocks at once, its share of capital ÷ N each (the book: 10)" },
                  ]
                : null
            }
          />
        </div>
        {m.id === "buy-on-gap" && <V2BuyOnGap params={modelParams} />}
        {m.id === "oops" && <V2Oops params={modelParams} />}
        {m.id === "turn-of-month" && <V2Tom params={modelParams} />}
        {m.id === "low-volatility" && <V2Ltlv params={modelParams} />}
        {m.id === "books-gold" && <V2Mix params={modelParams} />}
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
