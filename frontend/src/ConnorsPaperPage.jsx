import { useEffect, useState } from "react";
import ModelInfoModal, { ConnorsInfo, InfoButton } from "./ModelInfoModal";
import { Segmented, SLIPPAGE, Stat } from "./backtestShared";

// Short-term mean reversion (Connors & Sen), paper trading: the backtest page's defaults, recorded
// at 15:15 each trading day by the production scheduler. Nothing places orders.

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

function Table({ head, children, min = 760 }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" style={{ minWidth: min }}>
        <thead className="text-left uppercase tracking-[0.1em] text-[#6f6a62]">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#23272e] whitespace-nowrap font-mono">{children}</tbody>
      </table>
    </div>
  );
}

const Empty = ({ cols, text }) => (
  <tr>
    <td colSpan={cols} className="px-2 py-4 text-center text-[#6f6a62]">
      {text}
    </td>
  </tr>
);

export default function ConnorsPaperPage() {
  const [slippage, setSlippage] = useState(0.02);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    fetch(`/api/connors/paper?slippage=${slippage}`)
      .then((r) => r.json())
      .then((payload) => {
        if (payload.status !== "success") setError(payload.message || payload.detail || "Could not load the paper log");
        else {
          setError("");
          setData(payload);
        }
      })
      .catch(() => setError("Could not reach the API"));
  }, [slippage]);

  const s = data?.summary;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Paper trading · Short-term mean reversion</h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How this model works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            Positional, long only. At 15:15 each trading day: sell positions on their 5th trading day, then buy the F&amp;O
            stocks above their 200-day average with a 2-day RSI below 10, most oversold first, up to{" "}
            {data?.max_open ?? 3} open at once, equal capital each. The backtest's defaults; nothing places orders.
          </p>
        </div>
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
      </header>

      {error && <p className="mb-4 text-sm text-[#f0b4b4]">{error}</p>}
      {s && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Closed trades" value={s.trades} />
            <Stat label="Open" value={`${s.open} / ${data.max_open}`} />
            <Stat label="Win rate" value={s.win_rate == null ? "—" : `${s.win_rate}%`} />
            <Stat label="Net / trade" value={fmtPct(s.avg_net_pct)} className={cls(s.avg_net_pct)} title="Stock prices, after charges and slippage on both sides" />
            <Stat label="Book net (stock)" value={fmtPct(s.book_net_pct)} className={cls(s.book_net_pct)} title={`Each position is 1/${data.max_open} of capital, so a trade adds 1/${data.max_open} of its net`} />
            <Stat label="Book net (futures)" value={fmtPct(s.fut_book_net_pct)} className={cls(s.fut_book_net_pct)} title="The same trades at the futures prices recorded at the same moment" />
          </div>

          <Card title="Open positions" right={`sold at 15:15 on the ${data.hold}th trading day`}>
            <Table head={["Stock", "Bought", "At", "RSI", "Buy", "Future", "Future buy", "Day"]}>
              {data.open.length === 0 && <Empty cols={8} text="No open positions." />}
              {data.open.map((t) => (
                <tr key={`${t.symbol}-${t.buy_day}`}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{t.symbol}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.buy_day}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.buy_at}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.rsi}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.buy)}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.fut ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.fut_buy)}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">
                    {t.day_of_hold} / {data.hold}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Closed trades" right={`costs ${s.cost_per_side_bps} bps per side`}>
            <Table head={["Stock", "Bought", "RSI", "Buy", "Sold", "Sell", "Gross", "Net", "Future", "Future net"]} min={900}>
              {data.closed.length === 0 && <Empty cols={10} text="No closed trades yet." />}
              {data.closed.map((t) => (
                <tr key={`${t.symbol}-${t.buy_day}`}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{t.symbol}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.buy_day}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.rsi}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.buy)}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.sell_day}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.sell)}</td>
                  <td className={`px-2 py-1.5 ${cls(t.gross_pct)}`}>{fmtPct(t.gross_pct)}</td>
                  <td className={`px-2 py-1.5 ${cls(t.net_pct)}`}>{fmtPct(t.net_pct)}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.fut ?? "—"}</td>
                  <td className={`px-2 py-1.5 ${cls(t.fut_net_pct)}`}>{fmtPct(t.fut_net_pct)}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Daily log" right="recorded at 15:15 by the production scheduler">
            <Table head={["Day", "At", "Qualified", "Above 200-day", "Signals", "Sold", "Bought", "Note"]}>
              {data.days.length === 0 && <Empty cols={8} text="Nothing recorded yet: the first run is the next trading day at 15:15 (Kite login needed)." />}
              {data.days.map((d) => (
                <tr key={d.day}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{d.day}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{d.recorded_at}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.rankable ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.above_average ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.signals ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.sold ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.bought ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{d.note ?? ""}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
      {showInfo && (
        <ModelInfoModal title="Short-term mean reversion" onClose={() => setShowInfo(false)}>
          <ConnorsInfo />
        </ModelInfoModal>
      )}
    </div>
  );
}
