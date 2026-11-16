import { useSetting } from "./settings";
import { useState } from "react";

// The v2 side nav: a collapsible list of models grouped by source (full list, or a rail of short
// codes), remembered per browser. Used by Backtesting and Paper trading.

export function StyleTag({ style, active }) {
  const intraday = style === "Intraday";
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-[0.08em]"
      style={{
        background: active ? "var(--surface)" : "var(--surface-2)",
        color: intraday ? "var(--accent)" : "var(--muted)",
      }}
    >
      {intraday ? "Intraday" : "Positional"}
    </span>
  );
}


function Chevron({ left }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {left ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

export function SideNav({ groups, base, title, current, onSelect, open, onToggle }) {
  const item = (m, active) => ({
    href: `${base}/${m.id}`,
    onClick: (event) => {
      event.preventDefault();
      onSelect(m.id);
    },
    "aria-current": active ? "page" : undefined,
  });
  if (!open) {
    return (
      <nav
        className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-3"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        aria-label={title}
      >
        <button
          type="button"
          onClick={onToggle}
          className="mb-2 grid h-8 w-8 place-items-center rounded-md hover:bg-[var(--surface-2)]"
          style={{ color: "var(--muted)" }}
          aria-label="Show the model list"
          title="Show the model list"
        >
          <Chevron />
        </button>
        {groups.map((g, i) => (
          <div key={g.title} className="flex flex-col items-center gap-1">
            {i > 0 && <span className="my-1 h-px w-6" style={{ background: "var(--border)" }} aria-hidden="true" />}
            {g.models.map((m) => {
              const active = m.id === current;
              return (
                <a
                  key={m.id}
                  {...item(m, active)}
                  title={`${m.label} · ${m.style} (${g.title})`}
                  className="grid h-8 w-8 place-items-center rounded-md text-[0.6875rem] font-semibold transition-colors hover:bg-[var(--surface-2)]"
                  style={active ? { background: "var(--accent-soft)", color: "var(--accent)" } : { color: "var(--muted)" }}
                >
                  {m.short}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
    );
  }
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-10 bg-black/40 md:hidden"
        onClick={onToggle}
        aria-label="Close the model list"
      />
      <nav
        className="absolute inset-y-0 left-0 z-20 flex w-80 shrink-0 flex-col overflow-y-auto border-r md:static md:z-auto"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        aria-label={title}
      >
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onToggle}
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--surface-2)]"
            style={{ color: "var(--muted)" }}
            aria-label="Collapse the model list"
            title="Collapse"
          >
            <Chevron left />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-3 pb-4 pt-2">
          {groups.map((g) => (
            <div key={g.title}>
              <p className="px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--faint)" }} title={g.source}>
                {g.title}
              </p>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {g.models.map((m) => {
                  const active = m.id === current;
                  return (
                    <a
                      key={m.id}
                      {...item(m, active)}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)]"
                      style={active ? { background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 500 } : { color: "var(--text)" }}
                    >
                      <span className="truncate">{m.label}</span>
                      <StyleTag style={m.style} active={active} />
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}

// Open / closed, saved per user under `key`; narrow screens start closed and close after a pick.
export function useSideNav(key, onSelect) {
  // wide screens: the user's saved choice (on the server); narrow screens: closed to start, not saved
  const [saved, setSaved] = useSetting(`nav.${key}`, null);
  const wide = window.matchMedia?.("(min-width: 768px)").matches ?? true;
  const [narrowOpen, setNarrowOpen] = useState(false);
  const open = wide ? saved ?? true : narrowOpen;
  const toggle = () => (wide ? setSaved(!open) : setNarrowOpen(!open));
  const select = (id) => {
    onSelect(id);
    if (!wide) setNarrowOpen(false);
  };
  return { open, toggle, select };
}
