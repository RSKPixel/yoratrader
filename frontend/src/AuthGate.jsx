import { createContext, useContext, useEffect, useState } from "react";
import { loadSettings, SettingsProvider, systemTheme } from "./settings";

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

// How the logged-in user is shown everywhere: their user name, else the login ID.
export function displayName(user) {
  return user?.display_name || user?.username || "";
}

// Any API call that comes back 401 means the session ended: drop back to the login page.
let onUnauthorized = () => {};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : input?.url || "";
  if (response.status === 401 && url.includes("/api/") && !url.includes("/api/auth/login") && !url.includes("/api/auth/totp")) {
    onUnauthorized();
  }
  return response;
};

// The sign-in screen follows the system theme (settings are per user, on the server, and load after sign-in).
const field = { borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" };

// A light / dark switch top right: for this visit only (before sign-in there are no saved settings, and settings
// never live in the browser); after sign-in the user's own saved theme applies.
function Shell({ children }) {
  const [theme, setTheme] = useState(systemTheme);
  const dark = theme === "dark";
  return (
    <div className="v2 relative flex h-full items-center justify-center px-4" data-theme={theme}>
      <button
        type="button"
        onClick={() => setTheme(dark ? "light" : "dark")}
        className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-md border transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: "var(--border)", color: "var(--muted)", background: "var(--surface)" }}
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        title={dark ? "Light mode" : "Dark mode"}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {dark ? (
            <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
          ) : (
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          )}
        </svg>
      </button>
      {children}
    </div>
  );
}

const labelCls = "mt-4 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em]";
const inputCls = "mt-1.5 w-full rounded-md border px-3 py-2 text-sm normal-case tracking-normal outline-none transition-colors focus:border-[var(--accent)]";

async function post(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function Card({ subtitle, onSubmit, children }) {
  return (
    <Shell>
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl border p-7 shadow-xl" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <p className="text-center text-xl font-bold tracking-[0.18em]">
          <span style={{ color: "var(--brand)" }}>YORA</span>
          <span style={{ color: "var(--brand-gold)" }}>TRADER</span>
        </p>
        <p className="mt-1.5 text-center text-sm" style={{ color: "var(--muted)" }}>
          {subtitle}
        </p>
        {children}
      </form>
    </Shell>
  );
}

function ErrorBox({ error }) {
  return error ? (
    <p className="mt-4 rounded-md px-3 py-2 text-xs" style={{ background: "color-mix(in srgb, var(--negative) 12%, transparent)", color: "var(--negative)" }}>
      {error}
    </p>
  ) : null;
}

function Submit({ busy, disabled, children }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="mt-6 w-full rounded-md px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-40"
      style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
    >
      {children}
    </button>
  );
}

function CodeStep({ step, onLogin, onBack }) {
  // Second step: the 6-digit Google Authenticator code; the first time, scan the QR code before it.
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);

  const submit = async (event) => {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post("/api/auth/totp", { challenge: step.challenge, code });
      if (r.ok) {
        onLogin(r.body.user);
        return;
      }
      if (r.status === 401 && /expired/i.test(r.body.detail || "")) {
        onBack(r.body.detail);
        return;
      }
      setError(r.body.detail || `Sign-in failed (${r.status})`);
    } catch (err) {
      setError(String(err?.message || err));
    }
    setCode("");
    setBusy(false);
  };

  return (
    <Card subtitle={step.enroll ? "Set up Google Authenticator" : "Two-step verification"} onSubmit={submit}>
      {step.enroll && (
        <div className="mt-6 flex flex-col items-center gap-3 text-center">
          <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
            Open Google Authenticator, tap <b>+</b> → <b>Scan a QR code</b>, and scan this. You'll only do this once.
          </p>
          <div className="rounded-lg bg-white p-1" dangerouslySetInnerHTML={{ __html: step.qr_svg }} aria-label="Authenticator QR code" />
          <button type="button" onClick={() => setShowKey((v) => !v)} className="text-xs underline" style={{ color: "var(--muted)" }}>
            {showKey ? "Hide setup key" : "Can't scan? Enter a setup key"}
          </button>
          {showKey && (
            <code className="rounded-md border px-2 py-1 text-xs tracking-[0.12em] break-all select-all" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
              {step.secret.match(/.{1,4}/g).join(" ")}
            </code>
          )}
        </div>
      )}
      <label className={`${labelCls} ${step.enroll ? "mt-5" : "mt-7"}`} style={{ color: "var(--faint)" }}>
        {step.enroll ? "Code shown in the app" : "Authenticator code"}
        <input
          value={code}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(v);
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          autoFocus
          className={`${inputCls} text-center text-lg tabular-nums tracking-[0.5em]`}
          style={field}
        />
      </label>
      <ErrorBox error={error} />
      <Submit busy={busy} disabled={code.length !== 6}>
        {busy ? "Verifying…" : step.enroll ? "Confirm and sign in" : "Verify"}
      </Submit>
      <button type="button" onClick={() => onBack("")} className="mt-3 w-full text-center text-xs" style={{ color: "var(--muted)" }}>
        ← Back
      </button>
    </Card>
  );
}

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(null); // the password step's challenge: { challenge, enroll, qr_svg?, secret? }

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post("/api/auth/login", { username: username.trim(), password });
      if (r.ok) setStep(r.body);
      else setError(r.body.detail || `Sign-in failed (${r.status})`);
    } catch (err) {
      setError(String(err?.message || err));
    }
    setPassword("");
    setBusy(false);
  };

  if (step) {
    return (
      <CodeStep
        step={step}
        onLogin={onLogin}
        onBack={(message) => {
          setStep(null);
          setError(message);
        }}
      />
    );
  }

  return (
    <Card subtitle="Sign in to continue" onSubmit={submit}>
      <label className={`${labelCls} mt-7`} style={{ color: "var(--faint)" }}>
        User ID
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required className={inputCls} style={field} />
      </label>
      <label className={labelCls} style={{ color: "var(--faint)" }}>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className={inputCls} style={field} />
      </label>
      <ErrorBox error={error} />
      <Submit busy={busy} disabled={!username.trim() || !password}>
        {busy ? "Signing in…" : "Continue"}
      </Submit>
      <p className="mt-4 text-center text-[0.6875rem]" style={{ color: "var(--faint)" }}>
        Sign-in lasts a week (ends 06:00 IST)
      </p>
    </Card>
  );
}

export default function AuthGate({ children }) {
  // undefined = still checking, null = logged out, object = logged in
  const [user, setUser] = useState(undefined);
  const [settings, setSettings] = useState(null); // the user's settings, loaded once signed in

  useEffect(() => {
    onUnauthorized = () => setUser(null);
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { user: null }))
      .then((body) => setUser(body.user || null))
      .catch(() => setUser(null));
  }, []);

  const signedIn = !!user;
  useEffect(() => {
    if (!signedIn) {
      setSettings(null);
      return;
    }
    loadSettings()
      .then(setSettings)
      .catch(() => setSettings({}));
  }, [signedIn]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  };

  if (user === undefined || (user && !settings)) {
    return (
      <Shell>
        <span className="text-sm" style={{ color: "var(--faint)" }}>
          Loading…
        </span>
      </Shell>
    );
  }
  if (!user) return <LoginPage onLogin={setUser} />;

  return (
    <AuthContext.Provider value={{ user, setUser, logout }}>
      <SettingsProvider initial={settings}>{children}</SettingsProvider>
    </AuthContext.Provider>
  );
}
