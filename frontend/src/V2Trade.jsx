import { useCallback, useEffect, useState } from "react";
import { formatRs, inputStyle } from "./V2Controls";
import { Card, Panel, tone } from "./V2BacktestView";
import { StyleTag } from "./V2SideNav";
import { StatusButtons } from "./modelStatus";

// v2 Live trading: models traded with REAL money on the Kite account. Orders go out only from a click
// here, after a confirm step (livetrade.py checks every order again). First model: turn of the month.

const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—");
const num = (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ORDER_COLOR = { COMPLETE: "var(--positive)", REJECTED: "var(--negative)", CANCELLED: "var(--faint)", OPEN: "var(--warning)" };

function marketOpen() {
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  const m = ist.getHours() * 60 + ist.getMinutes();
  return ist.getDay() > 0 && ist.getDay() < 6 && m >= 540 && m <= 930;
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p.detail || p.message || `Failed (${r.status})`);
  return p;
}

function Table({ head, rows, empty, minWidth = 640 }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows : (
            <tr>
              <td colSpan={head.length} className="px-2 py-3 text-sm" style={{ color: "var(--muted)" }}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const Btn = ({ children, onClick, disabled, kind = "plain", title }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
    style={
      kind === "buy"
        ? { borderColor: "var(--positive)", background: "var(--positive)", color: "white" }
        : kind === "sell"
          ? { borderColor: "var(--negative)", background: "var(--negative)", color: "white" }
          : { borderColor: "var(--border)", color: "var(--text)" }
    }
  >
    {children}
  </button>
);

// The confirm step: the exact order, in words, before it goes to Kite.
function Confirm({ order, onCancel, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await post("/api/v2/trade/tom/order", { side: order.side, tradingsymbol: order.symbol, lots: order.lots, price: order.price });
      onDone(`${r.side} order placed · Kite order ${r.order_id}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  const buy = order.side === "BUY";
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onCancel}>
      <div role="dialog" aria-modal="true" aria-label="Confirm the order" className="w-full max-w-md rounded-lg border p-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold" style={{ color: buy ? "var(--positive)" : "var(--negative)" }}>
          {buy ? "Buy" : "Sell"} with real money?
        </h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt style={{ color: "var(--muted)" }}>Contract</dt>
          <dd className="font-medium">{order.symbol}</dd>
          <dt style={{ color: "var(--muted)" }}>Quantity</dt>
          <dd>
            {order.lots} lot{order.lots > 1 ? "s" : ""} · {order.lots * order.lot} units
          </dd>
          <dt style={{ color: "var(--muted)" }}>Order</dt>
          <dd>LIMIT at ₹{num(order.price)} · NRML · day</dd>
          <dt style={{ color: "var(--muted)" }}>{buy ? "Pays about" : "Gets about"}</dt>
          <dd className="font-medium">{formatRs(order.price * order.lots * order.lot)}</dd>
        </dl>
        {order.warning && (
          <p className="mt-3 text-sm" style={{ color: "var(--warning)" }}>
            {order.warning}
          </p>
        )}
        {error && (
          <p className="mt-3 text-sm" style={{ color: "var(--negative)" }}>
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Btn onClick={onCancel} disabled={busy}>
            Cancel
          </Btn>
          <Btn kind={buy ? "buy" : "sell"} onClick={go} disabled={busy}>
            {busy ? "Placing…" : `Place ${buy ? "buy" : "sell"} order`}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// An "i" button that opens the model's rules in a small box (click again, or anywhere outside, to close).
function Info({ children }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="The rules"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex h-5 w-5 items-center justify-center rounded-full border text-xs font-semibold italic"
        style={{ borderColor: "var(--border)", color: open ? "var(--accent)" : "var(--muted)" }}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-7 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-lg border p-3 text-sm shadow-lg"
          style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--muted)" }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

// The stop loss on a held call: a Kite GTT that sells it all when it trades down to the trigger. Quick
// picks are % below the average buy price; the trigger can be typed. Two clicks: set, then confirm.
function StopControl({ p, onDone }) {
  const [trigger, setTrigger] = useState("");
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const at = (pct) => setTrigger(String(Math.round(p.average_price * (1 - pct / 100) * 20) / 20));
  const send = async (body, msg) => {
    setBusy(true);
    setError("");
    try {
      await post("/api/v2/trade/tom/stop", body);
      setAsk(false);
      setTrigger("");
      onDone(msg);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  const t = Math.round(Number(trigger) * 20) / 20;
  const loss = t ? (t - p.average_price) * p.quantity : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span style={{ color: "var(--muted)" }}>Stop loss:</span>
      {p.stop ? (
        <span className="font-medium" style={{ color: "var(--warning)" }}>
          sells {p.stop.quantity} if it trades at ₹{num(p.stop.trigger)} (limit ₹{num(p.stop.limit)}) · Kite GTT
        </span>
      ) : (
        <span style={{ color: "var(--faint)" }}>none</span>
      )}
      <span className="inline-flex gap-1">
        {[25, 35, 50].map((pct) => (
          <Btn key={pct} onClick={() => at(pct)} disabled={busy} title={`${pct}% below your average price`}>
            −{pct}%
          </Btn>
        ))}
      </span>
      <input type="number" step="0.05" placeholder="trigger ₹" value={trigger} onChange={(e) => { setTrigger(e.target.value); setAsk(false); }} className="w-28 rounded-md border px-2 py-1.5 text-sm" style={inputStyle} />
      {!ask ? (
        <Btn onClick={() => setAsk(true)} disabled={busy || !t}>
          {p.stop ? "Move stop" : "Set stop"}
        </Btn>
      ) : (
        <>
          <span style={{ color: "var(--warning)" }}>
            Sell all {p.quantity} if it trades at ₹{num(t)}? Loss about {formatRs(loss)}
          </span>
          <Btn kind="sell" onClick={() => send({ tradingsymbol: p.tradingsymbol, trigger: t }, `Stop set at ₹${num(t)}`)} disabled={busy}>
            Confirm
          </Btn>
          <Btn onClick={() => setAsk(false)} disabled={busy}>
            Cancel
          </Btn>
        </>
      )}
      {p.stop && !ask && (
        <Btn onClick={() => send({ tradingsymbol: p.tradingsymbol }, "Stop removed")} disabled={busy}>
          Remove stop
        </Btn>
      )}
      {error && <span style={{ color: "var(--negative)" }}>{error}</span>}
    </div>
  );
}

// What the held call is worth at the sell day's close if the future moves from here: the call's P&L
// against the buy, and a future's P&L on the same quantity for comparison.
function Scenarios({ s, quantity }) {
  const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${formatRs(Math.abs(v))}`;
  return (
    <div className="rounded-md border" style={{ borderColor: "var(--border)" }}>
      <p className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
        <span className="font-semibold" style={{ color: "var(--text)" }}>What if</span> · {s.strike} CE on the sell day ({day(s.sell)}) if the {s.future_symbol} (now {num(s.future)}) moves from here ·
        volatility {s.vol_pct}% as priced now · {quantity} units · estimates
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 620 }}>
          <thead>
            <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
              {["Future moves", "Future at", "Call on the sell day", "Call P&L", "Future P&L (same qty)"].map((h) => (
                <th key={h} className="px-3 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.move_pct} className="border-t" style={{ borderColor: "var(--border)", background: r.move_pct === 0 ? "var(--surface-2)" : undefined }}>
                <td className="px-3 py-1 tabular-nums">
                  {r.move_pct === 0 ? "flat" : `${r.points > 0 ? "+" : ""}${r.points.toLocaleString("en-IN")} (${r.move_pct > 0 ? "+" : ""}${r.move_pct}%)`}
                </td>
                <td className="px-3 py-1 tabular-nums">{num(r.future, 0)}</td>
                <td className="px-3 py-1 tabular-nums">₹{num(r.call, 0)}</td>
                <td className="px-3 py-1 tabular-nums font-medium" style={{ color: tone(r.pnl) }}>
                  {signed(r.pnl)}
                </td>
                <td className="px-3 py-1 tabular-nums" style={{ color: "var(--muted)" }}>
                  {signed(r.future_pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function V2Trade() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [pick, setPick] = useState(null); // the chosen call's symbol (defaults to the best)
  const [lots, setLots] = useState(1);
  const [price, setPrice] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);

  const load = useCallback(
    () =>
      fetch("/api/v2/trade/tom")
        .then((r) => r.json())
        .then((p) => {
          if (p.status !== "success") setError(p.message || p.detail || "Could not load");
          else {
            setError("");
            setD(p);
          }
        })
        .catch(() => setError("Could not reach the API")),
    [],
  );
  const [updated, setUpdated] = useState("");
  useEffect(() => {
    let t;
    const tick = () => {
      load().finally(() => setUpdated(new Date().toLocaleTimeString("en-IN", { hour12: false })));
      t = setTimeout(tick, marketOpen() ? 5000 : 60000); // re-checked each time: speeds up at 09:00 on its own
    };
    tick();
    return () => clearTimeout(t);
  }, [load, version]);

  const plan = d?.plan || {};
  const calls = plan.calls || [];
  const chosen = calls.find((c) => c.symbol === pick) || plan.best || null;
  useEffect(() => {
    if (chosen && price === "") setPrice(String(chosen.limit));
  }, [chosen, price]);

  const refresh = () => setVersion((v) => v + 1);
  const done = (msg) => {
    setConfirm(null);
    setNotice(msg);
    refresh();
  };
  const choose = (c) => {
    setPick(c.symbol);
    setPrice(String(c.limit));
  };
  const buyDay = plan.state?.startsWith("buy");
  const holding = (d?.positions || []).length > 0;

  const orderAction = async (o, what, newPrice) => {
    try {
      if (what === "cancel") await post(`/api/v2/trade/order/${o.order_id}/cancel`);
      else await post(`/api/v2/trade/order/${o.order_id}/modify`, { price: newPrice });
      setNotice(what === "cancel" ? `Order ${o.order_id} cancelled` : `Order ${o.order_id} moved to ₹${num(newPrice)}`);
      refresh();
    } catch (e) {
      setNotice(e.message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Manual trading · real money · Larry Williams · Long-Term Secrets to Short-Term Trading
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Turn of the month</h1>
          <Info>
            Buy a Nifty call 2–3.5% in the money (next month's expiry) at the close of the month's 5th-last trading day; sell it at the close of the next
            month's 3rd trading day. Orders are placed only when you click and confirm. The call stands in for the Nifty future the
            model is backtested and paper-traded on (Paper trading → Turn of the month).
          </Info>
          <StyleTag style="Positional" />
          <a
            href="/v2/paper/turn-of-month"
            onClick={(e) => {
              e.preventDefault();
              window.history.pushState(null, "", "/v2/paper/turn-of-month");
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
            className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--surface-2)]"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            title="The same cycle on paper, in the Nifty future: compare the call's result with it"
          >
            Paper book (future)
          </a>
          <span className="ml-auto">
            <StatusButtons id="turn-of-month" />
          </span>
        </div>
      </div>

      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {notice && (
        <p className="text-sm" style={{ color: "var(--accent)" }}>
          {notice}{" "}
          <button type="button" className="underline" onClick={() => setNotice("")}>
            ok
          </button>
        </p>
      )}
      {d && !d.kite && <p className="text-sm" style={{ color: "var(--warning)" }}>Kite isn't connected: log in to Kite to see prices and trade.</p>}

      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Card label="Now" value={plan.state === "waiting" ? `Waiting · ${plan.days_to_buy} days` : plan.state || "—"} color={plan.state && plan.state !== "waiting" ? "var(--warning)" : undefined} />
            <Card label="Buy (close)" value={day(plan.buy)} />
            <Card label="Sell (close)" value={day(plan.sell)} />
            <Card label="Nifty 50 spot" value={plan.nifty ? num(plan.nifty) : "—"} hint="The index. Options settle on it at expiry." />
            <Card label={plan.future_symbol ? `Future · ${plan.future_symbol}` : "Future"} value={plan.future ? `${num(plan.future)} (+${plan.basis_pct}%)` : "—"} hint="The same-expiry future, what the options follow before expiry: in the money and time value are measured from it." />
            <Card label="Contract expiry" value={day(plan.expiry)} hint="The calls' (and the future's) expiry: next month's, so none falls inside the 7-day hold." />
          </div>

          <Panel title={`Buy · calls for ${day(plan.expiry)}`} right={plan.quoted_at ? `prices at ${plan.quoted_at} · best = tightest spread` : "prices need Kite"}>
            <Table
              head={["", "Strike", "Bid", "Ask", "Mid", "Spread", "In the money", "Time value", "Open interest", "Per lot"]}
              empty={plan.calls ? "No calls 2–3.5% in the money right now." : holding ? "Holding: the buy list shows again after the sale." : "No prices (Kite not connected)."}
              minWidth={820}
              rows={calls.map((c) => {
                const on = chosen?.symbol === c.symbol;
                return (
                  <tr
                    key={c.symbol}
                    className="cursor-pointer border-t"
                    style={{
                      borderColor: "var(--border)",
                      background: on ? "var(--surface-2)" : undefined,
                      ...(plan.best?.symbol === c.symbol ? { outline: "2px solid var(--positive)", outlineOffset: "-2px" } : {}),
                    }}
                    onClick={() => choose(c)}
                  >
                    <td className="px-2 py-1.5">
                      <input type="radio" checked={on} onChange={() => choose(c)} aria-label={`Choose ${c.strike}`} />
                    </td>
                    <td className="px-2 py-1.5 font-medium">
                      {c.strike} CE{plan.best?.symbol === c.symbol ? <span style={{ color: "var(--positive)" }}> · best</span> : ""}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{num(c.bid)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(c.ask)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(c.mid)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{c.spread_pct == null ? "—" : `${c.spread_pct}%`}</td>
                    <td className="px-2 py-1.5 tabular-nums">{c.itm_pct}%</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(c.time_value)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{(c.oi ?? 0).toLocaleString("en-IN")}</td>
                    <td className="px-2 py-1.5 tabular-nums">{formatRs(c.per_lot)}</td>
                  </tr>
                );
              })}
            />
            {chosen && (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-xs" style={{ color: "var(--muted)" }}>
                  Lots (1–{d.max_lots})
                  <input type="number" min={1} max={d.max_lots} value={lots} onChange={(e) => setLots(Math.max(1, Math.min(d.max_lots, Number(e.target.value) || 1)))} className="mt-1 block w-20 rounded-md border px-2 py-1.5 text-sm" style={inputStyle} />
                </label>
                <label className="text-xs" style={{ color: "var(--muted)" }}>
                  Limit price (₹)
                  <input type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1 block w-32 rounded-md border px-2 py-1.5 text-sm" style={inputStyle} />
                </label>
                <Btn
                  kind="buy"
                  disabled={!d.kite || !Number(price) || !buyDay}
                  title={buyDay ? undefined : `Buying opens on the buy day, ${day(plan.buy)}`}
                  onClick={() =>
                    setConfirm({
                      side: "BUY",
                      symbol: chosen.symbol,
                      lot: chosen.lot,
                      lots,
                      price: Math.round(Number(price) * 20) / 20,
                      warning: buyDay ? null : `Today isn't the buy day (${day(plan.buy)}).${holding ? " You already hold a Nifty call." : ""}`,
                    })
                  }
                >
                  Buy {chosen.strike} CE · {lots} lot{lots > 1 ? "s" : ""}
                </Btn>
                <span className="pb-2 text-xs" style={{ color: "var(--muted)" }}>
                  ≈ {formatRs((Number(price) || 0) * lots * chosen.lot)} · mid ₹{num(chosen.mid)}
                </span>
              </div>
            )}
          </Panel>

          <Panel title="Position" right="the account's Nifty calls (NRML)">
            <Table
              head={["Contract", "Qty", "Avg", "Bid / Ask", "Last", "P&L", "Value", ""]}
              empty="No Nifty call held."
              rows={(d.positions || []).flatMap((p) => [
                <tr key={p.tradingsymbol} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="px-2 py-1.5 font-medium">{p.tradingsymbol}</td>
                  <td className="px-2 py-1.5 tabular-nums">{p.quantity}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(p.average_price)}</td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {num(p.bid)} / {num(p.ask)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{num(p.ltp)}</td>
                  <td className="px-2 py-1.5 tabular-nums font-medium" style={{ color: tone(p.pnl) }}>
                    {p.pnl == null ? "—" : `${p.pnl > 0 ? "+" : ""}${formatRs(p.pnl)}`}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{formatRs(p.value)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Btn
                      kind="sell"
                      disabled={!p.limit || p.quantity <= 0}
                      onClick={() =>
                        setConfirm({
                          side: "SELL",
                          symbol: p.tradingsymbol,
                          lot: p.lot || p.quantity,
                          lots: p.lot ? Math.round(p.quantity / p.lot) : 1,
                          price: p.limit,
                          warning: plan.state?.startsWith("sell") ? null : `Today isn't the sell day (${day(plan.sell)}).`,
                        })
                      }
                    >
                      Sell all at ₹{num(p.limit)}
                    </Btn>
                  </td>
                </tr>,
                <tr key={`${p.tradingsymbol}-stop`}>
                  <td colSpan={8} className="px-2 pb-3 pt-1">
                    <StopControl p={p} onDone={(msg) => { setNotice(msg); refresh(); }} />
                  </td>
                </tr>,
                ...(p.scenarios
                  ? [
                      <tr key={`${p.tradingsymbol}-what-if`}>
                        <td colSpan={8} className="px-2 pb-3">
                          <Scenarios s={p.scenarios} quantity={p.quantity} />
                        </td>
                      </tr>,
                    ]
                  : []),
              ])}
            />
          </Panel>

          <Panel title="Today's orders" right="from this page (tagged on Kite)">
            <Table
              head={["Time", "Side", "Contract", "Qty", "Filled", "Price", "Avg", "Status", ""]}
              empty="No orders today."
              minWidth={820}
              rows={(d.orders || []).map((o) => {
                const open = ["OPEN", "MODIFIED", "OPEN PENDING", "TRIGGER PENDING"].includes(o.status);
                const step = o.side === "BUY" ? 1 : -1;
                return (
                  <tr key={o.order_id} className="border-t" style={{ borderColor: "var(--border)" }} title={o.message || ""}>
                    <td className="px-2 py-1.5 tabular-nums">{o.time.slice(11, 19)}</td>
                    <td className="px-2 py-1.5" style={{ color: o.side === "BUY" ? "var(--positive)" : "var(--negative)" }}>{o.side}</td>
                    <td className="px-2 py-1.5 font-medium">{o.tradingsymbol}</td>
                    <td className="px-2 py-1.5 tabular-nums">{o.quantity}</td>
                    <td className="px-2 py-1.5 tabular-nums">{o.filled ?? 0}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(o.price)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{o.average_price ? num(o.average_price) : "—"}</td>
                    <td className="px-2 py-1.5 font-medium" style={{ color: ORDER_COLOR[o.status] || "var(--muted)" }}>{o.status}</td>
                    <td className="px-2 py-1.5 text-right">
                      {open && (
                        <span className="inline-flex gap-1.5">
                          <Btn onClick={() => orderAction(o, "modify", Math.round((o.price + step) * 20) / 20)} title={`Move the price ₹1 ${o.side === "BUY" ? "up" : "down"}`}>
                            {o.side === "BUY" ? "+₹1" : "−₹1"}
                          </Btn>
                          <Btn onClick={() => orderAction(o, "cancel")}>Cancel</Btn>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            />
          </Panel>

          <Panel title="Order log" right="every order sent from this page">
            <Table
              head={["When", "By", "Action", "Contract", "Qty", "Price", "Kite order / error"]}
              empty="Nothing sent yet."
              minWidth={760}
              rows={(d.log || []).map((l, i) => (
                <tr key={i} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="px-2 py-1.5 tabular-nums">{l.placed_at.replace("T", " ").slice(0, 19)}</td>
                  <td className="px-2 py-1.5">{l.by}</td>
                  <td className="px-2 py-1.5">{l.side}</td>
                  <td className="px-2 py-1.5">{l.tradingsymbol}</td>
                  <td className="px-2 py-1.5 tabular-nums">{l.quantity}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(l.price)}</td>
                  <td className="px-2 py-1.5" style={{ color: l.error ? "var(--negative)" : "var(--muted)" }}>{l.error || l.order_id}</td>
                </tr>
              ))}
            />
          </Panel>
        </>
      )}
      {confirm && <Confirm order={confirm} onCancel={() => setConfirm(null)} onDone={done} />}
    </div>
  );
}
