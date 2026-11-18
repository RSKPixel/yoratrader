import { useEffect, useState } from "react";
import { useAuth } from "./AuthGate";
import { inputStyle, Segmented } from "./V2Controls";
import { KitePanel, useKiteStatus } from "./V2Kite";

// v2 Settings: a dialog with five tabs (Angel One: SmartAPI credentials). General (theme), Kite (connection, daily token, credentials),
// Profile (user name, password; the user ID is fixed and can't be changed), Backups (the nightly database backup).

const TABS = [
  ["general", "General"],
  ["kite", "Kite"],
  ["angel", "Angel One"],
  ["profile", "Profile"],
  ["backups", "Backups"],
];
const button = "rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40";
const primary = { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" };

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

function Message({ result }) {
  if (!result) return null;
  return (
    <p className="mt-2 text-xs" style={{ color: result.ok ? "var(--positive)" : "var(--negative)" }}>
      {result.message}
    </p>
  );
}

async function post(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

const size = (b) => (b == null ? "—" : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);

// Angel One SmartAPI: credentials stored on the server (app_settings, like Kite's), masked once saved; a
// login test. Read-only use (historical data); nothing places orders.
function AngelOne() {
  const [c, setC] = useState(null);
  const [form, setForm] = useState({ api_key: "", client_code: "", pin: "", totp_secret: "" });
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = () => fetch("/api/angel/credentials").then((r) => r.json()).then(setC).catch(() => setC(null));
  useEffect(() => {
    load();
  }, []);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/angel/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      setC(b);
      setForm({ api_key: "", client_code: "", pin: "", totp_secret: "" });
      setMsg({ ok: true, text: "Saved." });
    } else setMsg({ ok: false, text: b.detail || "Not saved" });
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/angel/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ otp }) });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    setOtp("");
    if (b.status === "success") {
      setC(b);
      setMsg({ ok: true, text: `Logged in${b.name ? ` as ${b.name}` : ""}.` });
    } else setMsg({ ok: false, text: b.message || "Login failed" });
  };
  const field = (key, label, hint, stored, type = "password") => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={stored ? `stored ${typeof stored === "string" ? stored : "✓"} · type to replace` : "not set"}
        autoComplete="off"
        className="rounded-md border px-2.5 py-1.5 text-sm outline-none"
        style={inputStyle}
      />
      <span className="text-xs" style={{ color: "var(--faint)" }}>{hint}</span>
    </label>
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        Angel One SmartAPI, for historical data tests. Saved on the server, never shown in full again. Nothing here places orders.
      </p>
      <div className="flex items-center gap-2 text-sm font-medium" style={{ color: c?.logged_in ? "var(--positive)" : "var(--muted)" }}>
        <span className="h-2 w-2 rounded-full" style={{ background: c?.logged_in ? "var(--positive)" : "var(--faint)" }} aria-hidden="true" />
        {c?.logged_in ? `Logged in${c.name ? ` as ${c.name}` : ""} (${c.logged_in_at})` : "Not logged in"}
      </div>
      <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
        {field("api_key", "API key", "From the SmartAPI developer portal: your app's API key", c?.api_key)}
        {field("client_code", "Client code", "Your Angel One client ID", c?.client_code, "text")}
        {field("pin", "PIN", "Your 4-digit Angel One login PIN", c?.has_pin)}
        {field("totp_secret", "TOTP secret (optional)", "The authenticator secret shown when you enabled TOTP (letters and digits), not today's 6-digit code. Without it, enter the code for each login below.", c?.has_totp_secret)}
        <div>
          <button type="submit" disabled={busy || !Object.values(form).some((v) => v.trim())} className={button} style={primary}>
            Save
          </button>
        </div>
      </form>
      <div className="flex flex-wrap items-end gap-2">
        {!c?.has_totp_secret && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">6-digit code</span>
            <input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" maxLength={6} className="w-28 rounded-md border px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
          </label>
        )}
        <button type="button" onClick={test} disabled={busy || !c?.client_code} className={button} style={{ borderColor: "var(--border)" }}>
          Test connection
        </button>
      </div>
      {msg && <p className="text-sm" style={{ color: msg.ok ? "var(--positive)" : "var(--negative)" }}>{msg.text}</p>}
    </div>
  );
}

// The nightly database backup (scripts/nightly_backup.sh, the server's crontab): its last run and the dumps kept
function Backups() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/backups")
      .then((r) => r.json())
      .then((p) => (p.status === "success" ? setD(p) : setError(p.message || "Could not read the backups")))
      .catch(() => setError("Could not reach the API"));
  }, []);
  if (error) return <p className="text-sm" style={{ color: "var(--negative)" }}>{error}</p>;
  if (!d) return <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>;
  const b = d.backup;
  const list = (title, rows, dir) => (
    <section className="rounded-lg border" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2 text-sm font-medium" style={{ borderColor: "var(--border)" }}>
        {title}
        <span className="truncate text-xs font-normal" style={{ color: "var(--faint)" }}>{dir}</span>
      </div>
      {rows.length ? (
        rows.map((f) => (
          <div key={f.name} className="flex justify-between gap-3 border-t px-3 py-1.5 text-sm tabular-nums first:border-t-0" style={{ borderColor: "var(--border)" }}>
            <span>{f.at.replace("T", " ")}</span>
            <span style={{ color: "var(--muted)" }}>{size(f.bytes)}</span>
          </div>
        ))
      ) : (
        <p className="px-3 py-2 text-sm" style={{ color: "var(--muted)" }}>None yet.</p>
      )}
    </section>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        The whole database is backed up {d.schedule}, copied to the T7 drive, and the last {d.keep} days are kept in each place.
      </p>
      {!b ? (
        <p className="text-sm" style={{ color: "var(--warning)" }}>No nightly backup has run yet.</p>
      ) : (
        <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2 font-medium" style={{ color: b.ok ? "var(--positive)" : "var(--negative)" }}>
            <span className="h-2 w-2 rounded-full" style={{ background: b.ok ? "var(--positive)" : "var(--negative)" }} aria-hidden="true" />
            Last backup {b.ok ? "succeeded" : "failed"} · {b.ran_at.replace("T", " ")}
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            {b.ok ? `${b.tables} tables · ${size(b.local?.[0]?.bytes)} · ${b.seconds}s · T7: ${b.t7}` : b.error}
          </div>
        </div>
      )}
      {b && list("On the server", b.local || [], b.local_dir)}
      {b && list("On the T7 drive", b.t7_files || [], b.t7_dir)}
    </div>
  );
}

