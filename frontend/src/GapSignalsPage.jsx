import { useCallback, useEffect, useMemo, useState } from "react";
import ModelInfoModal, { GapBacktestInfo, InfoButton } from "./ModelInfoModal";
import { formatR, formatRs, rClass, Segmented, SLIPPAGE, Stat } from "./backtestShared";

const SIDES = [
  ["book", "Long only (book)"],
  ["both", "Long & short"],
];
const STOPS = [
  ["none", "No stop (book)"],
  ["1sd", "1σ stop"],
];
const UNITS = [
  ["r", "R"],
  ["rs", "₹ per lot"],
];

const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const px = (v) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));

function Card({ title, right, children }) {
  return (
    <section className="mb-4 rounded-md border border-[#2c313a] bg-[#181b20] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">{title}</p>
        {right && <div className="font-mono text-xs text-[#9b968c]">{right}</div>}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children, minWidth = 900 }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">{children}</tbody>
      </table>
    </div>
  );
}

// Result of one pick under the chosen stop: closed R, or live R from the last price.
function pickResult(p, stop) {
  const closed = p.status === "closed";
  const r = closed ? (stop === "1sd" ? p.r_stop : p.r) : p.r_live;
  const net = closed ? (stop === "1sd" ? p.net_r_stop : p.net_r) : null;
  const netRs = closed ? (stop === "1sd" ? p.net_r_stop_rs : p.net_r_rs) : null;
  const exit = closed ? (stop === "1sd" ? p.exit_stop : p.exit) : p.ltp;
  const reason = closed ? (stop === "1sd" ? p.exit_reason_stop : p.exit_reason) : p.ltp != null ? "live" : "open";
  // Live fill: last traded price a second or two after 09:15:00 (a market order at the open).
  const netLive = closed ? p.net_r_live : null;
  const netLiveRs = closed ? p.net_r_live_rs : null;
  return { closed, r, net, netRs, exit, reason, netLive, netLiveRs };
}

function SideBadge({ side }) {
  return <span className={`uppercase ${side === "long" ? "text-[#7dcca8]" : "text-[#f0b4b4]"}`}>{side}</span>;
}

function TodayPicks({ data, picks, sides, stop }) {
  const today = data.today;
  const all = picks.filter((p) => p.day === today);
  if (!data.today_recorded && all.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[#9b968c]">
        {data.market_open
          ? "Waiting for today's opening prices (recorded from 09:15 automatically in production; Record now does it by hand)."
          : "No picks recorded for today. Picks are taken from the 09:15 opening prices on trading days."}
      </p>
    );
  }
  if (all.length === 0) {
    return <p className="py-6 text-center text-sm text-[#9b968c]">No stock opened inside its zone today: no trades.</p>;
  }
  return (
    <Table head={["#", "Symbol", "Side", "Gap", "Gap σ", "Entry (open)", "Live fill", "1σ stop", "Exit / LTP", "", "R", "Net R", "Net R @ live fill", "Lot", "Net ₹"]}>
      {all.map((p) => {
        const taken = sides === "book" ? p.in_book : p.in_both;
        const res = pickResult(p, stop);
        return (
          <tr key={p.symbol} className={taken ? "" : "opacity-40"} title={taken ? undefined : "Not taken under this side setting"}>
            <td className="px-3 py-2 text-[#9b968c]">{p.rank}</td>
            <td className="px-3 py-2 text-[#e7e4dc]">{p.symbol}</td>
            <td className="px-3 py-2">
              <SideBadge side={p.side} />
            </td>
            <td className="px-3 py-2">{pct(p.gap_pct)}</td>
            <td className="px-3 py-2 text-[#9b968c]">{p.gap_sigmas.toFixed(2)}σ</td>
            <td className="px-3 py-2">{px(p.entry)}</td>
            <td className="px-3 py-2 text-[#9b968c]" title={p.live_at ? `Last traded price at ${p.live_at}` : "No snapshot in the first seconds (recorded late)"}>
              {p.entry_live ? px(p.entry_live) : "—"}
            </td>
            <td className="px-3 py-2 text-[#f0b4b4]">
              {px(p.stop)}
              {!res.closed && p.stop_hit_now && stop === "1sd" && <span className="ml-1">hit</span>}
            </td>
            <td className="px-3 py-2">{px(res.exit)}</td>
            <td className="px-3 py-2 text-[#9b968c]">{res.reason}</td>
            <td className={`px-3 py-2 ${rClass(res.r)}`}>{formatR(res.r)}</td>
            <td className={`px-3 py-2 ${rClass(res.net)}`}>{res.closed ? formatR(res.net) : "—"}</td>
            <td className={`px-3 py-2 ${rClass(res.netLive)}`}>{res.netLive == null ? "—" : formatR(res.netLive)}</td>
            <td className="px-3 py-2 text-[#9b968c]">{p.lot_size ?? "—"}</td>
            <td className={`px-3 py-2 ${rClass(res.netRs)}`}>{res.closed ? formatRs(res.netRs) : "—"}</td>
          </tr>
        );
      })}
    </Table>
  );
}

