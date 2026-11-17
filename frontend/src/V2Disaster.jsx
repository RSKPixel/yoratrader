import { Field } from "./V2Controls";

// Chan's disaster stop (backend disaster.py): wider than the worst move against any backtest position, so
// it never fires in the backtest but caps a future disaster. d: { stop_pct, worst_pct, worst_symbol,
// worst_day } (a backtest summary's "disaster"), or just pct (a paper page).
export default function DisasterStop({ d, pct }) {
  const p = d?.stop_pct ?? pct;
  const hint = d
    ? `Chan: a stop on a mean-reversion trade only lowers its backtest, but a model can stop working. So each position gets a stop wider than the worst move against any backtest position (${d.worst_pct}%: ${d.worst_symbol}, ${d.worst_day}). It never fires in the backtest; it caps a disaster.`
    : "Chan's disaster stop: wider than the worst move against any backtest position, so it never fired there; here a position is out if its day's low / high (or live price) reaches it.";
  return (
    <Field label="Disaster stop" hint={hint}>
      <span className="block py-1.5 text-sm">{p == null ? "…" : `${p}% from the entry${d ? ` · never hit (worst ${d.worst_pct}%)` : ""}`}</span>
    </Field>
  );
}
