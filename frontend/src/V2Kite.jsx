import { useCallback, useEffect, useState } from "react";
import { inputStyle } from "./V2Controls";

// Kite in v2: a status button for the top nav (green = connected, red = not) that opens a modal with
// everything about Kite: the connection, the daily access token (log in, paste the
// request token) and the API credentials. The same panel sits in Settings.

const STATUS_EVENT = "kite-status-changed";

function extractToken(input) {
  const value = input.trim();
  const match = value.match(/request_token=([^&\s]+)/); // the bare token or the whole redirect URL
  return match ? match[1] : value;
}

export function useKiteStatus() {
  const [status, setStatus] = useState(null);
  const refresh = useCallback((force = false) => {
    return fetch(`/api/kite/status${force ? "?refresh=true" : ""}`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false, error: "Could not reach the API" }));
  }, []);
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(STATUS_EVENT, onChange);
    const timer = setInterval(() => refresh(), 5 * 60 * 1000);
    return () => {
      window.removeEventListener(STATUS_EVENT, onChange);
      clearInterval(timer);
    };
  }, [refresh]);
  return [status, refresh];
}

const announce = () => window.dispatchEvent(new Event(STATUS_EVENT));

function Section({ title, children }) {
  return (
    <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

const button = "rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40";
const primary = { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" };

function Connection({ status, onRecheck }) {
  const [checking, setChecking] = useState(false);
  const row = (label, value, color) => (
    <div className="flex justify-between gap-3 py-1">
      <dt style={{ color: "var(--muted)" }}>{label}</dt>
      <dd className="truncate text-right" style={{ color: color || "var(--text)" }} title={typeof value === "string" ? value : undefined}>
        {value}
      </dd>
    </div>
  );
  return (
    <Section title="Connection">
      <dl className="text-sm tabular-nums">
        {row("Status", status == null ? "Checking…" : status.connected ? "Connected" : "Disconnected", status?.connected ? "var(--positive)" : "var(--negative)")}
        {row("User", status?.user_id ? `${status.user_name || ""} (${status.user_id})` : "—")}
        {row("Last checked", status?.checked_at ? new Date(status.checked_at * 1000).toLocaleTimeString("en-IN") : "—")}
        {status?.error && row("Error", status.error, "var(--negative)")}
      </dl>
      <button
        type="button"
        className={`${button} mt-3`}
        style={{ borderColor: "var(--border)" }}
        disabled={checking}
        onClick={() => {
          setChecking(true);
          Promise.resolve(onRecheck(true)).finally(() => {
            setChecking(false);
            announce();
          });
        }}
      >
        {checking ? "Checking…" : "Recheck"}
      </button>
    </Section>
  );
}

function AccessToken({ onConnected }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    const requestToken = extractToken(input);
    if (!requestToken) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/kite/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_token: requestToken }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.connected) {
        setResult({ ok: true, message: `Connected as ${body.user_name || body.user_id}` });
        setInput("");
        onConnected(body);
        announce();
      } else {
        setResult({ ok: false, message: body.detail || body.error || `Request failed (${response.status})` });
      }
    } catch (error) {
      setResult({ ok: false, message: String(error?.message || error) });
    }
    setBusy(false);
  };
  return (
    <Section title="Daily access token">
      <a href="/api/kite/login" target="_blank" rel="noreferrer" className={`${button} inline-block`} style={primary}>
        Kite Login
      </a>
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="request_token or redirect URL"
          aria-label="Request token or redirect URL"
          className="min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-sm outline-none"
          style={inputStyle}
        />
        <button type="submit" disabled={busy || !input.trim()} className={button} style={primary}>
          {busy ? "Generating…" : "Generate token"}
        </button>
      </form>
      {result && (
        <p className="mt-2 text-xs" style={{ color: result.ok ? "var(--positive)" : "var(--negative)" }}>
          {result.message}
        </p>
      )}
    </Section>
  );
}

