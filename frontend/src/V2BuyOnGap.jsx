import { InstrumentSlot } from "./V2SideNav";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSetting } from "./settings";
import { useResume } from "./resume";
import { Field, formatRs, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import DisasterStop from "./V2Disaster";

// Buy/Sell on gap (Chan, Algorithmic Trading ch. 4) on v2: the stored backtest trades sized by the
// common parameters (universe, capital, max open, % or ₹).

const SIDES = [
  ["long", "Long (book)"],
  ["both", "Long & short"],
];
// Opening gap momentum (Chan ch. 7) is the mirror image: follow the gap; the book trades both sides.
const MOM_SIDES = [
  ["both", "Long & short (book)"],
  ["long", "Long only"],
];
const STOPS = [
  ["none", "None (book)"],
  ["1sd", "1σ"],
];
// Each model's default slippage, % per side, from how it would really trade: the opening auction costs
// nothing; an exit at 15:15 or a liquid future a little; a buy-stop (Oops) fills above its level in a fast move.
export const SLIPPAGE_DEFAULT = {
  gap: 0.01, gapmom: 0.01, xsmr: 0.01, oops: 0.05, connors: 0.01, tom: 0.01,
  kbdt: 0.02, pairs: 0.02, xsmom: 0.02, qmom: 0.02, ltlv: 0.02, mix: 0.02,
};

export const SLIPPAGE = [
  [0, "0%"],
  [0.01, "0.01%"],
  [0.02, "0.02%"],
  [0.05, "0.05%"],
  [0.1, "0.1%"],
  [0.15, "0.15%"],
];

export function useBacktest(url, { refreshMs = 0 } = {}) {
  // refreshMs: refetch on this interval (a live paper page while the market is open), keeping the
  // data on screen in between
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const lastUrl = useRef(null);
  const resumed = useResume();
  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);
  useEffect(() => {
    const controller = new AbortController();
    if (lastUrl.current !== url) setLoading(true); // a new query, not a live refresh
    lastUrl.current = url;
    fetch(url, { signal: controller.signal })
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success") setError(p.message || p.detail || "Could not load the backtest");
        else {
          setError("");
          setData(p);
        }
      })
      .catch((e) => e.name !== "AbortError" && setError("Could not reach the API"))
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, resumed]);
  return { data, error, loading };
}

// Paper pages refresh their live prices this often while the market is open
export const LIVE_REFRESH_MS = 20000;

export function marketHours() {
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  const m = ist.getHours() * 60 + ist.getMinutes();
  return ist.getDay() > 0 && ist.getDay() < 6 && m >= 555 && m <= 935; // 09:15-15:35
}

export function useLiveRefresh() {
  // re-check each minute whether the market is open, so a page left open starts / stops polling
  const [open, setOpen] = useState(marketHours);
  useEffect(() => {
    const timer = setInterval(() => setOpen(marketHours()), 60000);
    return () => clearInterval(timer);
  }, []);
  return open ? LIVE_REFRESH_MS : 0;
}

