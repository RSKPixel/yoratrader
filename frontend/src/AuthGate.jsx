import { createContext, useContext, useEffect, useState } from "react";

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
  if (response.status === 401 && url.includes("/api/") && !url.includes("/api/auth/login")) {
    onUnauthorized();
  }
  return response;
};

// The sign-in screen uses the v2 theme the browser last chose (dark by default).
function savedTheme() {
  try {
    const t = localStorage.getItem("yt-v2-theme");
    if (t === "light" || t === "dark") return t;
  } catch {
    // storage blocked
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const field = { borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" };

function Shell({ children }) {
  return (
    <div className="v2 flex h-full items-center justify-center px-4" data-theme={savedTheme()}>
      {children}
    </div>
  );
}

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onLogin(body.user);
        return;
      }
      setError(body.detail || `Login failed (${response.status})`);
    } catch (err) {
      setError(String(err?.message || err));
    }
    setPassword("");
    setBusy(false);
  };

  const label = "mt-4 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em]";
  const input = "mt-1.5 w-full rounded-md border px-3 py-2 text-sm normal-case tracking-normal outline-none transition-colors focus:border-[var(--accent)]";
  return (
    <Shell>
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border p-7 shadow-xl" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <p className="text-center text-xl font-bold tracking-[0.18em]">
          <span style={{ color: "var(--brand)" }}>YORA</span>
          <span style={{ color: "var(--brand-gold)" }}>TRADER</span>
        </p>
        <p className="mt-1.5 text-center text-sm" style={{ color: "var(--muted)" }}>
          Sign in to continue
        </p>

        <label className={`${label} mt-7`} style={{ color: "var(--faint)" }}>
          User ID
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required className={input} style={field} />
        </label>
        <label className={label} style={{ color: "var(--faint)" }}>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className={input} style={field} />
        </label>

        {error && (
          <p className="mt-4 rounded-md px-3 py-2 text-xs" style={{ background: "color-mix(in srgb, var(--negative) 12%, transparent)", color: "var(--negative)" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="mt-6 w-full rounded-md px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Shell>
  );
}

export default function AuthGate({ children }) {
  // undefined = still checking, null = logged out, object = logged in
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    onUnauthorized = () => setUser(null);
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { user: null }))
      .then((body) => setUser(body.user || null))
      .catch(() => setUser(null));
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  };

  if (user === undefined) {
    return (
      <Shell>
        <span className="text-sm" style={{ color: "var(--faint)" }}>
          Loading…
        </span>
      </Shell>
    );
  }
  if (!user) return <LoginPage onLogin={setUser} />;

  return <AuthContext.Provider value={{ user, setUser, logout }}>{children}</AuthContext.Provider>;
}
