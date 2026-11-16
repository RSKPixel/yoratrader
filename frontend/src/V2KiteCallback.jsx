import { useEffect, useRef, useState } from "react";
import { systemTheme, useSetting } from "./settings";

// /kite: where Kite sends you after logging in (the app's redirect URL). Exchanges the request_token
// for the day's access token, then returns to v2. A token works once, so it's sent only once.

const sent = new Set(); // tokens sent from this page (a token works once)

export default function V2KiteCallback() {
  const [state, setState] = useState({ status: "working" });
  const [theme] = useSetting("theme", systemTheme());
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("request_token");
    const kiteStatus = params.get("status");
    window.history.replaceState(null, "", "/kite"); // don't leave the token in the address bar or history
    if (kiteStatus && kiteStatus !== "success") {
      setState({ status: "error", message: `Kite returned "${kiteStatus}"` });
      return;
    }
    if (!token) {
      setState({ status: "error", message: "No request_token in the address" });
      return;
    }
    if (sent.has(token)) {
      setState({ status: "error", message: "This token was already used; log in to Kite again" });
      return;
    }
    sent.add(token);
    fetch("/api/kite/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_token: token }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.ok && body.connected) {
          setState({ status: "ok", user: body.user_name || body.user_id });
          window.dispatchEvent(new Event("kite-status-changed"));
          setTimeout(() => window.location.replace("/"), 2500);
        } else {
          setState({ status: "error", message: body.detail || body.error || `Request failed (${r.status})` });
        }
      })
      .catch((e) => setState({ status: "error", message: String(e?.message || e) }));
  }, []);

  const ok = state.status === "ok";
  return (
    <div className="v2 flex h-full items-center justify-center p-4" data-theme={theme}>
      <div className="w-full max-w-sm rounded-lg border p-6 text-center" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <p className="text-xl font-bold tracking-[0.18em]">
          <span style={{ color: "var(--brand)" }}>YORA</span>
          <span style={{ color: "var(--brand-gold)" }}>TRADER</span>
        </p>
        <p className="mt-4 flex items-center justify-center gap-2 text-base font-medium">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: state.status === "working" ? "var(--faint)" : ok ? "var(--positive)" : "var(--negative)" }}
            aria-hidden="true"
          />
          {state.status === "working" ? "Connecting to Kite…" : ok ? "Kite connected" : "Kite login failed"}
        </p>
        <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
          {ok ? `as ${state.user} · taking you back…` : state.status === "error" ? state.message : "Exchanging the request token"}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {state.status === "error" && (
            <a href="/api/kite/login" className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: "var(--accent)", color: "var(--accent-ink)" }}>
              Kite Login
            </a>
          )}
          <a href="/" className="rounded-md border px-3 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
            Back to YoraTrader
          </a>
        </div>
      </div>
    </div>
  );
}
