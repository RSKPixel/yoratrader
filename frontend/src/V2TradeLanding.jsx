import { useCallback, useEffect, useState } from "react";
import { Segmented } from "./V2Controls";

// The Live trading landing page: each model that could be traded with real money, and its mode, saved on
// the server (livetrade.LIVE_MODES): Off (not traded), Manual (you trade it by hand from its page), Auto
// (automatic orders: no model has them yet, so Auto is greyed out).

const MODELS = [
  { id: "turn-of-month", label: "Turn of the month", style: "Positional", href: "/v2/trade/turn-of-month", page: "Live trading page: the call to buy, Buy / Sell, stop and what-if", source: "Larry Williams" },
  { id: "books-gold", label: "Books + gold", style: "Positional", href: "/v2/trade/books-gold", page: "Its own page: what to hold against your Kite holdings", source: "Our portfolio" },
  { id: "short-term-reversion", label: "Short-term mean reversion", style: "Positional", href: "/v2/paper/short-term-reversion", page: "Signals on its paper page (bought at 15:15)", source: "Larry Connors" },
  { id: "cumulative-rsi", label: "Cumulative RSI(2)", style: "Positional", href: "/v2/paper/cumulative-rsi", page: "Signals on its paper page (bought at 15:15)", source: "Larry Connors" },
  { id: "oops", label: "Oops gap reversal", style: "Intraday", href: "/v2/paper/oops", page: "Signals on its paper page (from 09:15)", source: "Larry Williams" },
  { id: "buy-on-gap", label: "Buy/Sell on gap", style: "Intraday", href: "/v2/paper/buy-on-gap", page: "Signals on its paper page (at the open)", source: "Ernest Chan" },
  { id: "xs-mean-reversion", label: "Cross-sectional mean reversion", style: "Intraday", href: "/v2/paper/xs-mean-reversion", page: "Signals on its paper page (at 09:15)", source: "Ernest Chan" },
];

const MEANING = {
  off: ["Not traded", "var(--muted)"],
  manual: ["You place the orders by hand", "var(--warning)"],
  auto: ["Orders placed automatically", "var(--positive)"],
};

const go = (href) => (e) => {
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export default function V2TradeLanding() {
  const [modes, setModes] = useState(null);
  const [automatic, setAutomatic] = useState([]);
  const [disaster, setDisaster] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    fetch("/api/v2/trade/modes")
      .then((r) => r.json())
      .then((p) => {
        if (p.status === "success") {
          setModes(p.modes);
          setAutomatic(p.automatic || []);
          setDisaster(p.disaster || {});
        } else setError(p.message || p.detail || "Could not load the modes");
      })
      .catch(() => setError("Could not reach the API"));
  }, []);

  const save = useCallback(async (model, mode) => {
    setSaving(model);
    setError("");
    try {
      const r = await fetch("/api/v2/trade/modes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, mode }) });
      const p = await r.json().catch(() => ({}));
      if (!r.ok) setError(p.detail || `Could not save (${r.status})`);
      else setModes(p.modes);
    } catch (e) {
      setError(String(e?.message || e));
    }
    setSaving(null);
  }, []);

  const counts = modes ? Object.values(modes).reduce((a, m) => ({ ...a, [m]: (a[m] || 0) + 1 }), {}) : {};
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
          Live trading
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Models with real money</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Each model's mode: Off (not traded), Manual (you trade it by hand) or Auto (automatic orders, not built for any model yet). Saved on the server.
          {modes && ` · ${counts.manual || 0} manual · ${counts.auto || 0} auto · ${counts.off || 0} off`}
        </p>
      </div>
      {error && <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>}
      {!modes ? (
        !error && <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {MODELS.map((m) => {
            const mode = modes[m.id] || "off";
            const auto = automatic.includes(m.id);
            return (
              <div key={m.id} className="flex flex-col gap-3 rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{m.label}</h3>
                  <span className="text-[0.625rem] font-medium uppercase tracking-[0.08em]" style={{ color: m.style === "Intraday" ? "var(--accent)" : "var(--muted)" }}>
                    {m.style}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented
                    label={`${m.label} mode`}
                    options={[
                      ["off", "Off", saving === m.id],
                      ["manual", "Manual", saving === m.id],
                      ["auto", "Auto", saving === m.id || !auto, auto ? undefined : "Automatic orders aren't built for this model yet"],
                    ]}
                    value={mode}
                    onChange={(v) => v !== mode && save(m.id, v)}
                  />
                  <span className="text-xs" style={{ color: MEANING[mode][1] }}>
                    {MEANING[mode][0]}
                  </span>
                </div>
                <dl className="flex flex-col gap-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt style={{ color: "var(--muted)" }}>From</dt>
                    <dd>{m.source}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt style={{ color: "var(--muted)" }}>Where</dt>
                    <dd className="text-right">{m.page}</dd>
                  </div>
                  {disaster[m.id] != null && (
                    <div className="flex justify-between gap-3" title="Chan's disaster stop: wider than the worst move against any backtest position; place it in Kite with every position">
                      <dt style={{ color: "var(--muted)" }}>Disaster stop</dt>
                      <dd className="text-right font-medium" style={{ color: "var(--warning)" }}>
                        {disaster[m.id]}% from the entry · place it in Kite with every position
                      </dd>
                    </div>
                  )}
                </dl>
                <a href={m.href} onClick={go(m.href)} className="mt-auto text-sm font-medium hover:underline" style={{ color: "var(--accent)" }}>
                  Open →
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
