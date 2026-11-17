import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone } from "./V2BacktestView";
import { useBacktest } from "./V2BuyOnGap";

// Option straddles (v2straddle.py) on Nifty / Bank Nifty monthly options, NSE daily data 2008 on.
// strategy "short": sell the at-the-money call + put the day after a monthly expiry, hold to the next expiry.
// strategy "fly": the same plus a bought call and put ~5% away (iron butterfly: the worst loss is capped).
// strategy "late": the short straddle sold 10 trading days before expiry. strategy "long": the straddle BOUGHT
// 10 trading days before expiry, only after a quiet week (the index's last 7-day move within +-1%).

const INDICES = [
  ["nifty", "Nifty"],
  ["banknifty", "Bank Nifty"],
];
const SLIPPAGE = [
  ["0.25", "0.25%"],
  ["0.5", "0.5%"],
  ["1", "1%"],
];

export default function V2Straddle({ params, strategy = "short" }) {
  const [index, setIndex] = useSetting(`bt.straddle.${strategy}.index`, "nifty");
  const [slippage, setSlippage] = useSetting(`bt.straddle.${strategy}.slippage`, "0.5");
  const [month, setMonth] = useState(null);
  const query = `index=${index}&strategy=${strategy}&slippage=${slippage}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/straddle?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;
  const rs = (v) => `${v < 0 ? "−" : v > 0 ? "+" : ""}₹${Math.abs(v).toLocaleString("en-IN")}`;

  const columns = [
    { h: "Sold", cell: (t) => t.entry_at },
    { h: "Expiry", cell: (t) => t.day, style: () => ({ color: "var(--muted)" }) },
    { h: "Straddle", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Future", cell: (t) => t.fut },
    { h: "Call + put", cell: (t) => `${t.ce} + ${t.pe}` },
    ...(strategy === "fly" ? [{ h: "Wings bought", cell: (t) => t.bought, style: () => ({ color: "var(--muted)" }) }] : []),
    { h: strategy === "long" ? "Paid" : "Credit", cell: (t) => (strategy === "long" ? -t.premium : t.premium) },
    { h: "Settled at", cell: (t) => t.settle },
    strategy === "long"
      ? { h: "Got back", cell: (t) => -t.payout, style: () => ({ color: "var(--positive)" }) }
      : { h: "Paid out", cell: (t) => t.payout, style: () => ({ color: "var(--negative)" }) },
    { h: "Net", cell: (t) => `${t.net_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.net_pct) }) },
    { h: "Per lot", cell: (t) => rs(t.net_rs_lot), style: (t) => ({ color: tone(t.net_rs_lot) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Index" hint="Monthly options of this index (NSE daily data: Nifty from 2008, Bank Nifty from mid-2008)">
          <Segmented label="Index" options={INDICES} value={index} onChange={setIndex} />
        </Field>
        <Field label="Slippage" hint="Per leg, as a share of its premium, when selling (bid/ask spread). Settled by the exchange at expiry: no closing trade">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {data && !s && <p className="text-sm" style={{ color: "var(--muted)" }}>No trades.</p>}
      {s && (
        <>
          <SummaryCards s={s} value={value} />
          <p className="-mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {strategy === "fly" &&
              `Wings ~${s.avg_width_pct}% away · credit ${s.avg_premium_pct}% · most a month can lose ${s.avg_max_loss_pct}% of the contract (on that risk: ${s.return_on_risk_year_pct ?? "—"}% a year) · `}
            {s.from} → {s.to} · % of the contract value (fully funded, no leverage: on margin, about 12% of it, results and drops are about 8×) · premium {s.avg_premium_pct}%
            of the future on average · best month {s.best_month_pct}%, worst {s.worst_month_pct}% · {rs(s.avg_net_rs_per_lot)} a month per lot ({s.lot} units, today's lot) ·
            costs: STT 0.15% of premium sold, exchange and SEBI fees, stamp duty, ₹20 an order, slippage
          </p>
          <Panel title="Net by month" right="click a month for its straddle (results count on the expiry day)">
            <MonthGrid years={data.years} months={data.months} value={value} onOpen={setMonth} />
          </Panel>
          <Panel title="Equity" right="cumulative, marked at each close, not compounded · accent = net, grey = gross">
            <V2EquityChart points={data.equity} format={chartFormat} />
          </Panel>
        </>
      )}
      {month && (
        <MonthTradesModal
          month={month}
          url={`/api/v2/backtest/straddle/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note={
            strategy === "long"
              ? "bought at the close 10 trading days before expiry (a quiet week only), settled at the expiry's final settlement price"
              : strategy === "vrp"
              ? "sold the day after the last expiry only when the straddle's implied volatility was above the index's last-20-day volatility"
              : strategy === "late"
              ? "sold at the close 10 trading days before expiry, settled at the expiry's final settlement price"
              : "sold at the close the day after the last expiry, settled at the expiry's final settlement price"
          }
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
