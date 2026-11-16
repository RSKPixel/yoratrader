import { useEffect, useRef, useState } from "react";

// The v2 side nav, used by Backtesting and Paper trading: a rail of short codes. On wide screens,
// hovering the rail slides the full list (grouped by source) out over the page, and moving the mouse
// away (or picking a model) folds it back; the page itself never moves. On narrow screens a tap on the
// rail's arrow opens the list over the page.

function useWide() {
  const query = "(min-width: 768px)";
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return undefined;
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

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

function Rail({ groups, title, current, item, onToggle }) {
  return (
    <nav
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-3"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      aria-label={title}
    >
      {onToggle ? (
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
      ) : (
        <span className="mb-2 grid h-8 w-8 place-items-center" style={{ color: "var(--faint)" }} aria-hidden="true">
          <Chevron />
        </span>
      )}
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

function List({ groups, title, current, item, onClose, closeLabel }) {
  return (
    <nav className="flex h-full w-80 flex-col overflow-y-auto border-r" style={{ borderColor: "var(--border)", background: "var(--surface)" }} aria-label={title}>
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
          {title}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--surface-2)]"
            style={{ color: "var(--muted)" }}
            aria-label={closeLabel}
            title="Collapse"
          >
            <Chevron left />
          </button>
        )}
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
  );
}

export function SideNav({ groups, base, title, current, onSelect, open, onToggle }) {
  const wide = useWide();
  const [hover, setHover] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const item = (m, active) => ({
    href: `${base}/${m.id}`,
    onClick: (event) => {
      event.preventDefault();
      setHover(false);
      onSelect(m.id);
    },
    "aria-current": active ? "page" : undefined,
  });
  if (wide) {
    // the rail keeps its 48px in the layout; the list opens over the page on hover
    return (
      <div
        className="relative h-full w-12 shrink-0"
        onMouseEnter={() => {
          clearTimeout(timer.current);
          setHover(true);
        }}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setHover(false), 150); // a short grace, so a slip past the edge doesn't close it
        }}
      >
        <Rail groups={groups} title={title} current={current} item={item} />
        {hover && (
          <div className="absolute inset-y-0 left-0 z-30 shadow-2xl">
            <List groups={groups} title={title} current={current} item={item} />
          </div>
        )}
      </div>
    );
  }
  if (!open) return <Rail groups={groups} title={title} current={current} item={item} onToggle={onToggle} />;
  return (
    <>
      <button type="button" className="fixed inset-0 z-10 bg-black/40" onClick={onToggle} aria-label="Close the model list" />
      <div className="absolute inset-y-0 left-0 z-20">
        <List groups={groups} title={title} current={current} item={item} onClose={onToggle} closeLabel="Collapse the model list" />
      </div>
    </>
  );
}

// Narrow screens: the list's open / closed state (closed to start, closed again after a pick). Wide
// screens open it on hover, inside SideNav.
export function useSideNav(_key, onSelect) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);
  const select = (id) => {
    onSelect(id);
    setOpen(false);
  };
  return { open, toggle, select };
}
