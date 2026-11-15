import V2BacktestParams, { useBacktestParams } from "./V2BacktestParams";
import V2PaperConnors from "./V2PaperConnors";
import V2PaperGap from "./V2PaperGap";
import V2PaperXsmr from "./V2PaperXsmr";
import { SideNav, StyleTag, useSideNav } from "./V2SideNav";

// v2 Paper trading: a side nav of the models the production scheduler paper-trades, each page sized
// by its own capital / max open / show (universe: the F&O stocks).

export const PAPER_GROUPS = [
  {
    title: "Ernest Chan",
    source: "Algorithmic Trading (Wiley, 2013)",
    models: [
      { id: "buy-on-gap", short: "BG", label: "Buy/Sell on gap", style: "Intraday" },
      { id: "xs-mean-reversion", short: "XR", label: "Cross-sectional mean reversion", style: "Intraday", step: 2 },
    ],
  },
  {
    title: "Larry Connors",
    source: "How Markets Really Work (2nd ed., 2012)",
    models: [{ id: "short-term-reversion", short: "SR", label: "Short-term mean reversion", style: "Positional", liveMaxOpen: true }],
  },
];

const ALL = PAPER_GROUPS.flatMap((g) => g.models.map((m) => ({ ...m, group: g })));
export const DEFAULT_PAPER = ALL[0].id;
export const findPaper = (id) => ALL.find((m) => m.id === id);

export default function V2Paper({ model, onSelect }) {
  const m = findPaper(model) || findPaper(DEFAULT_PAPER);
  const { open, toggle, select } = useSideNav("yt-v2-paper-nav", onSelect);
  const [params, setParams] = useBacktestParams(`paper-${m.id}`, { universe: "fno", maxOpen: m.step > 1 ? 10 : 5 });
  const step = m.step || 1;
  const maxOpen = params.maxOpen && step > 1 ? Math.min(10, Math.ceil(params.maxOpen / step) * step) : params.maxOpen;
  const modelParams = { ...params, universe: "fno", maxOpen };
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SideNav groups={PAPER_GROUPS} base="/v2/paper" title="Paper trading" current={m.id} onSelect={select} open={open} onToggle={toggle} />
      <section className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Paper trading · {m.group.title} · {m.group.source}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{m.label}</h1>
          <StyleTag style={m.style} />
        </div>
        <div className="mt-4">
          <V2BacktestParams params={modelParams} onChange={setParams} universes={["fno"]} step={step} hideMaxOpen={!!m.liveMaxOpen} />
        </div>
        {m.id === "buy-on-gap" && <V2PaperGap params={modelParams} />}
        {m.id === "xs-mean-reversion" && <V2PaperXsmr params={modelParams} />}
        {m.id === "short-term-reversion" && <V2PaperConnors params={modelParams} />}
      </section>
    </div>
  );
}
