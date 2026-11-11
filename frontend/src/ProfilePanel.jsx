import { useState } from "react";
import { useAuth } from "./AuthGate";

const inputClass =
  "w-full rounded-md border border-[#2c313a] bg-[#111316] px-3 py-1.5 text-sm text-[#e7e4dc] outline-none focus:border-[#e2c08a]/60";
const labelClass = "block text-xs text-[#9b968c]";
const buttonClass =
  "rounded-md border border-[#e2c08a]/60 px-3 py-1.5 text-sm text-[#e2c08a] hover:bg-white/5 disabled:opacity-40";

async function post(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function Message({ result }) {
  if (!result) return null;
  return <p className={`font-mono text-xs ${result.ok ? "text-[#8fbf9f]" : "text-[#f0b4b4]"}`}>{result.message}</p>;
}

export default function ProfilePanel() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user.display_name || "");
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

  return (
    <section className="space-y-5 rounded-md border border-[#2c313a] bg-[#181b20] p-4">
      <div className={labelClass}>
        User ID
        <p className="mt-1 font-mono text-sm text-[#e7e4dc]">{user.username}</p>
      </div>

      <form onSubmit={saveName} className="space-y-2">
        <label className={labelClass}>
          User name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="name"
            className={`${inputClass} mt-1`}
          />
        </label>
        <button type="submit" disabled={busy !== "" || name.trim() === (user.display_name || "")} className={buttonClass}>
          {busy === "name" ? "Saving…" : "Save name"}
        </button>
        <Message result={nameResult} />
      </form>

      <form onSubmit={savePassword} className="space-y-2 border-t border-[#2c313a] pt-4">
        <p className={labelClass}>Change password</p>
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className={inputClass}
        />
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="New password (8+ characters)"
          autoComplete="new-password"
          className={inputClass}
        />
        <button type="submit" disabled={busy !== "" || !current || next.length < 8} className={buttonClass}>
          {busy === "password" ? "Saving…" : "Change password"}
        </button>
        <Message result={passwordResult} />
      </form>
    </section>
  );
}
