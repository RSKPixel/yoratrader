import { Lock, LockOpen, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Field, formatRs, Segmented } from "./V2Controls";
import { LiveMaxOpen } from "./V2BacktestParams";

// The Live trading page: live items (liveitems.py), each a model marked Live with its own name, settings
// (copied from the paper book when added), trading account and an Enable switch (real money). + adds one,
// disabled; clicking an item opens its settings. Everything is saved on the server.

const go = (href) => (e) => {
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

async function call(url, method = "GET", body) {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const p = await r.json().catch(() => ({}));
  if (!r.ok || p.status !== "success") throw new Error(p.detail || p.message || `Failed (${r.status})`);
  return p;
}

function useEsc(onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function Modal({ title, heading, sub, onClose, children, footer, wide = false }) {
  useEsc(onClose);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`flex w-full ${wide ? "h-[85vh] max-w-3xl" : "max-h-[90vh] max-w-lg"} flex-col overflow-hidden rounded-lg border`}
        style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0">
            {heading || <h2 className="text-base font-semibold">{title}</h2>}
            {sub && <p className="text-xs" style={{ color: "var(--muted)" }}>{sub}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1 text-sm" style={{ borderColor: "var(--border)" }}>Close</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>{footer}</div>}
      </div>
    </div>
  );
}

const input = "w-full rounded-md border px-2.5 py-1.5 text-sm";
const inputStyle = { borderColor: "var(--border)", background: "var(--surface-2)" };
const button = "rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50";

// + : pick a model marked Live, give it a name; the item is created disabled with the paper book's settings
function AddModal({ onClose, onAdded }) {
  const [models, setModels] = useState(null);
  const [model, setModel] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call("/api/v2/live/models")
      .then((p) => {
        setModels(p.models);
        if (p.models[0]) setModel(p.models[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const p = await call("/api/v2/live/items", "POST", { model, name });
      onAdded(p.item);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  const picked = models?.find((m) => m.id === model);
  return (
    <Modal title="Add a live trading item" sub="Models marked Live. A model can be added more than once, each item its own name and settings (like the two paper books). It starts disabled, with the paper book's settings." onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className={button} style={{ borderColor: "var(--border)" }}>Cancel</button>
        <button type="button" onClick={add} disabled={!model || busy} className={button} style={{ borderColor: "var(--accent)", background: "var(--accent)", color: "var(--surface)" }}>
          {busy ? "Adding…" : "Add"}
        </button>
      </>}>
      {!models ? (
        <p className="text-sm" style={{ color: error ? "var(--negative)" : "var(--faint)" }}>{error || "Loading…"}</p>
      ) : models.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>No model is marked Live. Mark one Live on its backtest or paper page first.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>Model</legend>
            {models.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: model === m.id ? "var(--accent)" : "var(--border)" }}>
                <input type="radio" name="model" value={m.id} checked={model === m.id} onChange={() => setModel(m.id)} />
                {m.label}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Name</span>
            <input className={input} style={inputStyle} value={name} maxLength={80} placeholder={picked?.label || "A name for this item"} onChange={(e) => setName(e.target.value)} />
          </label>
          {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function shown(f, v) {
  if (f.kind === "fixed") return f.rule;
  if (v == null) return "—";
  if (f.kind === "capital") return formatRs(v);
  if (f.kind === "stepper") return String(v);
  return (f.rule.find((c) => c[0] === v) || [, v])[1];
}

// whether a field applies with these settings (capital: spot only)
const applies = (f, settings) => !f.when || Object.entries(f.when).every(([k, v]) => settings[k] === v);

// The capital: a rupee box only (no quick picks), taken on Enter or leaving the box
function CapitalBox({ value, onChange }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => setText(String(value ?? "")), [value]);
  const commit = () => {
    const n = Math.round(Number(String(text).replace(/[^0-9.]/g, "")));
    if (n >= 10000) onChange(n);
    else setText(String(value ?? ""));
  };
  return (
    <div className="flex items-center rounded-md border" style={inputStyle}>
      <span className="pl-2.5 text-sm" style={{ color: "var(--faint)" }}>₹</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()}
        inputMode="numeric" aria-label="Capital in rupees" className="w-32 bg-transparent px-1.5 py-1.5 text-sm tabular-nums outline-none" />
    </div>
  );
}

// One setting, with the paper page's control: steppers, the capital box, the button groups, fixed values as a pill
function Param({ f, value, locked, onChange }) {
  let control;
  if (f.kind === "fixed") {
    control = (
      <span className="inline-block rounded-md border px-3 py-1.5 text-sm font-medium" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        {f.rule}
      </span>
    );
  } else if (f.kind === "stepper") {
    control = <LiveMaxOpen value={value ?? f.rule[0]} onChange={onChange} saving={locked} limit={f.rule[1]} />;
  } else if (f.kind === "capital") {
    control = <CapitalBox value={value ?? 500000} onChange={onChange} />;
  } else {
    control = <Segmented label={f.label} options={f.rule.map(([v, t]) => [v, t, locked])} value={value} onChange={onChange} />;
  }
  return (
    <Field label={f.label} hint={f.hint}>
      <div className="self-start">{control}</div>
    </Field>
  );
}

// The model's signals now, on the item's setup and instrument: every F&O stock above its 200-day average by its
// RSI, the signals first, and what the item would do with each (held, buy into a free slot, no slot). Every minute.
function ItemSignals({ item, settings }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const on = JSON.stringify(settings || item.settings); // the settings on screen (saved or not)
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () => call(`/api/v2/live/items/${item.id}/signals?settings=${encodeURIComponent(on)}`).then((p) => { if (alive) { setData(p); setError(""); } }).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [item.id, on]);
  if (item.orders !== "engine") return <p className="text-sm" style={{ color: "var(--muted)" }}>No signals for this model here yet.</p>;
  if (!data) return <p className="text-xs" style={{ color: error ? "var(--negative)" : "var(--faint)" }}>{error || "Working out the signals…"}</p>;
  if (data.tom) return <TomSignals data={data} error={error} />;
  if (data.gap) return <GapSignals data={data} error={error} />;
  const tone = { buy: "var(--positive)", held: "var(--accent)", "queued to sell": "var(--warning)", "signal, no slot": "var(--muted)" };
  const shown = all ? data.stocks : data.stocks.filter((x) => x.status !== "watch");
  const num = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {data.note || `${data.rule} · ${data.price === "futures" ? "futures" : "spot"} · ${data.signals} buy signals of ${data.above_average} stocks above their 200-day average · ${data.sells} sell signals · ${data.held} held of ${data.max_open}, ${data.free} free · prices at ${data.at}, the price now as today's close`}
      </p>
      {error && <p className="text-xs" style={{ color: "var(--negative)" }}>{error}</p>}
      <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show every stock above its 200-day average, not only buy signals and holdings
      </label>
      {shown.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--faint)" }}>No signal now.</p>
      ) : (
        <div className="overflow-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
          <table className="w-full whitespace-nowrap text-xs tabular-nums">
            <thead className="sticky top-0 text-left" style={{ background: "var(--surface-2)", color: "var(--faint)" }}>
              <tr>{["Script", "Price", "RSI(2)", "Cum RSI(2)", "Buy signal", "Held", "At 15:15"].map((c) => <th key={c} className="px-2 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.symbol} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="px-2 py-1.5 font-semibold" title={x.future || undefined}>{x.symbol}</td>
                  <td className="px-2 py-1.5">{x.price == null ? "—" : Number(x.price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                  <td className="px-2 py-1.5" style={{ color: data.setup === "rsi2" && x.signal ? "var(--positive)" : undefined }}>{num(x.rsi)}</td>
                  <td className="px-2 py-1.5" style={{ color: data.setup === "cumrsi2" && x.signal ? "var(--positive)" : undefined }}>{num(x.cum)}</td>
                  <td className="px-2 py-1.5">{x.signal ? "Yes" : "—"}</td>
                  <td className="px-2 py-1.5">{x.day ? `day ${x.day}` : "—"}</td>
                  <td className="px-2 py-1.5 font-medium" style={{ color: x.sell ? (x.sell.startsWith("stop") ? "var(--negative)" : "var(--warning)") : tone[x.status] || "var(--faint)" }}>
                    {x.sell || (x.status === "held" ? "hold" : x.status === "buy" ? "buy (free slot)" : x.status)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Turn of the month: this cycle's buy and sale days, what it holds, and what the buy day's run would buy now
// Buy/Sell on gap: before the open, today's zones (a future opening below "buy under" but above its 20-day average
// is bought; with long & short, one opening above "short over" but under the average is shorted); from 09:15 the
// futures that opened in a zone (the paper book's record of the open), the biggest gaps first, and what the item took.
function Table({ head, rows, empty, minWidth = 480 }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
            {head.map((h) => <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((r, i) => (
            <tr key={i} className="border-t" style={{ borderColor: "var(--border)" }}>
              {r.map((c, j) => <td key={j} className="whitespace-nowrap px-2 py-1.5 tabular-nums">{c}</td>)}
            </tr>
          )) : (
            <tr><td colSpan={head.length} className="px-2 py-3 text-sm" style={{ color: "var(--muted)" }}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function GapSignals({ data, error }) {
  const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const today = data.today || [];
  return (
    <div className="flex flex-col gap-3 text-sm">
      {error && <p className="text-xs" style={{ color: "var(--negative)" }}>{error}</p>}
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {data.stage === "zones"
          ? `Before the open (${data.at}): ${data.zones.length} futures with a zone today. At 09:15 the ones that open inside it are taken, the biggest gaps first, up to ${data.max_open}.`
          : `Today's open (${data.at}): ${data.candidates.length} future${data.candidates.length === 1 ? "" : "s"} opened in a zone · max ${data.max_open} · ${data.side === "both" ? "long & short" : "long only"}`}
      </p>
      {today.length > 0 && (
        <Table
          head={["Taken today", "Side", "Qty", "Entry", "Exit", "State"]}
          rows={today.map((p) => [p.tradingsymbol, p.side, p.qty, n(p.price), p.sell_price != null ? n(p.sell_price) : "—",
            p.buy_status === "pending" ? "order in" : p.sell_day ? `closed (${p.sell_reason})` : p.sell_status === "pending" ? "closing" : p.sell_status === "manual" ? "close by hand" : "open"])}
          minWidth={520}
        />
      )}
      {data.stage === "zones" ? (
        <Table
          head={["Stock", "Buy under", data.side === "both" ? "Short over" : null, "20-day avg", "Yesterday's close", "1σ"].filter(Boolean)}
          rows={data.zones.map((z) => [z.symbol, n(z.buy_below), data.side === "both" ? n(z.sell_above) : null, n(z.ma20), n(z.prev_close), `${n(z.sigma_pct)}%`].filter((x, i) => data.side === "both" || i !== 2))}
          empty="No zones today"
          minWidth={560}
        />
      ) : (
        <Table
          head={["Future", "Side", "Open", "Gap", "Status"]}
          rows={data.candidates.map((c) => [c.future, c.side, n(c.open), `${c.gap_pct > 0 ? "+" : ""}${n(c.gap_pct)}%`, c.status])}
          empty="No future opened in a zone today: nothing to trade"
          minWidth={480}
        />
      )}
    </div>
  );
}

function TomSignals({ data, error }) {
  const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "—");
  const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  const p = data.pick;
  const row = (k, v, color) => (
    <div className="flex justify-between gap-4 border-t py-1.5" style={{ borderColor: "var(--border)" }}>
      <dt style={{ color: "var(--muted)" }}>{k}</dt>
      <dd className="text-right font-medium tabular-nums" style={{ color }}>{v}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-3 text-sm">
      {error && <p className="text-xs" style={{ color: "var(--negative)" }}>{error}</p>}
      <dl>
        {row("Now", data.state, data.state.startsWith("buy") || data.state.startsWith("sell") ? "var(--positive)" : undefined)}
        {row("Buy", `${day(data.buy)} · 15:15${data.days_to_buy ? ` · in ${data.days_to_buy} trading day${data.days_to_buy > 1 ? "s" : ""}` : ""}`)}
        {row("Sell", `${day(data.sell)} · 15:15`)}
      </dl>
      {data.held.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Held</span>
          {data.held.map((h) => (
            <dl key={h.tradingsymbol} className="rounded-md border px-3" style={{ borderColor: "var(--border)" }}>
              {row("Contract", h.tradingsymbol)}
              {row("Quantity", `${h.qty} @ ${n(h.buy_price)} (${day(h.buy_day)})`)}
              {row("Now", n(h.last))}
              {h.last != null && row("P&L (gross)", `${h.last >= h.buy_price ? "+" : ""}${n((h.last - h.buy_price) * h.qty)}`, h.last >= h.buy_price ? "var(--positive)" : "var(--negative)")}
              {row("Sold", `${day(h.sell_plan)} · 15:15`)}
              {row("State", h.state, h.state === "held" ? undefined : "var(--warning)")}
            </dl>
          ))}
        </div>
      ) : p ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>On the buy day it buys (prices now, at {data.at}: the pick can change by 15:15)</span>
          <dl className="rounded-md border px-3" style={{ borderColor: "var(--border)" }}>
            {row("Contract", p.tradingsymbol)}
            {row("Instrument", p.instrument === "call" ? `ITM Nifty call · strike ${n(p.strike)}` : "Nifty future")}
            {row("Expiry", day(p.expiry))}
            {row("Quantity", p.qty)}
            {row("Bid / offer / last", `${n(p.bid)} / ${n(p.ask)} / ${n(p.last)}`)}
            {row(p.instrument === "call" ? "Cost (premium)" : "Value (exposure)", `₹${n(p.value)}`)}
            {row("Margin required", p.margin ? `₹${n(p.margin)}` : p.margin_error ? "couldn't get it" : "—", "var(--accent)")}
          </dl>
        </div>
      ) : (
        <p className="text-xs" style={{ color: "var(--negative)" }}>Couldn't work out the contract now: {data.pick_error}</p>
      )}
      <p className="text-xs" style={{ color: "var(--faint)" }}>Dates from NSE's holidays ({data.holidays}).</p>
    </div>
  );
}

// An item's dry-run book: what it holds (taken as filled) and every order the engine built, as the broker's API
// would get it (nothing is sent)
function ItemLog({ item }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => call(`/api/v2/live/items/${item.id}/log`).then((p) => alive && setData(p)).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [item.id]);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await call(`/api/v2/live/items/${item.id}/preview`, "POST"));
    } catch (e) {
      setPreview({ error: e.message });
    }
    setPreviewing(false);
  };
  if (item.orders !== "engine") return null;
  if (!data) return <p className="text-xs" style={{ color: error ? "var(--negative)" : "var(--faint)" }}>{error || "Loading the order log…"}</p>;
  const open = data.positions.filter((p) => !p.sell_day);
  const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>Holdings{item.real ? " (live: fills from the broker)" : " (dry run: orders taken as filled)"} · {open.length} open</div>
        {data.positions.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--faint)" }}>Nothing bought yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
            <table className="w-full whitespace-nowrap text-xs tabular-nums">
              <thead className="text-left" style={{ background: "var(--surface-2)", color: "var(--faint)" }}>
                <tr>{["Script", "Instrument", "Qty", "Bought", "At", "Stop", "Sold", "At", "Why"].map((c, i) => <th key={i} className="px-2 py-1.5 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {data.positions.map((p, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="px-2 py-1.5 font-semibold">{p.symbol}</td>
                    <td className="px-2 py-1.5" title={p.tradingsymbol}>{p.instrument === "futures" ? "Futures" : "Spot"}</td>
                    <td className="px-2 py-1.5">{p.qty}</td>
                    <td className="px-2 py-1.5">{p.buy_day}</td>
                    <td className="px-2 py-1.5">{num(p.buy_price)}</td>
                    <td className="px-2 py-1.5">{num(p.stop)}</td>
                    <td className="px-2 py-1.5">{p.sell_day || (p.sell_status === "pending" ? "sale order in" : p.sell_status === "manual" ? "sell by hand" : p.sell_queued ? `queued ${p.sell_queued}: next open` : p.buy_status === "pending" ? "buy order in" : "held")}</td>
                    <td className="px-2 py-1.5">{num(p.sell_price)}</td>
                    <td className="px-2 py-1.5" style={{ color: "var(--muted)" }}>{p.sell_reason || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Preview: what its 15:15 run would do on the prices now (nothing saved or sent)</span>
          <button type="button" onClick={runPreview} disabled={previewing} className={button} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
            {previewing ? "Working it out…" : "Preview orders now"}
          </button>
        </div>
        {preview?.error && <p className="text-xs" style={{ color: "var(--negative)" }}>{preview.error}</p>}
        {preview?.lines && (
          preview.lines.length === 0 ? <p className="text-xs" style={{ color: "var(--faint)" }}>Nothing it would do at {preview.at}.</p> : (
            <div className="flex flex-col rounded-md border" style={{ borderColor: "var(--accent)" }}>
              {preview.lines.map((r, i) => <LogLine key={i} r={{ ...r, at: preview.at }} />)}
            </div>
          )
        )}
      </div>
      <div>
        <div className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>Order log · {item.real ? "live orders: SENT lines went to the broker (order id in the JSON line)" : "nothing sent: each order as the broker's API would get it"}{data.log.length ? " (click a line for its JSON)" : ""}</div>
        {data.log.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--faint)" }}>Nothing logged yet: the engine runs at 15:15 on trading days while the item is enabled, and at the pre-open for sales queued to the next open.</p>
        ) : (
          <div className="flex max-h-72 flex-col overflow-auto rounded-md border" style={{ borderColor: "var(--border)" }}>
            {data.log.map((r) => <LogLine key={r.id} r={r} />)}
          </div>
        )}
      </div>
    </div>
  );
}

const EVENT_TONE = { buy: "var(--positive)", sell: "var(--negative)", "sell queued": "var(--warning)", "stop hit": "var(--negative)", error: "var(--negative)" };

// One log line; click for the request JSON
function LogLine({ r }) {
  return (
              <details className="border-b px-2 py-1.5 text-xs last:border-b-0" style={{ borderColor: "var(--border)" }}>
                <summary className="cursor-pointer tabular-nums">
                  <span style={{ color: "var(--faint)" }}>{r.at}</span>{" "}
                  <span className="font-semibold uppercase" style={{ color: EVENT_TONE[r.event] }}>{r.event}</span>{" "}
                  {r.symbol && <span className="font-semibold">{r.symbol}</span>}{" "}
                  <span style={{ color: "var(--muted)" }}>{[r.reason, r.order_id ? `order ${r.order_id}` : null, r.payload?.api, r.payload?.price != null ? `@ ${r.payload.price}` : null, r.payload?.quantity != null ? `× ${r.payload.quantity}` : null, r.note].filter(Boolean).join(" · ")}</span>{" "}
                  <span className="rounded px-1 text-[0.625rem] uppercase" style={{ background: "var(--surface-2)", color: "var(--faint)" }}>{r.status}</span>
                </summary>
                {r.payload ? <pre className="mt-1 overflow-x-auto rounded p-2 text-[0.6875rem]" style={{ background: "var(--surface-2)" }}>{JSON.stringify(r.payload, null, 2)}</pre>
                  : <p className="mt-1" style={{ color: "var(--faint)" }}>No order: a note only.</p>}
              </details>
  );
}

// An item: its name, account and settings (editable while disabled), and Enable / Disable
// An item at a glance (one view, no scrolling): its state, account, results, funds, today's orders, holdings, last log line. Every minute.
function ItemSummary({ item, fields, acctLabel }) {
  const [sum, setSum] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => call("/api/v2/live/summary")
      .then((a) => { if (alive) { setSum(a.items.find((x) => x.id === item.id) || null); setError(""); } })
      .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [item.id, item.orders]);
  if (!sum) return <p className="text-xs" style={{ color: error ? "var(--negative)" : "var(--faint)" }}>{error || "Loading…"}</p>;
  const n = (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }));
  const rs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);
  const color = (v) => (v > 0 ? "var(--positive)" : v < 0 ? "var(--negative)" : undefined);
  const tile = (k, v, c) => (
    <div key={k} className="rounded-md border px-3 py-2" style={{ borderColor: "var(--border)" }}>
      <div className="text-[0.6875rem]" style={{ color: "var(--muted)" }}>{k}</div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums" style={{ color: c }}>{v}</div>
    </div>
  );
  const badge = (t, c) => <span className="rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em]" style={{ background: "var(--surface-2)", color: c }}>{t}</span>;
  const bad = sum.last?.status === "rejected" || sum.last?.event === "error";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {badge(item.enabled ? "Enabled" : "Disabled", item.enabled ? "var(--positive)" : "var(--faint)")}
        {item.orders === "engine" && badge(item.real ? "Live orders" : "Dry run", item.real ? "var(--negative)" : "var(--accent)")}
        {badge(item.locked ? "Locked" : "Unlocked", item.locked ? "var(--warning)" : "var(--faint)")}
        <span className="ml-auto truncate text-xs" style={{ color: "var(--muted)" }}>{acctLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tile("Realized", rs(sum.realized_rs), color(sum.realized_rs))}
        {tile("Unrealized", rs(sum.unrealized_rs), color(sum.unrealized_rs))}
        {tile("Sold today", rs(sum.sold_today_rs), color(sum.sold_today_rs))}
        {tile("Holding", `${sum.open.length}${item.settings.max_open != null ? ` / ${item.settings.max_open}` : ""} · ${formatRs(sum.invested_rs)}`)}
        {(() => { const x = fundsOf(item.settings, sum.funds, sum.need_rs); return tile(x.label, x.error ? "—" : formatRs(x.value ?? 0), x.short ? "var(--negative)" : undefined); })()}
        {tile("Today's orders", `${item.real ? `${sum.today.sent} sent` : `${sum.today.dry} logged`}${sum.today.problems ? ` · ${sum.today.problems} ✕` : ""}`, sum.today.problems ? "var(--negative)" : undefined)}
      </div>
      {sum.open.length > 0 && (
        <table className="w-full whitespace-nowrap text-xs tabular-nums">
          <thead className="text-left" style={{ color: "var(--faint)" }}>
            <tr>{["Holding", "Qty", "Buy", "Now", "P&L", "State"].map((c) => <th key={c} className="py-1 pr-2 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody>
            {sum.open.map((p) => (
              <tr key={`${p.symbol}-${p.buy_day}`} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="py-1 pr-2 font-semibold">{p.symbol}</td>
                <td className="py-1 pr-2">{p.qty}</td>
                <td className="py-1 pr-2">{n(p.buy_price)}</td>
                <td className="py-1 pr-2">{n(p.last)}</td>
                <td className="py-1 pr-2 font-medium" style={{ color: color(p.pnl_rs) }}>{rs(p.pnl_rs)}</td>
                <td className="py-1" style={{ color: p.state === "held" ? "var(--muted)" : "var(--warning)" }}>{p.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sum.last && (
        <p className="truncate text-xs" style={{ color: bad ? "var(--negative)" : "var(--muted)" }} title={sum.last.note || undefined}>
          Last: {sum.last.at} · {sum.last.event}{sum.last.symbol ? ` ${sum.last.symbol}` : ""}{sum.last.note ? ` · ${sum.last.note}` : ""}
        </p>
      )}
    </div>
  );
}

// Every item card's rows, the same ones in the same order whatever the model (cards read side by side)
// a lot and what it needs: "1 lot (₹1,89,701 margin)" / "(₹58,422 premium)"
export function lotsText(s, need) {
  const lots = s.lots ?? 1;
  const what = s.instrument === "future" ? "margin" : "premium";
  return `${lots} lot${lots > 1 ? "s" : ""}${need ? ` (${formatRs(need)} ${what})` : ""}`;
}

function cardRows(it, fields, need) {
  const s = it.settings || {};
  const f = (k) => fields.find((x) => x.key === k);
  const val = (k) => (f(k) ? shown(f(k), s[k]) : null);
  const tom = it.model === "turn-of-month";
  if (it.model === "buy-on-gap") {
    const lots = s.lots ?? 1;
    return [
      ["Instrument", "Futures (near month)"],
      ["Setup", s.side === "both" ? "Buy/Sell on gap · long & short" : "Buy on gap · long"],
      ["Size", `${lots} lot${lots > 1 ? "s" : ""} each · max ${s.max_open ?? "—"} open`],
      ["Entry", "09:15 · open ±0.2%, never chased"],
      ["Exit", `15:15 same day${s.disaster === "on" ? " · 10% stop" : ""}`],
      ["Orders", val("orders") ?? "Dry run"],
    ];
  }
  return [
    ["Instrument", tom ? val("instrument") : val("price") ?? "—"],
    ["Setup", tom ? "Turn of the month" : val("setup") ?? "—"],
    ["Size", tom ? lotsText(s, need) : s.price === "futures" ? `1 lot each · max ${s.max_open ?? "—"} open` : `${val("capital") ?? "—"} · max ${s.max_open ?? "—"} open`],
    ["Entry", tom ? "15:15 · 5th-last trading day" : "15:15 · signal day"],
    ["Exit", tom ? "15:15 · 3rd trading day" : `${val("exit") ?? "—"} · ${val("trade_at") ?? "—"}`],
    ["Orders", val("orders") ?? (it.orders === "engine" ? "Dry run" : "By hand")],
  ];
}

// The funds that matter for an item: futures use margin (what's available for new orders, pledged holdings
// counted); spot shares and options are paid for in cash. need: the item's capital (spot), red when under it.
export function fundsOf(settings = {}, f, needRs = null) {
  // futures: margin (Buy/Sell on gap's items are futures only: its settings have a side and lots)
  const fut = settings.price === "futures" || settings.instrument === "future" || (settings.side != null && settings.lots != null);
  const v = f && !f.error ? (fut ? f.available : f.cash) : null;
  const need = needRs ?? (settings.price === "spot" ? settings.capital : null);
  return { label: fut ? "Margin available" : "Cash available", value: v, short: v != null && need != null && v < need, error: !f || f.error };
}

export function FundsRow({ f, settings, need }) {
  const x = fundsOf(settings, f, need);
  return (
    <div className="flex justify-between gap-3" title={x.label.startsWith("Margin") ? "Futures: the account's margin available for new orders (pledged holdings counted)" : "Spot shares and options are paid in cash: the cash in the account"}>
      <dt style={{ color: "var(--muted)" }}>{x.label}</dt>
      <dd className="truncate text-right tabular-nums" style={{ color: x.error ? "var(--faint)" : x.short ? "var(--negative)" : undefined }}>
        {x.error ? (f?.error && f.error !== "—" ? `— (${f.error})` : "—") : formatRs(x.value ?? 0)}
      </dd>
    </div>
  );
}

// a padlock: closed (locked) or open (unlocked)
function LockIcon({ open }) {
  return (
    open ? <LockOpen size={16} strokeWidth={2} aria-hidden="true" className="block" /> : <Lock size={16} strokeWidth={2} aria-hidden="true" className="block" />
  );
}

function ItemModal({ item, fields, accounts, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(null); // null: the name shown; a string: being renamed (the header)
  const [account, setAccount] = useState(item.account);
  const [settings, setSettings] = useState(item.settings);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [askLive, setAskLive] = useState(false); // Orders switched to Live orders: asked in a window first
  const [tab, setTab] = useState("summary");
  const [code, setCode] = useState(null); // null: no code box; a string: unlocking
  const locked = item.enabled;
  const shut = item.locked; // the lock: no changes until unlocked with the authenticator code
  const dirty = account !== item.account || JSON.stringify(settings) !== JSON.stringify(item.settings);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  const save = () => run(async () => onSaved((await call(`/api/v2/live/items/${item.id}`, "PUT", locked ? { settings } : { account, settings })).item));
  const toggle = (on) => run(async () => {
    if (dirty && !locked) await call(`/api/v2/live/items/${item.id}`, "PUT", { account, settings });
    onSaved((await call(`/api/v2/live/items/${item.id}/enabled`, "POST", { enabled: on })).item);
    setConfirm(false);
  });
  const remove = () => run(async () => {
    await call(`/api/v2/live/items/${item.id}`, "DELETE");
    onDeleted(item.id);
  });
  const lock = () => run(async () => onSaved((await call(`/api/v2/live/items/${item.id}/locked`, "POST", { locked: true })).item));
  const unlock = () => run(async () => {
    onSaved((await call(`/api/v2/live/items/${item.id}/locked`, "POST", { locked: false, code })).item);
    setCode(null);
  });
  const rename = () => {
    const n = (name || "").trim();
    if (!n || n === item.name) return setName(null);
    run(async () => {
      onSaved((await call(`/api/v2/live/items/${item.id}`, "PUT", { name: n })).item);
      setName(null);
    });
  };
  const heading = name == null ? (
    <div className="flex min-w-0 items-center gap-1.5">
      <h2 className="truncate text-base font-semibold">{item.name}</h2>
      {!shut && (
        <button type="button" onClick={() => setName(item.name)} className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--surface-2)]" style={{ color: "var(--muted)" }}
          aria-label="Rename" title="Rename">
          <Pencil size={14} strokeWidth={2} aria-hidden="true" className="block" />
        </button>
      )}
    </div>
  ) : (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); rename(); }}>
      <input className={`${input} py-1 text-base font-semibold`} style={inputStyle} value={name} maxLength={80} autoFocus aria-label="Name"
        onChange={(e) => setName(e.target.value)} onBlur={rename}
        onKeyDown={(e) => { if (e.key === "Escape") { e.nativeEvent.stopPropagation(); e.preventDefault(); setName(null); } }} />
    </form>
  );
  const acct = accounts.find((a) => a.id === account);
  return (
    <Modal wide title={item.name} heading={heading} sub={`${item.model_label} · ${item.enabled ? "enabled: real money" : "disabled"}`} onClose={confirm || askLive ? () => {} : onClose}
      footer={<>
        <div className="mr-auto flex flex-wrap items-center gap-2">
          {shut ? (
            code == null ? (
              <button type="button" onClick={() => setCode("")} disabled={busy} className={button} style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
                title="Locked: click to unlock with your authenticator code" aria-label="Unlock"><LockIcon open={false} /></button>
            ) : (
              <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); unlock(); }}>
                <input className={`${input} w-28 text-center tracking-[0.2em]`} style={inputStyle} value={code} autoFocus inputMode="numeric" autoComplete="one-time-code"
                  maxLength={6} placeholder="000000" aria-label="Authenticator code" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <button type="submit" disabled={busy || code.length !== 6} className={button} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>Unlock</button>
                <button type="button" onClick={() => setCode(null)} className={button} style={{ borderColor: "var(--border)" }}>Cancel</button>
              </form>
            )
          ) : (
            <button type="button" onClick={lock} disabled={busy || dirty} className={button} style={{ borderColor: "var(--border)" }}
              title={dirty ? "Save or undo the changes first" : "Unlocked: click to lock the settings (unlocking needs your authenticator code)"} aria-label="Lock"><LockIcon open /></button>
          )}
          {!item.enabled && <button type="button" onClick={remove} disabled={busy || shut} className={button} style={{ borderColor: "var(--border)", color: "var(--negative)" }}>Delete</button>}
        </div>
        <button type="button" onClick={save} disabled={busy || !dirty || shut} className={button} style={{ borderColor: "var(--border)" }}>Save</button>
        {item.enabled ? (
          <button type="button" onClick={() => toggle(false)} disabled={busy} className={button} style={{ borderColor: "var(--negative)", color: "var(--negative)" }}>Disable</button>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} disabled={busy || !acct?.connected || shut} className={button}
            style={{ borderColor: "var(--positive)", background: "var(--positive)", color: "var(--surface)" }} title={acct?.connected ? "Trade this item with real money" : "Its account isn't connected"}>
            Enable
          </button>
        )}
      </>}>
      <div className="flex flex-col gap-4">
        <div className="sticky -top-4 z-10 -mx-4 -mt-4 flex gap-1 border-b px-4 pt-3" role="tablist" aria-label="Item sections" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          {[["summary", "Summary"], ["settings", "Settings"], ["signals", "Signals"], ["log", "Log"]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className="-mb-px border-b-2 px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: tab === id ? "var(--accent)" : "transparent", color: tab === id ? "var(--text)" : "var(--muted)" }}>
              {label}
            </button>
          ))}
        </div>
        {tab === "summary" ? (
          <ItemSummary item={item} fields={fields[item.model] || []} acctLabel={acct?.label || item.account} />
        ) : tab === "signals" ? (
          <ItemSignals item={item} settings={settings} />
        ) : tab === "log" ? (
          item.orders === "engine" ? <ItemLog item={item} /> : <p className="text-sm" style={{ color: "var(--muted)" }}>No order log: {item.orders_note}.</p>
        ) : (<>
        <fieldset disabled={shut} className={`flex flex-col gap-4 ${shut ? "opacity-60" : ""}`}>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Trading account{locked ? " · disable the item to change it" : ""}</span>
          <select className={input} style={inputStyle} value={account || ""} disabled={locked} onChange={(e) => setAccount(e.target.value)}>
            {!accounts.some((a) => a.id === account) && <option value={account || ""}>{account || "—"} (not in Settings now)</option>}
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Model settings · its own: the paper book isn't changed{locked ? " · enabled: a change applies from its next run (positions held keep their quantities)" : ""}</span>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
            {(fields[item.model] || []).filter((f) => applies(f, settings)).map((f) => (
              <Param key={f.key} f={f} value={settings[f.key]} locked={false}
                onChange={(v) => (f.key === "orders" && v === "real" && settings.orders !== "real" ? setAskLive(true) : setSettings({ ...settings, [f.key]: v }))} />
            ))}
          </div>
        </div>
        <p className="rounded-md px-3 py-2 text-xs" style={{ background: "var(--surface-2)", color: item.orders === "none" ? "var(--warning)" : "var(--muted)" }}>
          Orders: {item.orders_note}
          {item.page && <> · <a href={item.page} onClick={go(item.page)} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>Open its trading page →</a></>}
        </p>
        </fieldset>
        </>)}
        {askLive && (
          <Modal title="Switch to Live orders?" sub={item.name} onClose={() => setAskLive(false)}
            footer={<>
              <button type="button" onClick={() => setAskLive(false)} className={button} style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button type="button" onClick={() => { setSettings({ ...settings, orders: "real" }); setAskLive(false); }} className={button}
                style={{ borderColor: "var(--negative)", background: "var(--negative)", color: "var(--surface)" }}>
                Yes, live orders
              </button>
            </>}>
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-semibold" style={{ color: "var(--negative)" }}>Real money.</p>
              <p>When this item is enabled, its orders are sent to {acct?.label || "its account"} at its times, and fills are checked with the broker every minute.</p>
              <p style={{ color: "var(--muted)" }}>The change applies after you press Save.</p>
            </div>
          </Modal>
        )}
        {confirm && (
          <Modal title={`Enable ${item.name}?`} sub={item.model_label} onClose={() => { setConfirm(false); setError(""); }}
            footer={<>
              <button type="button" onClick={() => { setConfirm(false); setError(""); }} className={button} style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button type="button" onClick={() => toggle(true)} disabled={busy} className={button} style={{ borderColor: "var(--positive)", background: "var(--positive)", color: "var(--surface)" }}>
                Yes, enable
              </button>
            </>}>
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-semibold" style={{ color: settings.orders === "real" ? "var(--negative)" : "var(--text)" }}>
                {item.orders !== "engine" ? "Real money: traded by hand." : settings.orders === "real" ? "Real money: its orders will be sent to the account at its times." : "Dry run: its orders are built and logged, nothing is sent."}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
                <dt style={{ color: "var(--muted)" }}>Account</dt><dd>{acct?.label || account}</dd>
                {settings.capital != null && <><dt style={{ color: "var(--muted)" }}>Capital</dt><dd>{formatRs(settings.capital)}</dd></>}
                {settings.max_open != null && <><dt style={{ color: "var(--muted)" }}>Max open</dt><dd>{settings.max_open}</dd></>}
                {item.orders === "engine" && <><dt style={{ color: "var(--muted)" }}>Orders</dt><dd>{settings.orders === "real" ? "Live orders" : "Dry run"}</dd></>}
              </dl>
              {error && <p style={{ color: "var(--negative)" }}>{error}</p>}
            </div>
          </Modal>
        )}
        {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      </div>
    </Modal>
  );
}

export default function V2TradeLanding() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => call("/api/v2/live/items").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const put = (item) => setData((d) => ({ ...d, items: d.items.some((x) => x.id === item.id) ? d.items.map((x) => (x.id === item.id ? item : x)) : [...d.items, item] }));
  const items = data?.items || [];
  const current = items.find((x) => x.id === open);
  const on = items.filter((x) => x.enabled).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>Live trading</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Real money</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Each item: a model marked Live, its own settings and account. New items start disabled.
            {data && ` · ${items.length} items · ${on} enabled`}
          </p>
        </div>
        <button type="button" onClick={() => setAdding(true)} aria-label="Add a live trading item" title="Add a model"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border text-xl leading-none transition-colors hover:bg-[var(--surface-2)]"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
          +
        </button>
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!data ? (
        !error && <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>
      ) : items.length === 0 ? (
        <button type="button" onClick={() => setAdding(true)} className="rounded-lg border border-dashed p-8 text-sm" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          No live trading items yet. Press + to add a model.
        </button>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((it) => {
            const fields = data.fields[it.model] || [];
            const acct = data.accounts.find((a) => a.id === it.account);
            return (
              <button key={it.id} type="button" onClick={() => setOpen(it.id)}
                className="flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: it.enabled ? "var(--positive)" : "var(--border)", background: "var(--surface)" }}>
                <div className="flex w-full items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{it.name}</h3>
                    <p className="truncate text-xs" style={{ color: "var(--muted)" }}>{it.model_label}</p>
                  </div>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em]"
                    style={{ background: "var(--surface-2)", color: it.enabled ? "var(--positive)" : "var(--faint)" }}>
                    {it.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <dl className="flex w-full flex-col gap-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt style={{ color: "var(--muted)" }}>Account</dt>
                    <dd className="truncate text-right">{acct?.label || it.account || "—"}</dd>
                  </div>
                  <FundsRow f={data.funds?.[it.account]} settings={it.settings} need={data.needs?.[it.id]} />
                  {cardRows(it, fields, data.needs?.[it.id]).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt style={{ color: "var(--muted)" }}>{k}</dt>
                      <dd className="truncate text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
                {it.orders === "none" && <p className="mt-auto text-[0.6875rem]" style={{ color: "var(--warning)" }}>Order engine not built yet: nothing is sent</p>}
                {it.orders === "engine" && (it.real
                  ? <p className="mt-auto text-[0.6875rem] font-semibold" style={{ color: "var(--negative)" }}>LIVE ORDERS{it.enabled ? ": sent to the account at its times" : " (when enabled)"}</p>
                  : <p className="mt-auto text-[0.6875rem]" style={{ color: "var(--accent)" }}>Order engine: dry run (orders logged, nothing sent)</p>)}
              </button>
            );
          })}
        </div>
      )}
      {adding && <AddModal onClose={() => setAdding(false)} onAdded={(item) => { put(item); setAdding(false); setOpen(item.id); }} />}
      {current && (
        <ItemModal key={`${current.id}-${current.enabled}`} item={current} fields={data.fields} accounts={data.accounts} onClose={() => setOpen(null)}
          onSaved={put} onDeleted={(id) => { setData((d) => ({ ...d, items: d.items.filter((x) => x.id !== id) })); setOpen(null); }} />
      )}
    </div>
  );
}

// One item's modal on its own (the dashboard's live cards): loads the items, opens this one; onChange after a save / delete
export function LiveItemModal({ id, onClose, onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    call("/api/v2/live/items").then(setData).catch((e) => setError(e.message));
  }, []);
  const item = data?.items.find((x) => x.id === id);
  if (error) return <Modal title="Live trading" onClose={onClose}><p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p></Modal>;
  if (!data) return null;
  if (!item) return <Modal title="Live trading" onClose={onClose}><p className="text-sm" style={{ color: "var(--muted)" }}>This item no longer exists.</p></Modal>;
  const put = (it) => {
    setData((d) => ({ ...d, items: d.items.map((x) => (x.id === it.id ? it : x)) }));
    onChange?.();
  };
  return (
    <ItemModal key={`${item.id}-${item.enabled}`} item={item} fields={data.fields} accounts={data.accounts} onClose={onClose}
      onSaved={put} onDeleted={() => { onChange?.(); onClose(); }} />
  );
}
