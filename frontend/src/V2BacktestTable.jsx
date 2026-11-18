import { useEffect, useState } from "react";
import { tone } from "./V2BacktestView";
import { SLIPPAGE_DEFAULT } from "./V2BuyOnGap";
import { savedParams } from "./V2BacktestParams";
import { useSettings } from "./settings";
import { STATUS, statusOf, useModelStatuses } from "./modelStatus";
import { InstrumentTag } from "./V2SideNav";

// The "All backtests" table: every model run with its own page's saved settings (the same request the page
// makes), so a row always shows what the model's page shows.

const pct = (v, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const UNIVERSE = { fno: "F&O", fnopit: "F&O (survivorship-free)", stocks: "Nifty 50", indices: "Indices", cash500: "Top 500" };
const go = (href) => (e) => {
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

// The model page's own parameters (V2Backtesting's Model): universe, max open (in 2s for long-short), survivorship
function pageParams(m, values) {
  const step = m.step || 1;
  const p = savedParams(values, m.id, { universe: m.universes[0], maxOpen: m.defaultOpen || (step > 1 ? 6 : 5) });
  const universe = m.universes.includes(p.universe) ? p.universe : m.universes[0];
  const savedOpen = p.maxOpen || m.defaultOpen || (step > 1 ? 6 : 5);
  const maxOpen = step > 1 ? Math.min(10, Math.ceil(savedOpen / step) * step) : savedOpen;
  const pit = !!m.pit && universe === "fno" && p.survivor === "pit";
  return { ...p, universe: pit ? "fnopit" : universe, maxOpen, base: universe };
}

// Each page's request, from the same settings with the same fallbacks the page applies
export function backtestRequest(m, values) {
  const v = (k, d) => (values[k] === undefined ? d : values[k]);
  const p = pageParams(m, values);
  const k = (key) => Math.max(1, Math.min(v(key, 3), Math.min(5, Math.floor(p.maxOpen / 2)) || 1));
  const u = UNIVERSE[p.universe] || p.universe;
  switch (m.id) {
    case "kbdt": {
      const hold = v("bt.kbdt.hold", "5d"), sm = v("bt.kbdt.stopMode", "model"), sp = v("bt.kbdt.stopPct", 1);
      return { p, url: `/api/v2/backtest/kbdt?dataset=${p.universe}&hold=${hold}&stop_mode=${sm}&stop_pct=${sp}&slippage=${v("bt.kbdt.slippage", SLIPPAGE_DEFAULT.kbdt)}&max_open=${p.maxOpen}`,
               settings: `${u} · ${hold} hold · ${sm === "model" ? "model stop" : `${sp}% stop`} · max ${p.maxOpen}` };
    }
    case "buy-on-gap": {
      const side = v("bt.gap.side", "long"), dis = v("bt.gap.disaster", "on");
      return { p, url: `/api/v2/backtest/gap?dataset=${p.universe}&side=${side}&stop=none&slippage=${v("bt.gap.slippage", SLIPPAGE_DEFAULT.gap)}&max_open=${p.maxOpen}&disaster=${dis}`,
               settings: `${u} · ${side === "long" ? "long" : "long & short"} · max ${p.maxOpen} · disaster stop ${dis}` };
    }
    case "gap-momentum": {
      const side = v("bt.gapmom.side", "both"), stop = v("bt.gapmom.stop", "none");
      return { p, url: `/api/v2/backtest/gapmom?dataset=${p.universe}&side=${side}&stop=${stop}&slippage=${v("bt.gapmom.slippage", SLIPPAGE_DEFAULT.gapmom)}&max_open=${p.maxOpen}`,
               settings: `${u} · ${side === "long" ? "long" : "both sides"} · ${stop === "none" ? "no stop" : "1σ stop"} · max ${p.maxOpen}` };
    }
    case "xs-mean-reversion": {
      const version = v("bt.xsmr.version", "intraday"), dis = v("bt.xsmr.disaster", "on"), n = k("bt.xsmr.pairs");
      return { p, url: `/api/v2/backtest/xsmr?dataset=${p.universe}&version=${version}&entry=0915&stop=none&slippage=${v("bt.xsmr.slippage", SLIPPAGE_DEFAULT.xsmr)}&max_open=${p.maxOpen}&pairs=${n}&disaster=${dis}`,
               settings: `${u} · ${version} · ${n} + ${n} · max ${p.maxOpen} · disaster stop ${dis}` };
    }
    case "pairs": {
      const method = v("bt.pairs.method", "bollinger"), fill = v("bt.pairs.fill", "close"), n = k("bt.pairs.pairs");
      return { p, url: `/api/v2/backtest/pairs?method=${method}&fill=${fill}&slippage=${v("bt.pairs.slippage", SLIPPAGE_DEFAULT.pairs)}&max_open=${p.maxOpen}&pairs=${n}`,
               settings: `${u} · ${method} · ${n} pairs · max ${p.maxOpen}` };
    }
    case "xs-momentum": {
      const fill = v("bt.xsmom.fill", "close"), n = k("bt.xsmom.pairs");
      return { p, url: `/api/v2/backtest/xsmom?dataset=${p.universe}&fill=${fill}&slippage=${v("bt.xsmom.slippage", SLIPPAGE_DEFAULT.xsmom)}&max_open=${p.maxOpen}&pairs=${n}`,
               settings: `${u} · ${n} + ${n} · max ${p.maxOpen}` };
    }
    case "quant-momentum": {
      const version = v("bt.qmom.version", "book"), hedge = v("bt.qmom.hedge", "none");
      return { p, url: `/api/v2/backtest/qmom?dataset=${p.universe}&version=${version}&hedge=${hedge}&slippage=${v("bt.qmom.slippage", SLIPPAGE_DEFAULT.qmom)}&max_open=${p.maxOpen}`,
               settings: `${u} · ${version} · ${hedge === "none" ? "no hedge" : "Nifty hedge"} · max ${p.maxOpen}` };
    }
    case "short-term-reversion": {
      const s = v("bt.connors.setup", "rsi2"), setup = ["rsi2", "cumrsi2"].includes(s) ? s : "rsi2";
      const hold = v("bt.connors.hold", "5d") === "0d" ? "0d" : "5d";
      const timing = v("bt.connors.timing", "close") === "closeopen" ? "closeopen" : "close";
      const dis = v("bt.connors.disaster", "on");
      const inst = p.universe === "fno" ? v("bt.connors.instrument", "cash") : "cash";
      return { p, inst: inst === "futures" ? "futures" : "spot",
               url: `/api/v2/backtest/connors?dataset=${p.universe}&setup=${setup}&hold=${hold}&timing=${timing}&stop=${dis === "on" ? "10pc" : "none"}&take=all&slippage=${v("bt.connors.slippage", SLIPPAGE_DEFAULT.connors)}&max_open=${p.maxOpen}&side=long&instrument=${inst}`,
               settings: `${u} · ${setup === "cumrsi2" ? "cumulative RSI(2)" : "RSI(2)"} · ${hold === "0d" ? "exit on strength" : "5 days"} · exit ${timing === "closeopen" ? "next open" : "at close"} · max ${p.maxOpen}` };
    }
    case "oops": {
      const dis = v("bt.oops.disaster", "on");
      return { p, url: `/api/v2/backtest/oops?stop=none&trend=any&slippage=${v("bt.oops.slippage", SLIPPAGE_DEFAULT.oops)}&max_open=${p.maxOpen}&exit=nextopen&disaster=${dis}`,
               settings: `F&O · first ${p.maxOpen} a day · exit next open · disaster stop ${dis}` };
    }
    case "turn-of-month": {
      const index = v("bt.tom.index", "nifty"), win = v("bt.tom.window", "4"), inst = v("bt.tom.instrument", "futures");
      return { p, inst, url: `/api/v2/backtest/tom?index=${index}&window=${win}&slippage=${v("bt.tom.slippage", SLIPPAGE_DEFAULT.tom)}&instrument=${inst}`,
               settings: `${index === "nifty" ? "Nifty" : "Bank Nifty"} · last ${win === "4" ? "4 days" : "day"} to the 3rd` };
    }
    case "low-volatility": {
      const trail = v("bt.ltlv.trail", "20");
      return { p, url: `/api/v2/backtest/ltlv?max_open=${p.maxOpen}&trail=${trail}&slippage=${v("bt.ltlv.slippage", SLIPPAGE_DEFAULT.ltlv)}&instrument=cash&dataset=${p.universe}`,
               settings: `${u} · ${trail}% trailing stop · max ${p.maxOpen}` };
    }
    case "books-gold": {
      const gold = v("bt.mix.gold", "30") === "0" ? 0 : 30, setup = v("bt.mix.setup", "rsi2"), exit = v("bt.mix.exit", "5d");
      return { p, url: `/api/v2/backtest/mix?gold=${gold}&instrument=cash&dataset=${p.universe}&rsi_open=${p.rsiOpen ?? 3}&lv_open=${p.lvOpen ?? 10}&mr_setup=${setup}&mr_exit=${exit}`,
               settings: `${u} · ${gold}% gold · ${setup === "cumrsi2" ? "cumulative RSI(2)" : "RSI(2)"}` };
    }
    default:
      return null;
  }
}

export default function BacktestTable({ models }) {
  const statuses = useModelStatuses();
  const { values } = useSettings();
  const year = String(new Date().getFullYear());
  const rows = models.filter((m) => statusOf(statuses, m.id) !== "archived").map((m) => ({ m, req: backtestRequest(m, values) })).filter((r) => r.req);
  const key = rows.map((r) => r.req.url).join("|");
  const [results, setResults] = useState({});
  useEffect(() => {
    const controller = new AbortController();
    rows.forEach(({ m, req }) => {
      fetch(req.url, { signal: controller.signal })
        .then((r) => r.json())
        .then((p) => setResults((old) => ({ ...old, [m.id]: { url: req.url, p } })))
        .catch(() => {});
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm tabular-nums">
        <thead className="text-left text-xs" style={{ color: "var(--faint)" }}>
          <tr>
            {["Model", "Settings", "Instrument", "Net / yr", "Sharpe", "Risk of ruin", "Max drawdown", "Green years", `${year} so far`].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, req }) => {
            const got = results[m.id];
            const fresh = got && got.url === req.url ? got.p : null;
            const s = fresh?.summary;
            const y = fresh?.years?.find((r) => String(r.year) === year);
            const err = fresh && fresh.status !== "success" ? fresh.message || "failed" : null;
            const st = statusOf(statuses, m.id);
            return (
              <tr key={m.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="px-3 py-2">
                  <a href={`/v2/backtesting/${m.id}`} onClick={go(`/v2/backtesting/${m.id}`)} className="font-medium hover:underline">
                    {m.label}
                  </a>
                  {st !== "research" && (
                    <span className="ml-2 text-[0.625rem] font-semibold uppercase tracking-[0.08em]" style={{ color: STATUS[st].color }}>
                      {STATUS[st].label}
                    </span>
                  )}
                  <span className="ml-2 text-[0.625rem] font-medium uppercase tracking-[0.08em]" style={{ color: m.style === "Intraday" ? "var(--accent)" : "var(--muted)" }}>
                    {m.style}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>
                  {req.settings}
                </td>
                <td className="px-3 py-2">
                  <InstrumentTag id={m.id} universe={req.p.universe} instrument={req.inst} />
                </td>
                {err ? (
                  <td colSpan={6} className="px-3 py-2 text-xs" style={{ color: "var(--negative)" }}>
                    {err}
                  </td>
                ) : !s ? (
                  <td colSpan={6} className="px-3 py-2 text-xs" style={{ color: "var(--faint)" }}>
                    {fresh ? "no trades" : "Loading…"}
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-2 font-medium" style={{ color: tone(s.net_year_pct) }}>
                      {pct(s.net_year_pct)}
                    </td>
                    <td className="px-3 py-2">{s.sharpe ?? "—"}</td>
                    <td
                      className="px-3 py-2"
                      style={{ color: s.ruin_half_pct == null ? "var(--muted)" : s.ruin_half_pct === 0 ? "var(--positive)" : "var(--negative)" }}
                      title="Penfold: must be 0. The chance of falling below half the capital within 10 years (from the backtest's own months, resampled), at full size"
                    >
                      {s.ruin_half_pct == null ? "—" : s.ruin_half_pct === 0 ? "0% ✓" : `${s.ruin_half_pct}%`}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--negative)" }}>
                      {pct(s.max_dd_pct)}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--muted)" }}>
                      {s.green_years != null ? `${s.green_years}/${s.years}` : "—"}
                    </td>
                    <td className="px-3 py-2 font-medium" style={{ color: tone(y?.net_pct) }}>
                      {pct(y?.net_pct)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-3 pt-2 text-xs" style={{ color: "var(--faint)" }}>
        Each model with its own page's settings (change them on the model's page), net of costs and its slippage, % of capital a year, not compounded. Click a model for its backtest.
      </p>
    </div>
  );
}
