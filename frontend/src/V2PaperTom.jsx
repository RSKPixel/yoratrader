import { Card, Panel, tone } from "./V2BacktestView";
import { formatRs } from "./V2Controls";
import { useBacktest, useLiveRefresh } from "./V2BuyOnGap";
import { PositionsTable, StatusLine } from "./V2PaperView";
import { InstrumentSlot } from "./V2SideNav";

// Turn of the month paper trading: one lot of the Nifty future, bought at 15:15 on the month's 5th-last trading
// day and sold at 15:15 on the next month's 3rd (tomwatch.py). The live page trades an in-the-money call instead.

const rs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—");

export default function V2PaperTom() {
  const live = useLiveRefresh();
  const { data, error } = useBacktest("/api/v2/paper/tom", { refreshMs: live });
  if (error) return <p className="mt-4 text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!data) return <p className="mt-4 text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  const s = data.summary, p = data.plan;
  const cols = [
    { h: "Contract", cell: (t) => <span className="font-medium">{t.fut}</span> },
    { h: "Lot", cell: (t) => t.lot },
    { h: "Bought", cell: (t) => t.entry_at },
    { h: "Buy", cell: (t) => t.buy },
    { h: "Sold", cell: (t) => t.exit_at ?? `due ${day(t.sell_plan)} 15:15` },
    { h: "Sell / last", cell: (t) => t.sell ?? t.ltp ?? "—" },
    { h: "Value", cell: (t) => formatRs(t.contract_rs) },
    { h: "Costs", cell: (t) => (t.cost_rs == null ? "—" : formatRs(-t.cost_rs)), style: () => ({ color: "var(--negative)" }) },
    { h: "Net", cell: (t) => `${rs(t.net_rs)}${t.net_pct == null ? "" : ` · ${t.net_pct > 0 ? "+" : ""}${t.net_pct}%`}`, style: (t) => ({ color: tone(t.net_rs) }) },
  ];
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <InstrumentSlot />
      </div>
      <StatusLine>
        Recorded at 15:15: one lot of the nearest Nifty future expiring after the sale (no roll), bought on the month's 5th-last
        trading day and sold on the next month's 3rd · costs {s.cost_per_side_bps} bps a side · nothing places orders (the live page
        trades an in-the-money call in its place)
      </StatusLine>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card label="Now" value={p.state === "waiting" ? `${p.days_to_buy} days to the buy` : p.state} />
        <Card label="Buy · sell (15:15)" value={`${day(p.buy)} · ${day(p.sell)}`} />
        <Card label="Open now" value={rs(s.open_net_rs)} color={tone(s.open_net_rs)} hint="The open position marked at the last price, after costs" />
        <Card label="Realized net" value={rs(s.net_rs)} color={tone(s.net_rs)} hint={`${s.trades} closed trades${s.win_rate == null ? "" : `, ${s.win_rate}% won`}`} />
        <Card label="Contract value" value={s.capital_rs ? formatRs(s.capital_rs) : "—"} hint="One lot's value at the buy (the margin is a fraction of it)" />
      </div>
      <Panel title="Trades" right="one lot each, after futures charges and slippage">
        <PositionsTable rows={data.trades} columns={cols} minWidth={820} empty={`No trades yet: the first buy is ${day(p.buy)} at 15:15.`} />
      </Panel>
    </div>
  );
}
