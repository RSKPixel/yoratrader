// v2 form controls, styled from the theme tokens.

export function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border p-0.5" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
      {options.map(([v, text, disabled, hint]) => {
        const active = v === value && !disabled;
        return (
          <button
            key={String(v)}
            type="button"
            onClick={() => !disabled && onChange(v)}
            aria-pressed={active}
            disabled={disabled}
            title={hint}
            className="rounded px-2.5 py-1 text-sm transition-colors disabled:cursor-not-allowed"
            style={
              active
                ? { background: "var(--surface)", color: "var(--text)", boxShadow: "0 1px 2px rgba(0,0,0,0.15)" }
                : { color: disabled ? "var(--faint)" : "var(--muted)", opacity: disabled ? 0.45 : 1 }
            }
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }} title={hint}>
        {label}
      </span>
      {children}
    </div>
  );
}

export const inputStyle = { borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text)" };

export function formatRs(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 1 : 2).replace(/\.0+$/, "")} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 1 : 2).replace(/\.0+$/, "")} L`;
  return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
}
