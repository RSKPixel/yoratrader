import { useEffect, useState } from "react";
import { TomCard } from "./V2Dashboard";

// Manual trading: models traded by hand from their own pages (real money on the Kite account, each order a click).
// Each a card; a click opens its page (/v2/manual/<model>).
export default function V2ManualLanding() {
  const [tm, setTm] = useState(null);
  useEffect(() => {
    fetch("/api/v2/trade/tom")
      .then((r) => r.json())
      .then((p) => setTm(p.status === "success" ? p.plan : { error: p.message || "failed" }))
      .catch((e) => setTm({ error: e.message }));
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }}>Manual trading</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Real money, by hand</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>Each model's own page: you place every order yourself (nothing is automatic).</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {tm ? <TomCard tm={tm} /> : <p className="text-sm" style={{ color: "var(--faint)" }}>Loading…</p>}
      </div>
    </div>
  );
}