function Watchlist({ rows, sides }) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows
      .flatMap((z) => [
        z.buy_below ? { ...z, side: "long", trigger: z.buy_below, need: z.buy_gap_pct } : null,
        z.sell_above && sides === "both" ? { ...z, side: "short", trigger: z.sell_above, need: z.sell_gap_pct } : null,
      ])
      .filter(Boolean)
      .filter((z) => !q || z.symbol.includes(q))
      .sort((a, b) => Math.abs(a.need) - Math.abs(b.need));
  }, [rows, sides, query]);
  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter symbol"
          className="w-40 rounded border border-[#2c313a] bg-[#12151a] px-2 py-1 font-mono text-xs text-[#e7e4dc] placeholder:text-[#6f6a62]"
        />
        <span className="font-mono text-xs text-[#6f6a62]">{list.length} setups · smallest gap needed first</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        <Table head={["Symbol", "Side", "Opens between", "", "Gap needed", "Prev close", "Prev low / high", "20-day avg", "σ (90d)"]} minWidth={820}>
          {list.map((z) => (
            <tr key={`${z.symbol}-${z.side}`} className="hover:bg-white/[0.03]">
              <td className="px-3 py-2 text-[#e7e4dc]">{z.symbol}</td>
              <td className="px-3 py-2">
                <SideBadge side={z.side} />
              </td>
              <td className="px-3 py-2">
                {z.side === "long" ? `${px(z.ma20)} – ${px(z.trigger)}` : `${px(z.trigger)} – ${px(z.ma20)}`}
              </td>
              <td className="px-3 py-2 text-[#6f6a62]">{z.side === "long" ? "buy at open" : "sell at open"}</td>
              <td className="px-3 py-2">{pct(z.need)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{px(z.prev_close)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{px(z.side === "long" ? z.prev_low : z.prev_high)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{px(z.ma20)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{z.sigma_pct}%</td>
            </tr>
          ))}
        </Table>
      </div>
    </>
  );
}

function Log({ picks, sides, stop, unit }) {
  const closed = picks.filter((p) => p.status === "closed" && (sides === "book" ? p.in_book : p.in_both));
  const stats = useMemo(() => {
    const res = closed.map((p) => pickResult(p, stop));
    const sum = (k) => res.reduce((t, x) => t + (x[k] || 0), 0);
    const wins = res.filter((x) => x.net > 0).length;
    const live = res.filter((x) => x.netLive != null);
    // Drawdown on cumulative net R, oldest first.
    let eq = 0;
    let peak = 0;
    let dd = 0;
    [...res].reverse().forEach((x) => {
      eq += x.net || 0;
      peak = Math.max(peak, eq);
      dd = Math.min(dd, eq - peak);
    });
    return {
      n: res.length,
      win: res.length ? Math.round((1000 * wins) / res.length) / 10 : null,
      net: sum("net"),
      netRs: sum("netRs"),
      avg: res.length ? sum("net") / res.length : null,
      avgLive: live.length ? live.reduce((t, x) => t + x.netLive, 0) / live.length : null,
      netLiveRs: live.reduce((t, x) => t + (x.netLiveRs || 0), 0),
      liveN: live.length,
      dd,
      days: new Set(closed.map((p) => p.day)).size,
    };
  }, [closed, stop]);

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Trades" value={stats.n} title={`${stats.days} trading days with picks`} />
        <Stat label="Win rate" value={stats.win == null ? "—" : `${stats.win}%`} title="After costs" />
        <Stat label="Net / trade" value={formatR(stats.avg)} className={rClass(stats.avg)} title="At the 09:15 auction price. Backtest, book version: about +0.42R" />
        <Stat
          label="Net @ live fill"
          value={unit === "rs" ? formatRs(stats.netLiveRs) : formatR(stats.avgLive)}
          className={rClass(stats.avgLive)}
          title={`Per trade at the live fill: the last traded price a second or two after 09:15:00, as a market order at the open would get. ${stats.liveN} trades have a snapshot. The fill used everywhere else is the open itself.`}
        />
        {unit === "rs" ? (
          <Stat label="Net ₹" value={formatRs(stats.netRs)} className={rClass(stats.netRs)} title="One lot per trade" />
        ) : (
          <Stat label="Net R" value={formatR(stats.net, 1)} className={rClass(stats.net)} />
        )}
        <Stat label="Max drawdown" value={formatR(stats.dd, 1)} className="text-[#f0b4b4]" />
        <Stat label="Started" value={closed.length ? closed[closed.length - 1].day : "—"} />
      </div>
      {closed.length === 0 ? (
        <p className="py-6 text-center text-sm text-[#9b968c]">No closed paper trades yet. They start with the first recorded session.</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <Table head={["Date", "Symbol", "Side", "Gap", "Entry", "Exit", "", "R", "Net R", "Net R @ live fill", "Net ₹"]} minWidth={860}>
            {closed.map((p) => {
              const res = pickResult(p, stop);
              return (
                <tr key={`${p.day}-${p.symbol}`} className="hover:bg-white/[0.03]">
                  <td className="px-3 py-2 text-[#9b968c]">{p.day}</td>
                  <td className="px-3 py-2 text-[#e7e4dc]">{p.symbol}</td>
                  <td className="px-3 py-2">
                    <SideBadge side={p.side} />
                  </td>
                  <td className="px-3 py-2">{pct(p.gap_pct)}</td>
                  <td className="px-3 py-2">{px(p.entry)}</td>
                  <td className="px-3 py-2">{px(res.exit)}</td>
                  <td className="px-3 py-2 text-[#9b968c]">{res.reason}</td>
                  <td className={`px-3 py-2 ${rClass(res.r)}`}>{formatR(res.r)}</td>
                  <td className={`px-3 py-2 ${rClass(res.net)}`}>{formatR(res.net)}</td>
                  <td className={`px-3 py-2 ${rClass(res.netLive)}`} title={p.entry_live ? `Live fill ${px(p.entry_live)} at ${p.live_at}` : undefined}>
                    {res.netLive == null ? "—" : formatR(res.netLive)}
                  </td>
                  <td className={`px-3 py-2 ${rClass(res.netRs)}`}>{formatRs(res.netRs)}</td>
                </tr>
              );
            })}
          </Table>
        </div>
      )}
    </>
  );
}

export default function GapSignalsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sides, setSides] = useState("book");
  const [stop, setStop] = useState("none");
  const [unit, setUnit] = useState("r");
  const [slippage, setSlippage] = useState(0.02);
  const [busy, setBusy] = useState("");
  const [refreshJob, setRefreshJob] = useState(null);
  const [showInfo, setShowInfo] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/gap/paper?slippage=${slippage}`)
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") {
          setError(payload.message || "Could not load");
          return;
        }
        setError("");
        setData(payload);
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setLoading(false));
  }, [slippage]);

  useEffect(() => {
    load();
  }, [load]);

  // While the market is open, refresh live prices every 30 seconds.
  useEffect(() => {
    if (!data?.market_open) return undefined;
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, [data?.market_open, load]);

  const record = () => {
    setBusy("record");
    fetch("/api/gap/record", { method: "POST" })
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") setError(payload.message || "Could not record");
        else if (!payload.recorded && !payload.closed) setError(`Not recorded: ${payload.reason}`);
        load();
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setBusy(""));
  };

  const refreshing = refreshJob?.status === "running";
  const refreshDaily = () => {
    fetch("/api/gap/refresh", { method: "POST" })
      .then((r) => r.json())
      .then(() => setRefreshJob({ status: "running", done: 0, total: 0 }))
      .catch(() => setError("Could not start the refresh"));
  };
  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = window.setInterval(() => {
      fetch("/api/gap/refresh")
        .then((r) => r.json())
        .then((payload) => {
          setRefreshJob(payload.job);
          if (payload.job?.status !== "running") {
            if (payload.job?.status === "error") setError(payload.job.message);
            load();
          }
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshing, load]);

  const picks = data?.picks || [];
  const dayLabel = (iso) =>
    iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Buy on gap · paper trading</h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How buy on gap works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            The backtest's rules on today's F&amp;O stocks, live. Picks are recorded from the 09:15 opening prices and
            closed at 15:15, so the log is an honest forward test. No orders are placed.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={refreshDaily}
              disabled={refreshing}
              title="Top up the F&O stocks' daily candles (done automatically at 15:45 in production)"
              className="rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5 disabled:opacity-40"
            >
              {refreshing ? `Daily data ${refreshJob.done}/${refreshJob.total || "…"}` : "Refresh daily data"}
            </button>
            <button
              type="button"
              onClick={record}
              disabled={busy === "record"}
              title="Record today's picks from the opening prices, and close any picks past 15:15 (automatic in production)"
              className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
            >
              {busy === "record" ? "Recording…" : "Record now"}
            </button>
          </div>
          {data && (
            <p className="font-mono text-xs text-[#6f6a62]">
              daily candles to {data.daily_as_of} · {data.market_open ? "market open" : "market closed"}
              {data.ltp_at ? ` · prices ${data.ltp_at}` : ""}
              {loading ? " · loading…" : ""}
            </p>
          )}
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2" title="Long only is the book's version: the day's 10 biggest gap-downs. Long & short takes the 10 biggest gaps either way.">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Side</span>
          <Segmented options={SIDES} value={sides} onChange={setSides} />
        </div>
        <div className="flex items-center gap-2" title="No stop is the book's rule. 1σ: stop one standard deviation from entry.">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Stop</span>
          <Segmented options={STOPS} value={stop} onChange={setStop} />
        </div>
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
        <Segmented options={UNITS} value={unit} onChange={setUnit} />
      </div>

      {error && <p className="mb-4 text-sm text-[#f0b4b4]">{error}</p>}

      {data && (
        <>
          <Card
            title={`Today · ${dayLabel(data.today)}`}
            right={
              data.last_recorded?.day === data.today
                ? `recorded ${data.last_recorded.at} · ${data.last_recorded.quoted} stocks with a zone quoted · ${data.last_recorded.candidates} opened inside`
                : "not recorded"
            }
          >
            <TodayPicks data={data} picks={picks} sides={sides} stop={stop} />
          </Card>

          <Card
            title={`Watchlist for ${dayLabel(data.session)}`}
            right={`from daily candles to ${data.watchlist[0]?.as_of ?? data.daily_as_of}`}
          >
            <Watchlist rows={data.watchlist} sides={sides} />
          </Card>

          <Card title={`Paper log · ${sides === "book" ? "long only, top 10" : "long & short, top 10"} · ${stop === "none" ? "no stop" : "1σ stop"}`}>
            <Log picks={picks} sides={sides} stop={stop} unit={unit} />
          </Card>
        </>
      )}

      {showInfo && (
        <ModelInfoModal title="Buy on gap · how it works" onClose={() => setShowInfo(false)}>
          <GapBacktestInfo />
        </ModelInfoModal>
      )}
    </div>
  );
}
