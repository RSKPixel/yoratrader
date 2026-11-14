import { useEffect, useState } from "react";
import ModelInfoModal, { InfoButton, VboInfo } from "./ModelInfoModal";
import { Segmented, SLIPPAGE, Stat } from "./backtestShared";

// Volatility breakout (Larry Williams), paper trading on the five F&O indices: the backtest page's
// index book, recorded by the production scheduler at 09:15:01 (sales and levels) and after 15:16
// (breakouts from the 15m candles). Index and futures versions side by side. Nothing places orders.

const fmtPct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)}%`);
const px = (v) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const cls = (v) => (v == null ? "text-[#6f6a62]" : v > 0 ? "text-[#8fbf9f]" : v < 0 ? "text-[#f0b4b4]" : "text-[#c8c3b8]");

const KS = [
  ["1", "k = 1.0 (page default)"],
  ["0.5", "k = 0.5"],
];
const BASES = [
  ["futures", "Futures prices"],
  ["index", "Index prices (backtest)"],
];

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

export default function VboPaperPage() {
  const [slippage, setSlippage] = useState(0.02);
  const [k, setK] = useState("1");
  const [basis, setBasis] = useState("futures");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    fetch(`/api/vbo/paper?slippage=${slippage}`)
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

  const book = data?.books?.[`${basis}-${k}`] || { open: [], closed: [], summary: { trades: 0, open: 0, book_net_pct: 0 } };
  const other = data?.books?.[`${basis === "futures" ? "index" : "futures"}-${k}`];
  const s = book.summary;
  const levels = (data?.levels || []).filter((l) => l.basis === basis);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Paper trading · Volatility breakout</h1>
            <InfoButton onClick={() => setShowInfo(true)} label="How this model works" />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-[#9b968c]">
            Swing, long only, the five F&amp;O indices. 09:15: sell positions whose open is above the buy price (or on
            their {data?.hold ?? 5}th day), and set each index's level = open + k × yesterday's range. Buy when the price
            reaches it (from the 15m candles, recorded after 15:16). One position per index, a fifth of capital each. The
            backtest page's index book; nothing places orders.
          </p>
        </div>
        <div className="flex items-center gap-2" title="Slippage per side, as a percent of price, on top of charges">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Slippage</span>
          <Segmented options={SLIPPAGE} value={slippage} onChange={setSlippage} />
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2" title="The breakout size: the level is the open + k × yesterday's high − low">
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Breakout</span>
          <Segmented options={KS} value={k} onChange={setK} />
        </div>
        <div
          className="flex items-center gap-2"
          title="Futures prices: the rules on the future's own open, range and candles (what you would trade by hand). Index prices: on the index, exactly as the backtest. Both are recorded for every day."
        >
          <span className="text-xs uppercase tracking-[0.14em] text-[#6f6a62]">Prices</span>
          <Segmented options={BASES} value={basis} onChange={setBasis} />
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-[#f0b4b4]">{error}</p>}
      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Closed trades" value={s.trades} />
            <Stat label="Open" value={`${s.open} / ${data.max_open}`} />
            <Stat label="Win rate" value={s.win_rate == null ? "—" : `${s.win_rate}%`} />
            <Stat label="Net / trade" value={fmtPct(s.avg_net_pct)} className={cls(s.avg_net_pct)} title="After charges and slippage on both sides" />
            <Stat label="Book net" value={fmtPct(s.book_net_pct)} className={cls(s.book_net_pct)} title={`Each index is 1/${data.max_open} of capital, so a trade adds 1/${data.max_open} of its net`} />
            <Stat
              label={`Book net (${basis === "futures" ? "index" : "futures"})`}
              value={fmtPct(other?.summary?.book_net_pct ?? 0)}
              className={cls(other?.summary?.book_net_pct)}
              title="The other version, for comparison"
            />
          </div>

          <Card title={`Levels · ${data.levels_day ?? "—"}`} right="buy stop = open + k × yesterday's range">
            <Table head={["Index", "Instrument", "Open", "Yesterday's range", "Level k = 1.0", "Level k = 0.5"]}>
              {levels.length === 0 && <Empty cols={6} text="No levels yet: the first run is the next trading day at 09:15:01 (Kite login needed)." />}
              {levels.map((l) => (
                <tr key={l.symbol}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{l.symbol}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{l.instrument}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(l.open)}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(l.range)}</td>
                  <td className={`px-2 py-1.5 ${k === "1" ? "text-[#e2c08a]" : "text-[#c8c3b8]"}`}>{px(l.level_1)}</td>
                  <td className={`px-2 py-1.5 ${k === "0.5" ? "text-[#e2c08a]" : "text-[#c8c3b8]"}`}>{px(l["level_0.5"])}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Open positions" right={`sold at the first 09:15 open above the buy price, or the ${data.hold}th day's open`}>
            <Table head={["Index", "Instrument", "Bought", "Time", "Level", "Buy", "Day"]}>
              {book.open.length === 0 && <Empty cols={7} text="No open positions." />}
              {book.open.map((t) => (
                <tr key={`${t.symbol}-${t.buy_day}`}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{t.symbol}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.instrument}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.buy_day}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.buy_time}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.level)}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.buy)}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">
                    {t.day_of_hold} / {data.hold}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Closed trades" right={`costs ${data.cost_per_side_bps} bps per side`}>
            <Table head={["Index", "Instrument", "Bought", "Time", "Buy", "Sold", "Sell", "Exit", "Gross", "Net"]} min={900}>
              {book.closed.length === 0 && <Empty cols={10} text="No closed trades yet." />}
              {book.closed.map((t) => (
                <tr key={`${t.symbol}-${t.buy_day}`}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{t.symbol}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.instrument}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.buy_day}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{t.buy_time}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.buy)}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{t.sell_day}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{px(t.sell)}</td>
                  <td className={`px-2 py-1.5 ${t.reason === "profitable open" ? "text-[#9b968c]" : "text-[#f0b4b4]"}`}>{t.reason}</td>
                  <td className={`px-2 py-1.5 ${cls(t.gross_pct)}`}>{fmtPct(t.gross_pct)}</td>
                  <td className={`px-2 py-1.5 ${cls(t.net_pct)}`}>{fmtPct(t.net_pct)}</td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Daily log" right="09:15:01 opens and levels · after 15:16 breakouts">
            <Table head={["Day", "Opens at", "Breakouts at", "Market", "Sold", "Bought", "Note"]}>
              {data.days.length === 0 && <Empty cols={7} text="Nothing recorded yet: the first run is the next trading day at 09:15:01 (Kite login needed)." />}
              {data.days.map((d) => (
                <tr key={d.day}>
                  <td className="px-2 py-1.5 text-[#e7e4dc]">{d.day}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{d.opened_at ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{d.finalized_at ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.market_open ? "open" : "closed"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.sold ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#c8c3b8]">{d.bought ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[#9b968c]">{d.note ?? ""}</td>
                </tr>
              ))}
            </Table>
          </Card>
          <p className="mb-4 font-mono text-[0.7rem] text-[#6f6a62]">
            Sold and Bought in the log count both versions and both breakout sizes. The future is the nearest one expiring at
            least 8 days out, so a 5-day hold never crosses expiry; near expiry that's next month's contract, which isn't in
            the 09:00–09:08 pre-open auction. Backtest: {data.backtest_variant} on the Volatility breakout page.
          </p>
        </>
      )}
      {showInfo && (
        <ModelInfoModal title="Volatility breakout" onClose={() => setShowInfo(false)}>
          <VboInfo />
        </ModelInfoModal>
      )}
    </div>
  );
}
