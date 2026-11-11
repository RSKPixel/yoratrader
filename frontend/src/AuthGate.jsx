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

const inputClass =
  "w-full rounded-md border border-[#2c313a] bg-[#111316] px-3 py-2 text-sm text-[#e7e4dc] outline-none focus:border-[#e2c08a]/60";

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

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-md border border-[#2c313a] bg-[#181b20] p-6"
      >
        <p className="text-center text-xl font-bold tracking-[0.18em]">
          <span className="text-[#f3efe6]">YORA</span>
          <span className="text-[#e2c08a]">TRADER</span>
        </p>
        <p className="mt-1 text-center text-sm text-[#9b968c]">Sign in to continue</p>

        <label className="mt-6 block text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">
          User ID
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            className={`${inputClass} mt-1 normal-case tracking-normal`}
          />
        </label>
        <label className="mt-4 block text-xs font-medium uppercase tracking-[0.14em] text-[#6f6a62]">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className={`${inputClass} mt-1 normal-case tracking-normal`}
          />
        </label>

        {error && <p className="mt-4 font-mono text-xs text-[#f0b4b4]">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="mt-6 w-full rounded-md border border-[#e2c08a]/60 px-3 py-2 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
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
    return <div className="flex h-full items-center justify-center text-sm text-[#6f6a62]">Loading…</div>;
  }
  if (!user) return <LoginPage onLogin={setUser} />;

  return <AuthContext.Provider value={{ user, setUser, logout }}>{children}</AuthContext.Provider>;
}