function General({ theme, onTheme }) {
  return (
    <Section title="Appearance">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Theme"
          options={[
            ["dark", "Dark"],
            ["light", "Light"],
          ]}
          value={theme}
          onChange={onTheme}
        />
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          Remembered in this browser.
        </span>
      </div>
    </Section>
  );
}

function Profile() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.display_name || "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState("");
  const [nameResult, setNameResult] = useState(null);
  const [passwordResult, setPasswordResult] = useState(null);
  const saveName = async (event) => {
    event.preventDefault();
    setBusy("name");
    try {
      const body = await post("/api/auth/name", { display_name: name.trim() });
      setUser((u) => ({ ...u, ...body.user }));
      setName(body.user.display_name || "");
      setNameResult({ ok: true, message: "Saved." });
    } catch (error) {
      setNameResult({ ok: false, message: error.message });
    }
    setBusy("");
  };
  const savePassword = async (event) => {
    event.preventDefault();
    setBusy("password");
    try {
      await post("/api/auth/password", { current_password: current, new_password: next });
      setNext("");
      setPasswordResult({ ok: true, message: "Password changed. Other devices were signed out." });
    } catch (error) {
      setPasswordResult({ ok: false, message: error.message });
    }
    setCurrent("");
    setBusy("");
  };
  const field = "w-full rounded-md border px-3 py-1.5 text-sm outline-none";
  return (
    <div className="flex flex-col gap-3">
      <Section title="Account">
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          User ID
        </p>
        <p className="mt-1 font-mono text-sm">{user?.username}</p>
        <form onSubmit={saveName} className="mt-4">
          <label className="block text-xs" style={{ color: "var(--muted)" }}>
            User name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" className={`${field} mt-1`} style={inputStyle} />
          </label>
          <button type="submit" disabled={busy !== "" || name.trim() === (user?.display_name || "")} className={`${button} mt-2`} style={primary}>
            {busy === "name" ? "Saving…" : "Save name"}
          </button>
          <Message result={nameResult} />
        </form>
      </Section>
      <Section title="Security">
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt style={{ color: "var(--muted)" }}>Two-step verification</dt>
            <dd style={{ color: "var(--positive)" }}>Google Authenticator · on</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: "var(--muted)" }}>This session ends</dt>
            <dd className="tabular-nums">
              {user?.expires_at
                ? new Date(user.expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
                : "—"}{" "}
              IST
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs" style={{ color: "var(--faint)" }}>
          Every session ends at 06:00 IST. Lost your phone? On the server run <code>manage_user.py --reset-2fa</code>; the next sign-in shows a new QR code.
        </p>
      </Section>
      <Section title="Change password">
        <form onSubmit={savePassword} className="flex flex-col gap-2">
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" autoComplete="current-password" aria-label="Current password" className={field} style={inputStyle} />
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (8+ characters)" autoComplete="new-password" aria-label="New password" className={field} style={inputStyle} />
          <div>
            <button type="submit" disabled={busy !== "" || !current || next.length < 8} className={button} style={primary}>
              {busy === "password" ? "Saving…" : "Change password"}
            </button>
          </div>
          <Message result={passwordResult} />
        </form>
      </Section>
    </div>
  );
}

function KiteTab() {
  const [status, refresh] = useKiteStatus();
  return <KitePanel status={status} refresh={refresh} onStatus={() => refresh(true)} />;
}

export default function V2Settings({ theme, onTheme, onClose, initialTab = "general" }) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--muted)" }}
            aria-label="Close settings"
            title="Close (Esc)"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="border-b px-4 pt-2" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-end gap-1" role="tablist" aria-label="Settings sections">
            {TABS.map(([id, label]) => {
              const active = id === tab;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(id)}
                  className="-mb-px border-b-2 px-3 pb-2.5 text-sm font-medium transition-colors"
                  style={active ? { borderColor: "var(--accent)", color: "var(--accent)" } : { borderColor: "transparent", color: "var(--muted)" }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4" role="tabpanel">
          {tab === "general" && <General theme={theme} onTheme={onTheme} />}
          {tab === "kite" && <KiteTab />}
          {tab === "angel" && <AngelOne />}
          {tab === "profile" && <Profile />}
          {tab === "backups" && <Backups />}
        </div>
      </div>
    </div>
  );
}
