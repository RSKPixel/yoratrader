import { useCallback, useMemo, useState } from "react";
import { useSetting } from "./settings";
import { Field, Segmented } from "./V2Controls";
import V2EquityChart from "./V2EquityChart";
import { Card, makeValue, MonthGrid, MonthTradesModal, Panel, SummaryCards, tone, AT_COLUMNS } from "./V2BacktestView";
import { SLIPPAGE_DEFAULT, SLIPPAGE, useBacktest } from "./V2BuyOnGap";

// Turn of the month (v2tom.py): long the index future around each month end, from the close a few days
// before it to the close of the 3rd trading day of the next month; out of the market the rest of the time.

const INDICES = [
  ["nifty", "Nifty 50"],
  ["banknifty", "Nifty Bank"],
];
const WINDOWS = [
  ["4", "Last 4 days → 3rd"],
  ["1", "Last day → 3rd"],
];

export default function V2Tom({ params }) {
  const [index, setIndex] = useSetting("bt.tom.index", "nifty");
  const [win, setWin] = useSetting("bt.tom.window", "4");
  const [slippage, setSlippage] = useSetting("bt.tom.slippage", SLIPPAGE_DEFAULT.tom);
  const [instrument, setInstrument] = useSetting("bt.tom.instrument", "futures");
  const [month, setMonth] = useState(null);

  const query = `index=${index}&window=${win}&slippage=${slippage}&instrument=${instrument}`;
  const { data, error, loading } = useBacktest(`/api/v2/backtest/tom?${query}`);
  const value = useMemo(() => makeValue(params.show, params.capital), [params.show, params.capital]);
  const chartFormat = useCallback((v) => value(v, 1), [value]);
  const closeMonth = useCallback(() => setMonth(null), []);
  const s = data?.summary;

  const columns = [
    ...AT_COLUMNS,
    { h: "Reason", cell: (t) => t.reason, style: () => ({ color: "var(--muted)" }) },
    { h: "Index", cell: (t) => <span className="font-medium">{t.symbol}</span> },
    { h: "Days", cell: (t) => t.days_held, style: () => ({ color: "var(--muted)" }) },
    { h: "Entry", cell: (t) => t.entry },
    { h: "Exit", cell: (t) => t.exit },
    { h: "Return", cell: (t) => `${t.ret_pct.toFixed(2)}%`, style: (t) => ({ color: tone(t.ret_pct) }) },
    { h: "Charges", cell: (t) => value(-t.book_cost_pct, 3), style: () => ({ color: "var(--negative)" }), title: () => "Buy, sale and one futures roll" },
    { h: "Net result", cell: (t) => <span className="font-medium">{value(t.book_net_pct, 3)}</span>, style: (t) => ({ color: tone(t.book_net_pct) }) },
  ];

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Instrument" hint="Futures: the near-month index future's own closes (stored futures daily candles: Nifty from Oct 2010, Bank Nifty from Mar 2011), adjusted at each expiry so the move to the next contract isn't counted. Spot (index): the index's closes over the same years, to compare (the index itself can't be bought). Both pay futures charges and a roll.">
          <Segmented label="Instrument" options={[["spot", "Spot (index)"], ["futures", "Futures"]]} value={instrument} onChange={setInstrument} />
        </Field>
        <Field label="Index" hint="Traded as the near-month future">
          <Segmented label="Index" options={INDICES} value={index} onChange={setIndex} />
        </Field>
        <Field label="Window" hint="Bought at the close before the month's last 4 days (or its last day), sold at the close of the next month's 3rd trading day">
          <Segmented label="Window" options={WINDOWS} value={win} onChange={setWin} />
        </Field>
        <Field label="Slippage" hint="Per side, on top of NSE futures charges">
          <Segmented label="Slippage" options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </Field>
        {loading && <span className="pb-1.5 text-xs" style={{ color: "var(--faint)" }}>Loading…</span>}
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}

      {s && (
        <>
          <SummaryCards s={s} value={value} />
          {s.in_market_pct > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Card label="Capital in use" value={`${s.in_market_pct}% of days`} hint={`In the market about ${s.avg_days} trading days a month; the capital is free (for other books) the rest of the time`} />
              <Card
                label="Net a year while invested"
                value={value((100 * s.net_year_pct) / s.in_market_pct)}
                color={tone(s.net_year_pct)}
                hint={`Net a year ÷ the share of days in the market (${value(s.net_year_pct)} ÷ ${s.in_market_pct}%): the return on the capital for the days it's actually used. CAGR and Net a year count the idle days too.`}
              />
              <Card label="Net a year (whole year)" value={value(s.net_year_pct)} color={tone(s.net_year_pct)} hint="As if the capital sat idle between trades" />
            </div>
          )}
          <Panel title="Net by month" right="click a month for its trade">
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
          url={`/api/v2/backtest/tom/month?month=${month}&${query}`}
          columns={columns}
          value={value}
          note="bought before the month end, sold at the close of the 3rd trading day"
          onClose={closeMonth}
        />
      )}
    </div>
  );
}
