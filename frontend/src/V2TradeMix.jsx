import { useCallback, useEffect, useState } from "react";
import { Card, Panel, tone } from "./V2BacktestView";
import { formatRs } from "./V2Controls";

// Books + gold, traded by hand (livetrade.mix_state): what the mix should hold now (gold 30%, low
// volatility and RSI(2) 35% each, in cash) against what the Kite account holds, and what to buy or sell.
// Read-only: nothing here places orders.

const go = (href) => (e) => {
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

function Rows({ rows, empty }) {
  if (!rows.length) return <p className="text-sm" style={{ color: "var(--muted)" }}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: 720 }}>
        <thead>
          <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
            {["Stock", "Price", "Should hold", "You hold", "To do", "Note"].map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const a = r.action_qty;
            return (
              <tr key={r.symbol} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="px-2 py-1.5 font-medium">{r.symbol}</td>
                <td className="px-2 py-1.5 tabular-nums">{r.price ?? "—"}</td>
                <td className="px-2 py-1.5 tabular-nums">{r.target_qty ?? "—"}</td>
                <td className="px-2 py-1.5 tabular-nums">{r.held_qty}</td>
                <td className="px-2 py-1.5 tabular-nums font-semibold" style={{ color: a > 0 ? "var(--positive)" : a < 0 ? "var(--negative)" : "var(--muted)" }}>
                  {a == null ? "—" : a > 0 ? `Buy ${a}` : a < 0 ? `Sell ${-a}` : "OK"}
                </td>
                <td className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}>
                  {r.note}
                  {r.ret_pct != null && <span style={{ color: tone(r.ret_pct) }}> · model {r.ret_pct > 0 ? "+" : ""}{r.ret_pct}%</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function V2TradeMix() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const load = useCallback(() => {
    fetch("/api/v2/trade/mix")
      .then((r) => r.json())
      .then((p) => {
        if (p.status !== "success") setError(p.message || p.detail || "Could not load");
        else {
          setError("");
          setD(p);
          setText(String(Math.round(p.capital)));
        }
      })
      .catch(() => setError("Could not reach the API"));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);
  const saveCapital = async () => {
    const n = Math.round(Number(String(text).replace(/[^0-9.]/g, "")));
    if (!d || !n || n === Math.round(d.capital)) return;
    const r = await fetch("/api/v2/trade/mix/capital", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capital: n }) });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) setError(p.detail || "Could not save");
    else load();
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          <a href="/v2/trade" onClick={go("/v2/trade")} className="hover:underline">
            Live trading
          </a>{" "}
          · Manual
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Books + gold</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          What the mix should hold now against your Kite holdings, all in cash. Nothing here places orders: buy and sell by hand in Kite.
          {d?.mode === "off" && <span style={{ color: "var(--warning)" }}> · This model is Off on the Live trading page.</span>}
        </p>
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!d ? (
        !error && <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
                Capital (₹)
              </span>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={saveCapital}
                onKeyDown={(e) => e.key === "Enter" && saveCapital()}
                className="w-40 rounded-md border px-2.5 py-1.5 text-sm tabular-nums"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" }}
              />
            </label>
            {d.holdings_error && <span className="pb-1.5 text-xs" style={{ color: "var(--warning)" }}>{d.holdings_error}</span>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card label="Capital" value={formatRs(d.capital)} hint="Saved on the server" />
            <Card label={`Gold ${d.gold_pct}%`} value={formatRs(d.gold_rs)} hint="GOLDBEES, held; rebalanced to 30% at each month-end" />
            <Card label="Low volatility 35%" value={formatRs(d.book_rs)} hint={`Up to ${d.lv_open} stocks, ${formatRs(d.book_rs / d.lv_open)} each`} />
            <Card label="RSI(2) 35%" value={formatRs(d.book_rs)} hint={`Up to ${d.rsi_open} stocks, ${formatRs(d.book_rs / d.rsi_open)} each`} />
          </div>
          <Panel title="Gold" right="hold 30% of capital; check at each month-end">
            <Rows rows={[d.gold]} empty="—" />
          </Panel>
          <Panel title={`Low volatility · ${d.lv.length} of ${d.lv_open}`} right={`the model's holdings at the ${d.lv_as_of} close · sold at a close 20% under its best close`}>
            <Rows rows={d.lv} empty="The model holds nothing now." />
          </Panel>
          <Panel title={`RSI(2) · ${d.rsi2.length} of ${d.rsi_open}`} right={`the SR paper book's open positions · sold ${d.rsi2_exit}`}>
            <Rows rows={d.rsi2} empty="Nothing open." />
          </Panel>
          <Panel title="RSI(2): today's buys at 15:15" right={d.rsi2_note || "live candidates for the free slots; final at 15:15"}>
            <Rows rows={d.rsi2_buys} empty="No signal for a free slot right now." />
          </Panel>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Should hold = the book's share ÷ its max open ÷ the price now, whole shares. You hold = your Kite demat holdings (with T1). Refreshed every minute.
          </p>
        </>
      )}
    </div>
  );
}
