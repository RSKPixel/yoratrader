// The site's number formats (frontend/src/V2Controls.jsx, V2Dashboard.jsx)
export function formatRs(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 1 : 2).replace(/\.0+$/, "")} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 1 : 2).replace(/\.0+$/, "")} L`;
  return `${sign}₹${indian(Math.round(a))}`;
}
// 1234567 -> "12,34,567" (Indian grouping, without relying on the phone's Intl data)
export function indian(n, decimals = 0) {
  const [i, f] = Math.abs(n).toFixed(decimals).split(".");
  const last = i.slice(-3), rest = i.slice(0, -3);
  const body = (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : "") + last;
  return (n < 0 ? "-" : "") + body + (f && Number(f) ? "." + f.replace(/0+$/, "") : "");
}
export const signedRs = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${formatRs(v)}`);
export const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
export const num = (v) => (v == null ? "—" : indian(v, 2));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "2026-11-23" -> "Mon, 23 Nov"
export function shortDay(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]}, ${d} ${MONTHS[m - 1]}`;
}
// India time now: "09:41:07 · Sat, 21 Nov 2026" (seconds = false: "09:41 · …")
export function istNow(ms = Date.now(), seconds = true) {
  const t = new Date(ms + 5.5 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}${seconds ? `:${p(t.getUTCSeconds())}` : ""} · ${DAYS[t.getUTCDay()]}, ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}
