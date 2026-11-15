import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./V2BacktestView";
import { inputStyle, Segmented } from "./V2Controls";
import V2CandleChart from "./V2CandleChart";

// v2 Data: every symbol stored, how many daily / 15-minute / 1-minute candles it has, over what span,
// and how many trading days are missing in that span; a chart for each.

const SOURCES = [
  ["backtest", "Backtest data"],
  ["live", "Live futures"],
];
const BT_UNIVERSES = [
  ["all", "All"],
  ["fno", "F&O stocks"],
  ["stocks", "Nifty 50"],
  ["indices", "Indices"],
];
const LIVE_UNIVERSES = [
  ["all", "All"],
  ["nse", "NSE"],
  ["mcx", "MCX"],
];
const UNIVERSE_LABEL = { fno: "F&O", stocks: "Nifty 50", indices: "Index", nse: "NSE", mcx: "MCX" };

const n = (v) => (v == null ? "—" : v.toLocaleString("en-IN"));
const compact = (v) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)} L` : n(v));

// Live futures: fetch the latest candles from Kite (the classic app's EOD / iData downloads) for the
// symbols shown, poll the job, and count again when it's done.
function Downloads({ symbols, onDone }) {
  const [job, setJob] = useState(null); // { kind, id, state }
  const timer = useRef(null);
  const poll = (id, kind) => {
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      fetch(`/api/eod/${id}`)
        .then((r) => r.json())
        .then((state) => {
          setJob({ kind, id, state });
          if (state.status !== "running") {
            clearInterval(timer.current);
            if (state.status === "completed") onDone();
          }
        })
        .catch(() => {});
    }, 1000);
  };
  useEffect(() => {
    // The download runs on the server: coming back to the page picks its progress up again.
    fetch("/api/v2/data/job")
      .then((r) => r.json())
      .then((p) => {
        const j = p.job;
        if (!j?.state) return;
        const recent = Date.now() / 1000 - (j.started_at || 0) < 6 * 3600;
        if (j.state.status === "running") {
          setJob({ kind: j.kind, id: j.id, state: j.state });
          poll(j.id, j.kind);
        } else if (recent) {
          setJob({ kind: j.kind, id: j.id, state: j.state });
        }
      })
      .catch(() => {});
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const start = (kind) => {
    const endpoint = kind === "idata" ? "/api/idata" : "/api/eod";
    setJob({ kind, state: { status: "running", done: 0, total: symbols.length } });
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols, full: kind === "full" }),
    })
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success" || !p.job_id) {
          setJob({ kind, state: { status: "error", message: p.message || p.detail || "Could not start the download" } });
          return;
        }
        poll(p.job_id, kind);
      })
      .catch(() => setJob({ kind, state: { status: "error", message: "Could not reach the API" } }));
  };
  const running = job?.state?.status === "running";
  const st = job?.state;
  const label = job?.kind === "eod" ? "EOD" : job?.kind === "full" ? "Full history" : "15 min";
  const btn = "rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={btn} style={{ borderColor: "var(--border)" }} disabled={running || !symbols.length} onClick={() => start("eod")}
        title="The last 30 days of continuous daily candles from Kite, for the symbols shown">
        Download EOD
      </button>
      <button type="button" className={btn} style={{ borderColor: "var(--border)" }} disabled={running || !symbols.length} onClick={() => start("full")}
        title="Every continuous daily candle Kite has (from about Oct 2010), for the symbols shown; fills any gaps. ~3 requests a symbol, about 5 minutes for all.">
        Download full history
      </button>
      <button type="button" className={btn} style={{ borderColor: "var(--border)" }} disabled={running || !symbols.length} onClick={() => start("idata")}
        title="15-minute candles from the previous expiry to today (Kite has intraday only for the current contract), for the symbols shown">
        Download 15 min
      </button>
      <span className="text-xs tabular-nums" style={{ color: st?.status === "error" ? "var(--negative)" : "var(--muted)" }}>
        {!st
          ? `${symbols.length} symbols shown`
          : st.status === "running"
          ? `${label}: ${st.done ?? 0}/${st.total ?? symbols.length}${st.symbol ? ` · ${st.symbol}` : ""} · ${(st.candles ?? 0).toLocaleString("en-IN")} candles saved`
          : st.status === "completed"
          ? `${label} done: ${(st.candles ?? 0).toLocaleString("en-IN")} candles saved${st.errors?.length ? ` · ${st.errors.length} failed (${st.errors.slice(0, 3).map((e) => e.split(":")[0]).join(", ")}${st.errors.length > 3 ? ", …" : ""})` : ""}`
          : `${label} failed: ${st.message || "unknown error"} (is Kite logged in?)`}
      </span>
    </div>
  );
}

function Gaps({ block }) {
  const gaps = block?.gaps || [];
  if (!gaps.length) return <span style={{ color: "var(--faint)" }}>—</span>;
  const longest = gaps.reduce((a, g) => (g.days > a.days ? g : a), gaps[0]);
  const title = gaps.map((g) => `${g.from} → ${g.to} (${g.days.toLocaleString("en-IN")} trading days)`).join("\n");
  return (
    <span title={`No candles (out of F&O, or not in Kite's history):\n${title}`} style={{ color: "var(--muted)" }}>
      {longest.from.slice(0, 7)} → {longest.to.slice(0, 7)}
      {gaps.length > 1 ? <span style={{ color: "var(--faint)" }}> +{gaps.length - 1}</span> : null}
    </span>
  );
}

