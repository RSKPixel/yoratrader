import { useEffect, useMemo, useState } from "react";
import { Field, formatRs, Segmented } from "./V2Controls";
import { tone } from "./V2BacktestView";
import { SLIPPAGE, useBacktest } from "./V2BuyOnGap";
import { DayLog, LotCards, lotColumns, lotMoney, netBoth, Panel, PositionsTable, StatusLine } from "./V2PaperView";

// Cross-sectional mean reversion paper trading on v2: the 5 long + 5 short the production scheduler
// records at the 09:15 open, k + k of them by Pairs, one lot each; plus the pre-open
// test (futures auction prices at 09:06 / 09:07 against the futures open). Nothing places orders.

const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];
const PREOPEN_TAKES = [
  ["3", "3+3"],
  ["5", "5+5"],
];

const pctOf = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);

function PreopenTest({ slippage }) {
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
    t?.net_pct == null ? (
      <span style={{ color: "var(--faint)" }}>—</span>
    ) : (
      <span>
        <span className="font-medium" style={{ color: tone(t.net_pct) }}>
          {pctOf(t.net_pct, 3)}
        </span>
        <span className="ml-2 text-[0.6875rem]" style={{ color: "var(--faint)" }}>
          {t.matched}/{t.picks} match
        </span>
      </span>
    );
  return (
    <Panel
      title="Pre-open test · futures"
      right="picks from the futures auction prices at 09:06 / 09:07 against the futures open, entered at the futures open, out at 15:15"
    >
      <div className="mb-3 flex items-center gap-3">
        <Segmented label="Take" options={PREOPEN_TAKES} value={take} onChange={setTake} />
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          net after {data.cost_pct}% costs a day · fresh = futures whose price had moved off yesterday's close at 09:06
        </span>
      </div>
      {!data.days.length ? (
        <p className="py-4 text-center text-sm" style={{ color: "var(--muted)" }}>
          No pre-open snapshots yet: the first is the next trading day at 09:06 (Kite login needed before 09:05).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-xs tabular-nums">
            <thead className="text-left" style={{ color: "var(--faint)" }}>
              <tr>
                {["Day", "Fresh at 09:06", "Picked at 09:06", "Picked at 09:07", "From the futures open"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => [
                <tr key={d.day} className="cursor-pointer border-t hover:bg-[var(--surface-2)]" style={{ borderColor: "var(--border)" }} onClick={() => setOpen(open === d.day ? null : d.day)}>
                  <td className="px-3 py-1.5 font-medium">{d.day}</td>
                  <td className="px-3 py-1.5" style={{ color: "var(--muted)" }}>
                    {d.fresh["0906"] ?? 0}/{d.quoted["0906"] ?? 0}
                  </td>
                  <td className="px-3 py-1.5">{cell(d.takes[take]?.["0906"])}</td>
                  <td className="px-3 py-1.5">{cell(d.takes[take]?.["0907"])}</td>
                  <td className="px-3 py-1.5">{cell(d.takes[take]?.open)}</td>
                </tr>,
                open === d.day && (
                  <tr key={`${d.day}-x`}>
                    <td colSpan={5} className="px-3 pb-3">
                      <PositionsTable
                        rows={d.stocks}
                        minWidth={760}
                        columns={[
                          { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
                          { h: "Future", cell: (t) => t.fut, style: () => ({ color: "var(--muted)" }) },
                          { h: "Gap at 09:06", cell: (t) => (t.sig_0906 == null ? "—" : `${t.sig_0906}%`) },
                          { h: "Gap at 09:07", cell: (t) => (t.sig_0907 == null ? "—" : `${t.sig_0907}%`) },
                          { h: "Gap at open", cell: (t) => (t.sig_open == null ? "—" : `${t.sig_open}%`) },
                          { h: "Open", cell: (t) => t.open ?? "—" },
                          { h: "Exit", cell: (t) => t.exit ?? "—" },
                          { h: "Move", cell: (t) => (t.move_pct == null ? "—" : `${t.move_pct}%`), style: (t) => ({ color: tone(t.move_pct) }) },
                        ]}
                      />
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function V2PaperXsmr({ params }) {
  const [pairs, setPairs] = useState(5);
  const [stop, setStop] = useState("none");
  const [slippage, setSlippage] = useState(0.02);
  const maxPairs = Math.min(5, Math.floor(params.maxOpen / 2));
  const k = params.maxOpen ? Math.max(1, Math.min(pairs, maxPairs || 1)) : 5;
  const pairOptions = [1, 2, 3, 4, 5].map((n) => [
    n,
    `${n}+${n}`,
    !params.maxOpen || 2 * n > params.maxOpen,
    !params.maxOpen ? "As per model: the recorded 5 + 5" : 2 * n > params.maxOpen ? `Needs Max open ${2 * n} or more` : undefined,
  ]);
  const { data, error, loading } = useBacktest(`/api/v2/paper/xsmr?pairs=${k}&stop=${stop}&slippage=${slippage}&max_open=${params.maxOpen}`);
  const money = useMemo(() => lotMoney(params.show), [params.show]);
  const lot = lotColumns(money);

  const columns = [
    { h: "Side", cell: (t) => `${t.side} #${t.rank}`, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Signal", cell: (t) => (t.signal_pct == null ? "—" : `${t.signal_pct > 0 ? "+" : ""}${t.signal_pct}%`), style: () => ({ color: "var(--muted)" }), title: () => "Open vs previous close: the move the model fades" },
    { h: "Open", cell: (t) => t.entry, title: (t) => (t.entry_live ? `Live fill ${t.entry_live} at ${t.live_at}` : undefined) },
    lot.qty,
    ...(stop === "1sd" ? [{ h: "Stop", cell: (t) => t.stop ?? "—", style: () => ({ color: "var(--muted)" }) }] : []),
    { h: "Exit / last", cell: (t) => t.exit ?? "—" },
    { h: "Reason", cell: (t) => t.reason ?? "—", style: (t) => ({ color: t.reason?.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Return", cell: (t) => (t.ret_pct == null ? "—" : `${t.ret_pct.toFixed(2)}%`), style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => (t.net_pct == null ? "—" : `${t.net_pct.toFixed(2)}%`), style: (t) => ({ color: tone(t.net_pct) }) },
    lot.value,
    lot.margin,
    lot.result,
  ];
  const today = data?.days.find((d) => d.day === data.today);
  const bt = data?.backtest;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Pairs" hint="k long + k short of the recorded 5 + 5 (the furthest from the day's average move first); one lot each.">
          <Segmented label="Pairs" options={pairOptions} value={params.maxOpen ? k : null} onChange={setPairs} />
        </Field>
        <Field label="Stop" hint="Not in the book. 1σ: Buy on gap's stop, recorded alongside the book.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {data && (
        <>
          <StatusLine>
            {data.today_recorded
              ? `Today (${data.today}) recorded from the 09:15 open${data.ltp_at ? ` · live prices at ${data.ltp_at}` : ""}`
              : data.market_open
              ? "Waiting for today's 09:15 open (the production scheduler records it)"
              : "Recorded from the 09:15 open on trading days, closed at 15:15"}
            {bt ? ` · backtest ${bt.all_bps} bps a day net (${bt.year}: ${bt.year_bps})` : ""} · costs {data.cost_per_side_bps} bps a side · nothing places orders
          </StatusLine>
          <LotCards s={{ ...data.summary, win_rate: data.summary.win_rate_lots, win_days: data.summary.win_days_lots }} money={money} />
          <Panel title={`Today · ${data.today}`} right={today ? `${today.status === "open" ? "open, live" : "closed"} · margin ${formatRs(today.margin_rs)} · net ${netBoth(today.net_rs, today.net_value_pct)}` : undefined}>
            <PositionsTable rows={today?.picks || []} columns={columns} minWidth={1000} empty="No positions today." />
          </Panel>
          <Panel title="Paper log" right="a row a day · click for its positions">
            <DayLog days={data.days} columns={columns} dayValue={(d) => netBoth(d.net_rs, d.net_value_pct)} dayNote={(d) => `margin ${formatRs(d.margin_rs)}`} minWidth={1000} empty="Nothing recorded yet: the first paper day is the next trading day at 09:15 (Kite login needed)." />
          </Panel>
          <PreopenTest slippage={slippage} />
        </>
      )}
    </div>
  );
}
