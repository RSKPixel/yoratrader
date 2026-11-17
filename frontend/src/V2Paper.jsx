import { StatusButtons } from "./modelStatus";
import { useCallback, useEffect, useState } from "react";
import V2BacktestParams, { useBacktestParams } from "./V2BacktestParams";
import V2PaperConnors from "./V2PaperConnors";
import { PaperOverview } from "./V2Dashboard";
import V2PaperGap from "./V2PaperGap";
import V2PaperXsmr from "./V2PaperXsmr";
import V2PaperOops from "./V2PaperOops";
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
    models: [
      { id: "short-term-reversion", short: "SR", label: "Short-term mean reversion", style: "Positional", live: "/api/connors/paper", book: "rsi2" },
      {
        id: "cumulative-rsi",
        short: "CR",
        label: "Cumulative RSI(2)",
        style: "Positional",
        live: "/api/connors/paper",
        liveQuery: "?book=cum",
        book: "cum",
      },
    ],
  },
  {
    title: "Larry Williams",
    source: "Long-Term Secrets to Short-Term Trading (Wiley, 2011)",
    models: [{ id: "oops", short: "OP", label: "Oops gap reversal", style: "Intraday", live: "/api/v2/paper/oops" }],
  },
];

// A paper trader's live settings (universe, max open) on the server: read, and saved on change.
function useLiveSettings(base, query = "") {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!base) return;
    fetch(`${base}/settings${query}`)
      .then((r) => r.json())
      .then((p) => (p.status === "success" ? setSettings(p) : setError(p.message || p.detail || "Could not load the settings")))
      .catch(() => setError("Could not reach the API"));
  }, [base, query, version]);
  const save = useCallback(
    async (what, payload) => {
      setSaving(true);
      setError("");
      try {
        const r = await fetch(`${base}/${what}${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) setError(body.detail || `Could not save (${r.status})`);
        else setVersion((v) => v + 1);
      } catch (e) {
        setError(String(e?.message || e));
      }
      setSaving(false);
    },
    [base, query],
  );
  return { settings, saving, error, version, save };
}

const ALL = PAPER_GROUPS.flatMap((g) => g.models.map((m) => ({ ...m, group: g })));
export const DEFAULT_PAPER = ALL[0].id;
export const findPaper = (id) => ALL.find((m) => m.id === id);

// The defaults each paper page's parameters start from (the dashboard reads the same saved values)
export const paperDefaults = (m) => ({ universe: "fno", maxOpen: m.step > 1 ? 10 : 5 });

// The landing page (no model picked): the same paper trading cards as the dashboard
function Landing({ onSelect }) {
  const { open, toggle, select } = useSideNav("yt-v2-paper-nav", onSelect);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SideNav groups={PAPER_GROUPS} base="/v2/paper" title="Paper trading" current={null} onSelect={select} open={open} onToggle={toggle} pinKey="paper" />
      <section className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Paper trading
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">All paper books</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Recorded by the production scheduler; nothing places orders. Open a book for its positions, trades and settings.
        </p>
        <div className="mt-4">
          <PaperOverview />
        </div>
      </section>
    </div>
  );
}

export default function V2Paper({ model, onSelect }) {
  const m = findPaper(model);
  if (!m) return <Landing onSelect={onSelect} />;
  return <Book m={m} onSelect={onSelect} />;
}

function Book({ m, onSelect }) {
  const { open, toggle, select } = useSideNav("yt-v2-paper-nav", onSelect);
  const [params, setParams] = useBacktestParams(`paper-${m.id}`, paperDefaults(m));
  const step = m.step || 1;
  const maxOpen = params.maxOpen && step > 1 ? Math.min(10, Math.ceil(params.maxOpen / step) * step) : params.maxOpen;
  const liveSettings = useLiveSettings(m.live, m.liveQuery || "");
  const ls = m.live && liveSettings.settings;
  const live = ls
    ? {
        universe: ls.universe,
        universes: ls.universes,
        maxOpen: ls.max_open,
        limit: ls.max_open_limit,
        saving: liveSettings.saving,
        onUniverse: (universe) => liveSettings.save("universe", { universe }),
        onMaxOpen: (n) => liveSettings.save("max_open", { max_open: n }),
      }
    : null;
  const modelParams = { ...params, universe: ls ? ls.universe : "fno", maxOpen: ls ? ls.max_open : maxOpen };
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SideNav groups={PAPER_GROUPS} base="/v2/paper" title="Paper trading" current={m.id} onSelect={select} open={open} onToggle={toggle} pinKey="paper" />
      <section className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Paper trading · {m.group.title} · {m.group.source}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{m.label}</h1>
          <StyleTag style={m.style} />
          <span className="ml-auto">
            <StatusButtons id={m.id} />
          </span>
        </div>
        <div className="mt-4">
          {(!m.live || ls) && <V2BacktestParams params={modelParams} onChange={setParams} universes={["fno"]} step={step} live={live} lots />}
          {liveSettings.error && (
            <p className="mt-2 text-sm" style={{ color: "var(--negative)" }}>
              {liveSettings.error}
            </p>
          )}
        </div>
        {m.id === "buy-on-gap" && <V2PaperGap params={modelParams} />}
        {m.id === "xs-mean-reversion" && <V2PaperXsmr params={modelParams} />}
        {m.id === "oops" && <V2PaperOops params={modelParams} stop={ls?.stop} onStop={(stop) => liveSettings.save("stop", { stop })} saving={liveSettings.saving} />}
        {m.book && (
          <V2PaperConnors
            key={m.book}
            book={m.book}
            params={modelParams}
            version={liveSettings.version}
            exit={ls?.exit}
            onExit={(exit) => liveSettings.save("exit", { exit })}
            saving={liveSettings.saving}
          />
        )}
      </section>
    </div>
  );
}