function Missing({ v }) {
  if (!v) return <span style={{ color: "var(--faint)" }}>0</span>;
  return (
    <span className="rounded px-1.5 py-0.5 font-medium" style={{ background: "color-mix(in srgb, var(--warning) 16%, transparent)", color: "var(--warning)" }}>
      {n(v)}
    </span>
  );
}

const COLUMNS = [
  { key: "chart", h: "" },
  { key: "symbol", h: "Symbol", sort: (r) => r.symbol },
  { key: "universes", h: "In", sort: (r) => r.universes.join(",") },
  { key: "lot", h: "Lot", sort: (r) => r.lot_size ?? -1 },
  { key: "close", h: "Last close", sort: (r) => r.last_close ?? -1 },
  { key: "d_bars", h: "Daily", sort: (r) => r.daily.bars, group: "Daily" },
  { key: "d_span", h: "From → to", sort: (r) => r.daily.first || "", group: "Daily" },
  { key: "d_gaps", h: "Gaps", sort: (r) => r.daily.gap_days || 0, group: "Daily" },
  { key: "d_miss", h: "Missing", sort: (r) => r.daily.missing, group: "Daily" },
  { key: "m_bars", h: "15 min", sort: (r) => r.m15.bars, group: "15 min" },
  { key: "m_days", h: "Days · /day", sort: (r) => r.m15.days, group: "15 min" },
  { key: "m_span", h: "From → to", sort: (r) => r.m15.first || "", group: "15 min" },
  { key: "m_gaps", h: "Gaps", sort: (r) => r.m15.gap_days || 0, group: "15 min" },
  { key: "m_miss", h: "Missing", sort: (r) => r.m15.missing, group: "15 min" },
  { key: "o_days", h: "1 min days", sort: (r) => r.m1?.days ?? -1, backtestOnly: true },
];