function Credentials({ onSaved }) {
  const [creds, setCreds] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    fetch("/api/kite/credentials")
      .then((r) => r.json())
      .then(setCreds)
      .catch(() => setCreds(null));
  }, []);
  const toggleReveal = async () => {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setRevealing(true);
    try {
      const response = await fetch("/api/kite/credentials/reveal", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (response.ok) setRevealed(body);
      else setResult({ ok: false, message: body.detail || `Request failed (${response.status})` });
    } catch (error) {
      setResult({ ok: false, message: String(error?.message || error) });
    }
    setRevealing(false);
  };
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/kite/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey.trim(), api_secret: apiSecret.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setCreds(body);
        setRevealed(null);
        setApiKey("");
        setApiSecret("");
        setResult({ ok: true, message: "Saved to the database" });
        onSaved?.();
        announce();
      } else {
        setResult({ ok: false, message: body.detail || `Request failed (${response.status})` });
      }
    } catch (error) {
      setResult({ ok: false, message: String(error?.message || error) });
    }
    setBusy(false);
  };
  return (
    <Section title="API credentials">
      <div className="flex flex-wrap items-start gap-3 text-sm">
        {revealed ? (
          <dl className="min-w-0 flex-1 space-y-1 font-mono text-xs">
            <div className="flex gap-2">
              <dt style={{ color: "var(--muted)" }}>API key:</dt>
              <dd className="select-all break-all">{revealed.api_key || "not set"}</dd>
            </div>
            <div className="flex gap-2">
              <dt style={{ color: "var(--muted)" }}>API secret:</dt>
              <dd className="select-all break-all">{revealed.api_secret || "not set"}</dd>
            </div>
          </dl>
        ) : (
          <p className="min-w-0 flex-1" style={{ color: "var(--muted)" }}>
            API key: <span className="font-mono" style={{ color: "var(--text)" }}>{creds?.has_api_key ? creds.api_key : "not set"}</span> · API secret:{" "}
            <span style={{ color: creds?.has_api_secret ? "var(--positive)" : "var(--negative)" }}>{creds?.has_api_secret ? "set" : "not set"}</span>
          </p>
        )}
        {(creds?.has_api_key || creds?.has_api_secret) && (
          <button type="button" onClick={toggleReveal} disabled={revealing} className={button} style={{ borderColor: "var(--border)" }}>
            {revealing ? "Loading…" : revealed ? "Hide" : "Show"}
          </button>
        )}
      </div>
      <form onSubmit={save} className="mt-3 flex flex-wrap gap-2">
        <input
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="API key (leave blank to keep)"
          autoComplete="off"
          aria-label="API key"
          className="min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-sm outline-none"
          style={inputStyle}
        />
        <input
          type="password"
          value={apiSecret}
          onChange={(event) => setApiSecret(event.target.value)}
          placeholder="API secret (leave blank to keep)"
          autoComplete="new-password"
          aria-label="API secret"
          className="min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-sm outline-none"
          style={inputStyle}
        />
        <button type="submit" disabled={busy || (!apiKey.trim() && !apiSecret.trim())} className={button} style={{ borderColor: "var(--border)" }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {result && (
        <p className="mt-2 text-xs" style={{ color: result.ok ? "var(--positive)" : "var(--negative)" }}>
          {result.message}
        </p>
      )}
    </Section>
  );
}

// Everything Kite: disconnected puts the login first; connected puts the connection first.
export function KitePanel({ status, refresh, onStatus }) {
  const connected = status?.connected;
  const token = <AccessToken key="token" onConnected={(s) => onStatus?.(s)} />;
  const connection = <Connection key="connection" status={status} onRecheck={refresh} />;
  const creds = <Credentials key="creds" onSaved={() => refresh(true)} />;
  return <div className="flex flex-col gap-3">{connected ? [connection, token, creds] : [token, connection, creds]}</div>;
}

export function KiteButton() {
  const [status, refresh] = useKiteStatus();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const connected = status?.connected;
  const color = status == null ? "var(--faint)" : connected ? "var(--positive)" : "var(--negative)";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: `color-mix(in srgb, ${color} 55%, var(--border))`, color }}
        title={status == null ? "Checking Kite…" : connected ? `Kite connected${status.user_id ? ` as ${status.user_id}` : ""}` : "Kite not connected: click to log in"}
        aria-label={connected ? "Kite connected" : "Kite not connected"}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
        Kite
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4 pt-16" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Kite"
            className="w-full max-w-2xl rounded-lg border p-4"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />
                Kite {connected ? "connected" : status == null ? "" : "not connected"}
              </h2>
              <button type="button" onClick={() => setOpen(false)} className={button} style={{ borderColor: "var(--border)" }}>
                Close
              </button>
            </div>
            <KitePanel status={status} refresh={refresh} onStatus={() => refresh(true)} />
          </div>
        </div>
      )}
    </>
  );
}
