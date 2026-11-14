import { useCallback, useEffect, useMemo, useState } from "react";
import ModelInfoModal, { InfoButton, XsmrInfo } from "./ModelInfoModal";
import { formatRs, Segmented, SLIPPAGE, Stat } from "./backtestShared";

// Cross-sectional mean reversion, paper trading: the backtest's 5 long + 5 short book at the
// 09:15 open, recorded by the production scheduler and closed at 15:15.

const UNITS = [
  ["pct", "%"],
  ["rs", "₹"],
];
const CAPITALS = [
  [500000, "₹5L"],
  [1000000, "₹10L"],
  [2500000, "₹25L"],
  [5000000, "₹50L"],
];

const fmtPct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)}%`);
const px = (v) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const cls = (v) => (v == null ? "text-[#6f6a62]" : v > 0 ? "text-[#8fbf9f]" : v < 0 ? "text-[#f0b4b4]" : "text-[#c8c3b8]");

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

function Positions({ rows, money, perStock, stop }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-xs">
        <thead className="text-left uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Side", "Stock", "Prev close", "Open (entry)", "Gap", "vs average", "Live fill", ...(stop ? ["1σ stop"] : []), "Now / exit", "Return", "@ live fill", "Lot", "Lots for " + formatRs(perStock)].map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#23272e] whitespace-nowrap font-mono">
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td className={`px-2 py-1.5 ${r.side === "long" ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>
                {r.side} #{r.rank}
              </td>
              <td className="px-2 py-1.5 text-[#e7e4dc]">{r.symbol}</td>
              <td className="px-2 py-1.5 text-[#9b968c]">{px(r.prev_close)}</td>
              <td className="px-2 py-1.5 text-[#e7e4dc]">{px(r.entry)}</td>
              <td className={`px-2 py-1.5 ${cls(r.signal_pct)}`}>{fmtPct(r.signal_pct)}</td>
              <td className={`px-2 py-1.5 ${cls(r.dev_pct)}`}>{fmtPct(r.dev_pct)}</td>
              <td className="px-2 py-1.5 text-[#c8c3b8]" title={r.live_at ? `last price at ${r.live_at}` : "no snapshot by 09:15:30"}>
                {px(r.entry_live)}
              </td>
              {stop && <td className="px-2 py-1.5 text-[#f0b4b4]">{px(r.stop)}</td>}
              <td className={`px-2 py-1.5 ${stop && r.exit_reason?.startsWith("stop") ? "text-[#f0b4b4]" : "text-[#c8c3b8]"}`}>
                {r.status === "closed" ? px(r.exit) : px(r.ltp)}
                {stop && r.exit_reason?.startsWith("stop") && <span className="ml-1">· {r.exit_reason}</span>}
                {r.status === "open" && r.ltp != null && <span className="ml-1 text-[#6f6a62]">live</span>}
              </td>
              <td className={`px-2 py-1.5 ${cls(r.ret_pct)}`}>{money(r.ret_pct)}</td>
              <td className={`px-2 py-1.5 ${cls(r.ret_live_pct)}`}>{money(r.ret_live_pct)}</td>
              <td className="px-2 py-1.5 text-[#9b968c]" title={r.lot_value ? `one lot ≈ ${formatRs(r.lot_value)}` : ""}>
                {r.lot_size ?? "—"}
              </td>
              <td className="px-2 py-1.5 text-[#9b968c]">{r.lot_value ? (perStock / r.lot_value).toFixed(1) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Log({ log, positions, fmtBook, money, perStock, stop }) {
  const [open, setOpen] = useState(null);
  if (!log.length) return <p className="py-6 text-center text-sm text-[#9b968c]">No days recorded yet. The first one is recorded at 09:15:01 on the next trading day.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {["Day", "Stocks quoted", "Average gap", "Gross", "Net @ open", "Net @ live fill", "Status"].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
          {log.map((d) => [
            <tr
              key={d.day}
              onClick={() => setOpen(open === d.day ? null : d.day)}
              className={`cursor-pointer ${open === d.day ? "bg-[#e2c08a]/10" : "hover:bg-white/[0.03]"}`}
            >
              <td className="px-3 py-2 text-[#e7e4dc]">
                <span className="mr-1 text-[#6f6a62]">{open === d.day ? "▾" : "▸"}</span>
                {d.day}
              </td>
              <td className="px-3 py-2 text-[#9b968c]">{d.quoted}</td>
              <td className={`px-3 py-2 ${cls(d.mean_signal_pct)}`}>{fmtPct(d.mean_signal_pct)}</td>
              <td className={`px-3 py-2 ${cls(d.gross_pct)}`}>{fmtBook(d.gross_pct)}</td>
              <td className={`px-3 py-2 ${cls(d.net_pct)}`}>{fmtBook(d.net_pct)}</td>
              <td className={`px-3 py-2 ${cls(d.net_live_pct)}`}>{fmtBook(d.net_live_pct)}</td>
              <td className="px-3 py-2 text-[#9b968c]">{d.picks ? d.status : "holiday"}</td>
            </tr>,
            open === d.day && (
              <tr key={`${d.day}-positions`}>
                <td colSpan={7} className="bg-[#14161a] px-2 py-2">
                  <Positions rows={positions.filter((p) => p.day === d.day)} money={money} perStock={perStock} stop={stop} />
                </td>
              </tr>
            ),
          ])}
        </tbody>
      </table>
    </div>
  );
}

// Pre-open test (futures): could the book be entered at the 09:15 open by ordering inside the
// futures' pre-open auction, picking the stocks from the 09:06 indicative prices?
function PreopenTest({ slippage, fmtBook }) {
  const [data, setData] = useState(null);
  const [take, setTake] = useState("3");
  const [open, setOpen] = useState(null);
  useEffect(() => {
    fetch(`/api/xsmr/preopen?slippage=${slippage}`)
      .then((r) => r.json())
      .then((p) => setData(p.status === "success" ? p : null))
      .catch(() => setData(null));
  }, [slippage]);
  if (!data) return null;
  const cell = (t) =>
    t ? (
      <>
        <span className={cls(t.net_pct)}>{fmtBook(t.net_pct)}</span>
        <span className="ml-2 text-[#6f6a62]">
          {t.matched}/{t.picks} match
        </span>
      </>
    ) : (
      "—"
    );
  return (
    <Card
      title="Pre-open test · futures"
      right={
        <span className="flex items-center gap-2">
          <Segmented options={[["3", "3 + 3"], ["5", "5 + 5"]]} value={take} onChange={setTake} />
        </span>
      }
    >
      <p className="mb-2 max-w-4xl text-xs text-[#9b968c]">
        Since 8 Dec 2025 current-month futures open with a call auction (orders 09:00–09:08); a market order placed in it
        fills at the futures open. The test: pick the stocks from the futures&apos; indicative prices at 09:06 (the last safe
        moment to order) and enter at the futures open, out at 15:15. "Match" = picks also in the book picked from the
        actual futures open. Nothing is ordered. Snapshots at 09:06 and 09:07 need Kite logged in by 09:05.
      </p>
      {!data.days.length ? (
        <p className="py-6 text-center text-sm text-[#9b968c]">No pre-open snapshots yet. The first is taken at 09:06 on the next trading day.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.1em] text-[#6f6a62]">
              <tr>
                {["Day", "Fresh prices 09:06", "Picked at 09:06", "Picked at 09:07", "Picked from futures open"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c313a] whitespace-nowrap font-mono text-xs">
              {data.days.map((d) => [
                <tr
                  key={d.day}
                  onClick={() => setOpen(open === d.day ? null : d.day)}
                  className={`cursor-pointer ${open === d.day ? "bg-[#e2c08a]/10" : "hover:bg-white/[0.03]"}`}
                >
                  <td className="px-3 py-2 text-[#e7e4dc]">
                    <span className="mr-1 text-[#6f6a62]">{open === d.day ? "▾" : "▸"}</span>
                    {d.day}
                  </td>
                  <td className="px-3 py-2 text-[#9b968c]" title="Futures whose 09:06 price differs from yesterday's close (a live indicative price)">
                    {d.fresh["0906"] ?? 0}/{d.quoted["0906"] ?? 0}
                  </td>
                  <td className="px-3 py-2">{cell(d.takes[take]?.["0906"])}</td>
                  <td className="px-3 py-2">{cell(d.takes[take]?.["0907"])}</td>
                  <td className="px-3 py-2">{cell(d.takes[take]?.open)}</td>
                </tr>,
                open === d.day && (
                  <tr key={`${d.day}-stocks`}>
                    <td colSpan={5} className="bg-[#14161a] px-2 py-2">
                      <table className="w-full text-xs">
                        <thead className="text-left uppercase tracking-[0.1em] text-[#6f6a62]">
                          <tr>
                            {["Future", "Gap @ 09:06", "Gap @ 09:07", "Gap @ open", "Prev close", "Fut open", "15:15", "Move"].map((h) => (
                              <th key={h} className="px-2 py-1 font-medium">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#23272e] font-mono">
                          {d.stocks.map((t) => (
                            <tr key={t.symbol}>
                              <td className="px-2 py-1 text-[#e7e4dc]">{t.fut}</td>
                              <td className={`px-2 py-1 ${cls(t.sig_0906)}`}>{fmtPct(t.sig_0906)}</td>
                              <td className={`px-2 py-1 ${cls(t.sig_0907)}`}>{fmtPct(t.sig_0907)}</td>
                              <td className={`px-2 py-1 ${cls(t.sig_open)}`}>{fmtPct(t.sig_open)}</td>
                              <td className="px-2 py-1 text-[#c8c3b8]">{px(t.prev_close)}</td>
                              <td className="px-2 py-1 text-[#c8c3b8]">{px(t.open)}</td>
                              <td className="px-2 py-1 text-[#c8c3b8]">{px(t.exit)}</td>
                              <td className={`px-2 py-1 ${cls(t.move_pct)}`}>{fmtPct(t.move_pct)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 font-mono text-[0.7rem] text-[#6f6a62]">
        Net = equal rupees per future, entry at the futures open, exit at 15:15, after {data.cost_pct}% costs a day. Click a day for
        every future any version picked (up to 5 + 5).
      </p>
    </Card>
  );
}

export default function XsmrPaperPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slippage, setSlippage] = useState(0.02);
  const [stop, setStop] = useState("none");
  const [unit, setUnit] = useState("rs");
  const [capital, setCapital] = useState(1000000);
  const [showInfo, setShowInfo] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/xsmr/paper?slippage=${slippage}&stop=${stop === "1sd"}`)
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
  }, [slippage, stop]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!data?.market_open) return undefined;
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, [data?.market_open, load]);

  const record = () => {
    setBusy(true);
    fetch("/api/xsmr/record", { method: "POST" })
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") setError(payload.message || "Could not record");
        else if (!payload.recorded && !payload.closed) setError(`Not recorded: ${payload.reason}`);
        load();
      })
      .catch(() => setError("Could not reach the API"))
      .finally(() => setBusy(false));
  };

  const weight = data?.weight ?? 0.1;
  const perStock = capital * weight;
  // Book % (of gross exposure) and per-position % shown as % or rupees at the chosen capital.
  const fmtBook = useMemo(
    () => (v) => (v == null ? "—" : unit === "rs" ? formatRs((v / 100) * capital) : fmtPct(v, 3)),
    [unit, capital],
  );
  const money = useMemo(
    () => (v) => (v == null ? "—" : unit === "rs" ? formatRs((v / 100) * perStock) : fmtPct(v)),
    [unit, perStock],
  );

  const today = data?.today;
  const todayRows = (data?.positions || []).filter((p) => p.day === today);
  const todayLog = data?.log.find((d) => d.day === today);
  // Live book return for today's open positions: weight x signed returns.
  const liveBook = todayRows.length && todayRows.every((r) => r.ret_pct != null) ? weight * todayRows.reduce((a, r) => a + r.ret_pct, 0) : null;
  const sOpen = data?.summary.open;
  const sLive = data?.summary.live;
  const bt = data?.backtest;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Cross-sectional mean reversion · paper trading</h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How cross-sectional mean reversion works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            The backtest's 5 long + 5 short book on the F&amp;O stocks, live: at the 09:15 open, buy the 5 that gapped
            furthest below the average and short the 5 furthest above, equal rupees each; close at 15:15. Recorded
            automatically; no orders are placed.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={record}
            disabled={busy}
            title="Record today's book from the opening prices, and close any positions past 15:15 (automatic in production)"
            className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
          >
            {busy ? "Recording…" : "Record now"}
          </button>
          {data && (
            <p className="font-mono text-xs text-[#6f6a62]">
              {data.market_open ? "market open" : "market closed"}
              {data.ltp_at ? ` · prices ${data.ltp_at}` : ""}
              {loading ? " · loading…" : ""}
            </p>
          )}
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div
          className="flex items-center gap-2"
          title="Both versions are tracked on the same positions. None is the book (exit at 15:15). 1σ: Buy on gap's stop, one standard deviation of the stock's last 90 daily returns from the open; if a 15m candle up to 15:15 trades through it, out at the stop price. While the day is open, a price already past the stop shows as stopped (the candles are checked after 15:15)."
        >
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Stop</span>
          <Segmented options={[["none", "None (book)"], ["1sd", "1σ"]]} value={stop} onChange={setStop} />
        </div>
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Show</span>
          <Segmented options={UNITS} value={unit} onChange={setUnit} />
        </div>
        {unit === "rs" && (
          <div className="flex items-center gap-2" title="Gross exposure: half long, half short, 10% in each stock">
            <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Capital</span>
            <Segmented options={CAPITALS} value={capital} onChange={setCapital} />
          </div>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-[#f0b4b4]">{error}</p>}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Days" value={sOpen ? sOpen.days : "0"} title="Closed paper-trading days" />
            <Stat label="Net / day @ open" value={sOpen ? `${sOpen.mean_bps > 0 ? "+" : ""}${sOpen.mean_bps} bps` : "—"} className={cls(sOpen?.mean_bps)} title={`After ${data.cost_pct}% costs a day (in and out)`} />
            <Stat label="Net / day @ live fill" value={sLive ? `${sLive.mean_bps > 0 ? "+" : ""}${sLive.mean_bps} bps` : "—"} className={cls(sLive?.mean_bps)} title="Entered at the last price a few seconds after 09:15 instead of the open" />
            <Stat label="Total @ open" value={sOpen ? fmtBook(sOpen.total_pct) : "—"} className={cls(sOpen?.total_pct)} />
            <Stat label="Winning days" value={sOpen ? `${sOpen.win_pct}%` : "—"} />
            <Stat
              label="Backtest net / day"
              value={bt ? `${bt.all_bps > 0 ? "+" : ""}${bt.all_bps} bps` : "—"}
              title={bt ? `5 + 5 at 09:15 since 2015; ${bt.year}: ${bt.year_bps} bps a day` : ""}
            />
          </div>

          <Card
            title={`Today · ${today}`}
            right={
              todayLog
                ? `recorded ${todayLog.recorded_at} · ${todayLog.quoted} stocks quoted · average gap ${fmtPct(todayLog.mean_signal_pct)}${
                    liveBook != null ? ` · book ${unit === "rs" ? fmtBook(liveBook) : fmtPct(liveBook, 3)} gross` : ""
                  }`
                : "not recorded"
            }
          >
            {todayRows.length ? (
              <Positions rows={todayRows} money={money} perStock={perStock} stop={stop === "1sd"} />
            ) : (
              <p className="py-6 text-center text-sm text-[#9b968c]">
                {todayLog
                  ? "No positions today (holiday)."
                  : "The book is picked from the opening prices at 09:15:01 on trading days (Kite must be logged in)."}
              </p>
            )}
            <p className="mt-2 font-mono text-[0.7rem] text-[#6f6a62]">
              Return is each position's own move (signed), in % or rupees on {formatRs(perStock)} per stock. Futures come in
              lots, so equal rupees is approximate: "Lots" is how many lots {formatRs(perStock)} buys.
            </p>
          </Card>

          <Card title="Paper log" right={`net after ${data.cost_pct}% costs a day · click a day for its positions`}>
            <Log log={data.log} positions={data.positions} fmtBook={fmtBook} money={money} perStock={perStock} stop={stop === "1sd"} />
          </Card>

          <PreopenTest slippage={slippage} fmtBook={fmtBook} />
        </>
      )}

      {showInfo && (
        <ModelInfoModal title="Cross-sectional mean reversion · how it works" onClose={() => setShowInfo(false)}>
          <XsmrInfo />
        </ModelInfoModal>
      )}
    </div>
  );
}
