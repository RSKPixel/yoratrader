import { useEffect, useState } from "react";

function extractToken(input) {
  const value = input.trim();
  // Accept either the bare token or the full redirect URL Kite sends you to.
  const match = value.match(/request_token=([^&\s]+)/);
  return match ? match[1] : value;
}

function CredentialsSection({ onSaved }) {
  const [creds, setCreds] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [revealing, setRevealing] = useState(false);

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

  useEffect(() => {
    fetch("/api/kite/credentials")
      .then((res) => res.json())
      .then(setCreds)
      .catch(() => setCreds(null));
  }, []);

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
        setResult({ ok: true, message: "Saved to database" });
        onSaved?.();
      } else {
        setResult({ ok: false, message: body.detail || `Request failed (${response.status})` });
      }
    } catch (error) {
      setResult({ ok: false, message: String(error?.message || error) });
    }
    setBusy(false);
  };

  const inputClass =
    "min-w-0 flex-1 rounded-md border border-[#2c313a] bg-[#111316] px-3 py-1.5 font-mono text-sm text-[#e7e4dc] outline-none focus:border-[#e2c08a]/60";

  return (
    <section className="rounded-md border border-[#2c313a] bg-[#181b20] p-4 md:col-span-2">
      <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">API credentials</h2>
      <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2 font-mono text-xs text-[#9b968c]">
        {revealed ? (
          <dl className="min-w-0 flex-1 space-y-1">
            <div className="flex gap-2">
              <dt className="shrink-0">API key:</dt>
              <dd className="select-all break-all text-[#e7e4dc]">{revealed.api_key || "not set"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0">API secret:</dt>
              <dd className="select-all break-all text-[#e7e4dc]">{revealed.api_secret || "not set"}</dd>
            </div>
          </dl>
        ) : (
          <p className="min-w-0 flex-1">
            API key: <span className="text-[#c8c3b8]">{creds?.has_api_key ? creds.api_key : "not set"}</span>
            {" · "}API secret:{" "}
            <span className={creds?.has_api_secret ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}>
              {creds?.has_api_secret ? "set" : "not set"}
            </span>
          </p>
        )}
        {(creds?.has_api_key || creds?.has_api_secret) && (
          <button
            type="button"
            onClick={toggleReveal}
            disabled={revealing}
            className="rounded-md border border-[#2c313a] px-2 py-0.5 font-sans text-xs text-[#c8c3b8] hover:bg-white/5 disabled:opacity-40"
          >
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
          className={inputClass}
        />
        <input
          type="password"
          value={apiSecret}
          onChange={(event) => setApiSecret(event.target.value)}
          placeholder="API secret (leave blank to keep)"
          autoComplete="new-password"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={busy || (!apiKey.trim() && !apiSecret.trim())}
          className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {result && (
        <p className={`mt-3 font-mono text-xs ${result.ok ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>{result.message}</p>
      )}
    </section>
  );
}

export default function KiteTokenPanel() {
  const [status, setStatus] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const refresh = (force = false) =>
    fetch(`/api/kite/status${force ? "?refresh=true" : ""}`)
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false, error: "Could not reach the API" }));

  useEffect(() => {
    refresh();
  }, []);

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
        setStatus(body);
        setInput("");
        window.dispatchEvent(new Event("kite-status-changed"));
      } else {
        setResult({ ok: false, message: body.detail || body.error || `Request failed (${response.status})` });
      }
    } catch (error) {
      setResult({ ok: false, message: String(error?.message || error) });
    }
    setBusy(false);
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <CredentialsSection
        onSaved={() => {
          refresh(true);
          window.dispatchEvent(new Event("kite-status-changed"));
        }}
      />
      <section className="rounded-md border border-[#2c313a] bg-[#181b20] p-4">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">Connection</h2>
        <dl className="mt-3 space-y-2 font-mono text-xs text-[#c8c3b8]">
          <div className="flex justify-between gap-3">
            <dt className="text-[#9b968c]">Status</dt>
            <dd className={status?.connected ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}>
              {status === null ? "Checking…" : status.connected ? "Connected" : "Disconnected"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[#9b968c]">User</dt>
            <dd>{status?.user_id ? `${status.user_name || ""} (${status.user_id})` : "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[#9b968c]">Last checked</dt>
            <dd>{status?.checked_at ? new Date(status.checked_at * 1000).toLocaleTimeString() : "—"}</dd>
          </div>
          {status?.error && (
            <div className="flex justify-between gap-3">
              <dt className="text-[#9b968c]">Error</dt>
              <dd className="truncate text-right text-[#f0b4b4]" title={status.error}>
                {status.error}
              </dd>
            </div>
          )}
        </dl>
        <button
          type="button"
          onClick={() => refresh(true)}
          className="mt-4 rounded-md border border-[#2c313a] px-3 py-1.5 text-sm text-[#c8c3b8] hover:bg-white/5"
        >
          Recheck
        </button>
      </section>

      <section className="rounded-md border border-[#2c313a] bg-[#181b20] p-4">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">Daily access token</h2>
        <ol className="mt-3 list-decimal space-y-1 pl-4 text-sm text-[#9b968c]">
          <li>
            <a href="/api/kite/login" target="_blank" rel="noreferrer" className="text-[#e2c08a] hover:underline">
              Open Kite login
            </a>{" "}
            and sign in.
          </li>
          <li>Copy the <span className="font-mono">request_token</span> (or the whole redirect URL).</li>
          <li>Paste it below. The access token is valid until ~6 AM IST tomorrow.</li>
        </ol>
        <form onSubmit={submit} className="mt-4 flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="request_token or redirect URL"
            className="min-w-0 flex-1 rounded-md border border-[#2c313a] bg-[#111316] px-3 py-1.5 font-mono text-sm text-[#e7e4dc] outline-none focus:border-[#e2c08a]/60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
          >
            {busy ? "Generating…" : "Generate token"}
          </button>
        </form>
        {result && (
          <p className={`mt-3 font-mono text-xs ${result.ok ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>{result.message}</p>
        )}
      </section>
    </div>
  );
}