export default function V2BuyOnGap({ params, model = "gap" }) {
  const mom = model === "gapmom";
  const [side, setSide] = useSetting(`bt.${model}.side`, mom ? "both" : "long");
  const [savedStop, setStop] = useSetting(`bt.${model}.stop`, "none");
  const stop = model === "gapmom" ? savedStop : "none"; // Buy/Sell on gap: no stop, only the disaster stop
  const [disaster, setDisaster] = useSetting(`bt.${model}.disaster`, "on");
  const [slippage, setSlippage] = useSetting(`bt.${model}.slippage`, SLIPPAGE_DEFAULT[model]);
  const [month, setMonth] = useState(null);
  const [savedInstrument, setInstrument] = useSetting("bt.gap.instrument", "futures");
  const pit = !mom && params.universe === "fnopit"; // Spot is offered with survivorship bias off (the shares' daily files)
  const instrument = pit && savedInstrument === "spot" ? "spot" : "futures";
  const [savedEntry, setEntry] = useSetting("bt.gap.entry", "0915");
  const minutes = !mom && params.universe === "fno"; // the 09:16 entry needs the 1-minute candles (today's F&O list, 2015 on)
  const entry = minutes && savedEntry === "0916" ? "0916" : "0915";

  const query = `dataset=${params.universe}&side=${side}&stop=${stop}&slippage=${slippage}&max_open=${params.maxOpen}${model === "gap" ? `&disaster=${disaster}&instrument=${instrument}&entry=${entry}` : ""}`;
  const api = mom ? "/api/v2/backtest/gapmom" : "/api/v2/backtest/gap";
  const { data, error, loading } = useBacktest(`${api}?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const capital = params.capital;

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: (t) => ({ color: t.reason.startsWith("stop") ? "var(--negative)" : "var(--muted)" }) },
    { h: "Stock", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Side", cell: (t) => t.side, style: (t) => ({ color: t.side === "long" ? "var(--positive)" : "var(--negative)" }) },
    { h: "Gap", cell: (t) => `${t.gap_pct.toFixed(2)}%`, style: () => ({ color: "var(--muted)" }), title: (t) => `Rank ${t.rank} that day` },
    { h: "Entry", cell: (t) => t.entry },
    {
      h: "Qty",
      cell: (t) => Math.round(((t.weight_pct / 100) * capital) / t.entry).toLocaleString("en-IN"),
      title: (t) => `${t.weight_pct}% of ${formatRs(capital)} ÷ ${t.entry}`,
    },
    { h: "Stop", cell: (t) => t.stop, style: () => ({ color: "var(--muted)" }) },
    { h: "Exit", cell: (t) => t.exit },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Size", cell: (t) => value(t.weight_pct), style: () => ({ color: "var(--muted)" }) },
    { h: "Charges", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }) },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        {mom || params.universe !== "fnopit" && params.universe !== "fno" ? (
          <InstrumentSlot />
        ) : (
          <Field label="Instrument" hint="Futures: the near-month future's own prices, futures charges. Spot: the shares, bought and shorted within the day, with intraday equity charges (brokerage 0.03%, STT 0.025% on sells, exchange, stamp, GST). Spot is here with survivorship bias off (NSE's daily files of the shares; out at the official close).">
            <Segmented
              label="Instrument"
              options={[["spot", "Spot", !pit, !pit ? "Turn survivorship bias off for Spot" : undefined], ["futures", "Futures"]]}
              value={instrument}
              onChange={setInstrument}
            />
          </Field>
        )}
        {!mom && (
          <Field label="Entry" hint="09:15: at the open (the book). 09:16: a minute later, at the 09:16 minute's opening price (the 1-minute candles, today's F&O list only): what a real order sent once the open is known gets when the price has already moved. The signal is the open either way.">
            <Segmented
              label="Entry"
              options={[["0915", "09:15 open"], ["0916", "09:16", !minutes, !minutes ? "Needs the 1-minute candles: today's F&O list only" : undefined]]}
              value={entry}
              onChange={setEntry}
            />
          </Field>
        )}
        <Field
          label="Side"
          hint={mom ? "Long & short: buy opens above the previous high by 0.1σ, short opens below the previous low (the book)." : "Long: buy gaps down (the book). Long & short: also short the mirror image."}
        >
          <Segmented label="Side" options={mom ? MOM_SIDES : SIDES} value={side} onChange={setSide} />
        </Field>
        {model === "gapmom" ? (
        <Field label="Stop" hint="None: out at 15:15 (the book). 1σ: a stop one 90-day standard deviation from the entry.">
          <Segmented label="Stop" options={STOPS} value={stop} onChange={setStop} />
        </Field>
        ) : (
          <DisasterStop value={disaster} onChange={setDisaster} hits={disaster === "on" ? data?.summary?.disaster_hits : null} />
        )}
        <Field label="Slippage" hint={`Per side, on top of the ${instrument === "spot" ? "intraday equity" : "NSE futures"} charges`}>
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && (
          <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>
            Loading…
          </span>
        )}
      </div>

      {params.universe === "fnopit" && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {instrument === "spot"
            ? "Survivorship bias off, Spot: each month's real F&O list, dropped stocks included, from 2015, on the shares' own daily prices (NSE's files). The same rule, in at the open, out at the official close (no 15:15 price in the daily files), the stops checked on the day's low and high."
            : "Survivorship bias off: every stock that had futures that day, dropped ones included, from 2015, on the near-month future's own daily prices (NSE's F&O files). The same rule, in at the open; NSE's daily files have no 15:15 price, so out at the official close, and the stops are checked on the day's low and high."}
        </p>
      )}
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!error && data && !s && <p className="text-sm" style={{ color: "var(--muted)" }}>No trades for these settings.</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <Panel title="Net by month" right="click a month for its trades">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>
          <Panel title="Equity" right="cumulative, fixed capital, not compounded · accent = net, grey = gross">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
      {month && (
        <MonthTradesModal
          month={month}
          url={`${api}/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="in at the 09:15 open, out at 15:15 (or the stop)"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
