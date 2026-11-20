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

function Modal({ title, sub, onClose, children, footer, wide = false }) {
  useEsc(onClose);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`flex w-full ${wide ? "h-[85vh] max-w-3xl" : "max-h-[90vh] max-w-lg"} flex-col overflow-hidden rounded-lg border`}
        style={{ borderColor: "var(--border)", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
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
function ItemSignals({ item }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => call(`/api/v2/live/items/${item.id}/signals`).then((p) => { if (alive) { setData(p); setError(""); } }).catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [item.id]);
  if (item.orders !== "engine") return <p className="text-sm" style={{ color: "var(--muted)" }}>No signals for this model here yet.</p>;
  if (!data) return <p className="text-xs" style={{ color: error ? "var(--negative)" : "var(--faint)" }}>{error || "Working out the signals…"}</p>;
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
        <div className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>Holdings{item.real ? " (real: fills from the broker)" : " (dry run: orders taken as filled)"} · {open.length} open</div>
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
        <div className="mb-1 text-xs font-medium" style={{ color: "var(--muted)" }}>Order log · {item.real ? "real orders: SENT lines went to the broker (order id in the JSON line)" : "nothing sent: each order as the broker's API would get it"}{data.log.length ? " (click a line for its JSON)" : ""}</div>
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
function ItemModal({ item, fields, accounts, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(item.name);
  const [account, setAccount] = useState(item.account);
  const [settings, setSettings] = useState(item.settings);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState("settings");
  const locked = item.enabled;
  const dirty = name !== item.name || account !== item.account || JSON.stringify(settings) !== JSON.stringify(item.settings);
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
  const save = () => run(async () => onSaved((await call(`/api/v2/live/items/${item.id}`, "PUT", locked ? { name, settings } : { name, account, settings })).item));
  const toggle = (on) => run(async () => {
    if (dirty && !locked) await call(`/api/v2/live/items/${item.id}`, "PUT", { name, account, settings });
    onSaved((await call(`/api/v2/live/items/${item.id}/enabled`, "POST", { enabled: on })).item);
    setConfirm(false);
  });
  const remove = () => run(async () => {
    await call(`/api/v2/live/items/${item.id}`, "DELETE");
    onDeleted(item.id);
  });
  const acct = accounts.find((a) => a.id === account);
  return (
    <Modal wide title={item.name} sub={`${item.model_label} · ${item.enabled ? "enabled: real money" : "disabled"}`} onClose={onClose}
      footer={<>
        {!item.enabled && <button type="button" onClick={remove} disabled={busy} className={`${button} mr-auto`} style={{ borderColor: "var(--border)", color: "var(--negative)" }}>Delete</button>}
        <button type="button" onClick={save} disabled={busy || !dirty} className={button} style={{ borderColor: "var(--border)" }}>Save</button>
        {item.enabled ? (
          <button type="button" onClick={() => toggle(false)} disabled={busy} className={button} style={{ borderColor: "var(--negative)", color: "var(--negative)" }}>Disable</button>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} disabled={busy || !acct?.connected} className={button}
            style={{ borderColor: "var(--positive)", background: "var(--positive)", color: "var(--surface)" }} title={acct?.connected ? "Trade this item with real money" : "Its account isn't connected"}>
            Enable
          </button>
        )}
      </>}>
      <div className="flex flex-col gap-4">
        <div className="-mt-1 flex gap-1 border-b" role="tablist" aria-label="Item sections" style={{ borderColor: "var(--border)" }}>
          {[["settings", "Settings"], ["signals", "Signals"], ["log", "Log"]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className="-mb-px border-b-2 px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: tab === id ? "var(--accent)" : "transparent", color: tab === id ? "var(--text)" : "var(--muted)" }}>
              {label}
            </button>
          ))}
        </div>
        {tab === "signals" ? (
          <ItemSignals item={item} />
        ) : tab === "log" ? (
          item.orders === "engine" ? <ItemLog item={item} /> : <p className="text-sm" style={{ color: "var(--muted)" }}>No order log: {item.orders_note}.</p>
        ) : (<>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Name</span>
          <input className={input} style={inputStyle} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
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
                onChange={(v) => (f.key === "orders" && v === "real" && !window.confirm("Real orders: this item's orders will be SENT to the account (real money) when it is enabled. Continue?") ? null : setSettings({ ...settings, [f.key]: v }))} />
            ))}
          </div>
        </div>
        <p className="rounded-md px-3 py-2 text-xs" style={{ background: "var(--surface-2)", color: item.orders === "none" ? "var(--warning)" : "var(--muted)" }}>
          Orders: {item.orders_note}
          {item.page && <> · <a href={item.page} onClick={go(item.page)} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>Open its trading page →</a></>}
        </p>
        </>)}
        {confirm && (
          <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" style={{ borderColor: "var(--warning)" }}>
            <p><span className="font-semibold">Real money.</span> {item.name} will trade on {acct?.label} with the settings above.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(false)} className={button} style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button type="button" onClick={() => toggle(true)} disabled={busy} className={button} style={{ borderColor: "var(--positive)", background: "var(--positive)", color: "var(--surface)" }}>
                Yes, enable
              </button>
            </div>
          </div>
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
                  {fields.filter((f) => f.kind !== "fixed" && applies(f, it.settings)).map((f) => (
                    <div key={f.key} className="flex justify-between gap-3">
                      <dt style={{ color: "var(--muted)" }}>{f.label}</dt>
                      <dd className="truncate text-right">{shown(f, it.settings[f.key])}</dd>
                    </div>
                  ))}
                </dl>
                {it.orders === "none" && <p className="text-[0.6875rem]" style={{ color: "var(--warning)" }}>Order engine not built yet: nothing is sent</p>}
                {it.orders === "engine" && (it.real
                  ? <p className="text-[0.6875rem] font-semibold" style={{ color: "var(--negative)" }}>REAL ORDERS{it.enabled ? ": sent to the account at its times" : " (when enabled)"}</p>
                  : <p className="text-[0.6875rem]" style={{ color: "var(--accent)" }}>Order engine: dry run (orders logged, nothing sent)</p>)}
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
