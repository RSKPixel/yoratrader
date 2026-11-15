import { useEffect, useState } from "react";
import { useAuth } from "./AuthGate";
import { inputStyle, Segmented } from "./V2Controls";
import { KitePanel, useKiteStatus } from "./V2Kite";

// v2 Settings: a dialog with three tabs. General (theme), Kite (connection, daily token, credentials),
// Profile (user name, password; the user ID is fixed and can't be changed).

const TABS = [
  ["general", "General"],
  ["kite", "Kite"],
  ["profile", "Profile"],
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
      setUser(body.user);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-4 pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Settings</h2>
            <button type="button" onClick={onClose} className={button} style={{ borderColor: "var(--border)" }}>
              Close
            </button>
          </div>
          <div className="mt-2 flex items-end gap-1" role="tablist" aria-label="Settings sections">
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
          {tab === "profile" && <Profile />}
        </div>
      </div>
    </div>
  );
}