export default function V2Data() {
  const [source, setSource] = useState("backtest");
  const [universe, setUniverse] = useState("all");
  const [query, setQuery] = useState("");
  const [gapsOnly, setGapsOnly] = useState(false);
  const [longGapsOnly, setLongGapsOnly] = useState(false);
  const [sort, setSort] = useState({ key: "symbol", dir: 1 });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [chart, setChart] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    if (!reload) {
      setData(null);
      setUniverse("all");
    }
    fetch(`/api/v2/data/symbols?source=${source}${reload ? "&refresh=true" : ""}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success") setError(p.message || p.detail || "Could not load the data summary");
        else {
          setError("");
          setData(p);
        }
      })
      .catch((e) => e.name !== "AbortError" && setError("Could not reach the API"));
    return () => controller.abort();
  }, [source, reload]);
  useEffect(() => setReload(0), [source]);

  const columns = COLUMNS.filter((c) => !(c.backtestOnly && source !== "backtest"));
  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toUpperCase();
    const col = COLUMNS.find((c) => c.key === sort.key);
    return data.symbols
      .filter((r) => universe === "all" || r.universes.includes(universe))
      .filter((r) => !q || r.symbol.toUpperCase().includes(q) || (r.name || "").toUpperCase().includes(q))
      .filter((r) => !gapsOnly || r.daily.missing > 0 || r.m15.missing > 0)
      .filter((r) => !longGapsOnly || r.daily.gaps?.length || r.m15.gaps?.length)
      .sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
      });
  }, [data, universe, query, gapsOnly, longGapsOnly, sort]);
  const closeChart = useCallback(() => setChart(null), []);
  const t = data?.totals;
  const span = (o) => (o?.first ? `${o.first} → ${o.last}` : "—");

  const cell = (c, r) => {
    switch (c.key) {
      case "symbol":
        return <span className="font-medium" title={r.name && r.name !== r.symbol ? r.name : undefined}>{r.symbol}</span>;
      case "universes":
        return (
          <span className="flex gap-1">
            {r.universes.map((u) => (
              <span key={u} className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-[0.06em]" style={{ background: "var(--surface-2)", color: "var(--muted)" }}>
                {UNIVERSE_LABEL[u] || u}
              </span>
            ))}
          </span>
        );
      case "lot":
        return n(r.lot_size);
      case "close":
        return r.last_close == null ? "—" : <span title={r.last_day}>{n(r.last_close)}</span>;
      case "d_bars":
        return n(r.daily.bars);
      case "d_span":
        return <span style={{ color: "var(--muted)" }}>{span(r.daily)}</span>;
      case "d_gaps":
        return <Gaps block={r.daily} />;
      case "d_miss":
        return <Missing v={r.daily.missing} />;
      case "m_bars":
        return n(r.m15.bars);
      case "m_days":
        return r.m15.days ? (
          <span>
            {n(r.m15.days)} <span style={{ color: "var(--faint)" }}>· {r.m15.per_day}</span>
          </span>
        ) : (
          "—"
        );
      case "m_span":
        return <span style={{ color: "var(--muted)" }}>{span(r.m15)}</span>;
      case "m_gaps":
        return <Gaps block={r.m15} />;
      case "m_miss":
        return <Missing v={r.m15.missing} />;
      case "o_days":
        return n(r.m1?.days);
      case "chart":
        return (
          <button type="button" onClick={() => setChart(r)} className="rounded-md border px-2.5 py-1 text-xs hover:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)" }}>
            Chart
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Data</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Every symbol stored, how many candles it has and over what span. Gaps = 20+ trading days with no candle (out of F&O, or not in
            Kite's history; hover for the dates). Missing = the short holes left: the real data problems.
          </p>
        </div>
        <Segmented label="Source" options={SOURCES} value={source} onChange={setSource} />
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!data && !error && <p className="text-sm" style={{ color: "var(--faint)" }}>Loading… (the first load counts ~14 million candles)</p>}

      {t && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Card label="Symbols" value={n(t.symbols)} />
            <Card label="Daily candles" value={compact(t.daily_bars)} hint={n(t.daily_bars)} />
            <Card label="15-min candles" value={compact(t.m15_bars)} hint={n(t.m15_bars)} />
            {t.m1_days != null && <Card label="1-min days" value={compact(t.m1_days)} hint={`${n(t.m1_days)} symbol-days of 1-minute candles`} />}
            <Card label="Span" value={t.first ? `${t.first.slice(0, 4)} → ${t.last.slice(0, 4)}` : "—"} hint={`${t.first} → ${t.last}`} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol"
              aria-label="Search symbol"
              className="w-56 rounded-md border px-3 py-1.5 text-sm outline-none"
              style={inputStyle}
            />
            <Segmented label="Universe" options={source === "backtest" ? BT_UNIVERSES : LIVE_UNIVERSES} value={universe} onChange={setUniverse} />
            <label className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
              <input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} />
              Only with missing days
            </label>
            <label className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
              <input type="checkbox" checked={longGapsOnly} onChange={(e) => setLongGapsOnly(e.target.checked)} />
              Only with gaps
            </label>
            <span className="ml-auto text-xs" style={{ color: "var(--faint)" }}>
              {rows.length} of {data.symbols.length} · click a header to sort
            </span>
          </div>
          {source === "live" && <Downloads symbols={rows.map((r) => r.symbol)} onDone={() => setReload((n) => n + 1)} />}

          <div className="overflow-auto rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <table className="w-full min-w-[1150px] text-xs tabular-nums">
              <thead className="sticky top-0 text-left" style={{ background: "var(--surface)", color: "var(--faint)" }}>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium">
                      {c.sort ? (
                        <button
                          type="button"
                          onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : c.key === "symbol" ? 1 : -1 }))}
                          className="hover:underline"
                          style={{ color: sort.key === c.key ? "var(--text)" : undefined }}
                        >
                          {c.group && c.h !== c.group ? <span style={{ color: "var(--faint)" }}>{c.group} · </span> : null}
                          {c.h}
                          {sort.key === c.key ? (sort.dir > 0 ? " ↑" : " ↓") : ""}
                        </button>
                      ) : (
                        c.h
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.exchange || ""}${r.symbol}`} className="border-t whitespace-nowrap" style={{ borderColor: "var(--border)" }}>
                    {columns.map((c) => (
                      <td key={c.key} className="px-3 py-1.5">
                        {cell(c, r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {chart && <V2CandleChart row={chart} source={source} onClose={closeChart} />}
    </div>
  );
}
