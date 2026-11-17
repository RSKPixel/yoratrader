import { useEffect, useRef, useState } from "react";
import { useSetting } from "./settings";
import { STATUS, statusOf, useModelStatuses } from "./modelStatus";

// The v2 side nav, used by Backtesting and Paper trading: a rail of short codes. On wide screens,
// hovering the rail slides the full list (grouped by source) out over the page, and moving the mouse
// away (or picking a model) folds it back; the page itself never moves. On narrow screens a tap on the
// rail's arrow opens the list over the page. The pin keeps the list open beside the page (saved per
// user, per nav).

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

// group heading colours: intraday teal, positional gold, archived grey
const GROUP_COLOR = { Intraday: "var(--accent)", Positional: "var(--brand-gold)", Archived: "var(--faint)" };

function GroupTitle({ title, children }) {
  const color = GROUP_COLOR[title] || "var(--faint)";
  return (
    <span className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em]" style={{ color }}>
      <span className="h-3 w-0.5 rounded-full" style={{ background: color }} aria-hidden="true" />
      {children || title}
    </span>
  );
}

function Dot({ status }) {
  if (status !== "testing" && status !== "live") return null;
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS[status].color }} title={STATUS[status].label} aria-hidden="true" />;
}

function Rail({ groups, title, current, item, onToggle, statuses = {} }) {
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
          <span className={`${i > 0 ? "mt-1" : ""} mb-1 h-0.5 w-6 rounded-full`} style={{ background: GROUP_COLOR[g.title] || "var(--border)" }} title={g.title} aria-hidden="true" />
          {g.models.map((m) => {
            const active = m.id === current;
            return (
              <a
                key={m.id}
                {...item(m, active)}
                title={`${m.label} · ${m.author} · ${m.style} · ${STATUS[statusOf(statuses, m.id)].label}`}
                className="relative grid h-8 w-8 place-items-center rounded-md text-[0.6875rem] font-semibold transition-colors hover:bg-[var(--surface-2)]"
                style={active ? { background: "var(--accent-soft)", color: "var(--accent)" } : { color: "var(--muted)" }}
              >
                {m.short}
                <span className="absolute right-0.5 top-0.5">
                  <Dot status={statusOf(statuses, m.id)} />
                </span>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function PinIcon({ on }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5zM12 14v6" strokeLinejoin="round" />
    </svg>
  );
}

function List({ groups, title, current, item, onClose, closeLabel, pinned, onPin, statuses = {}, archived = [] }) {
  const [showArchived, setShowArchived] = useState(false); // closed until opened
  return (
    <nav className="flex h-full w-80 flex-col overflow-y-auto border-r" style={{ borderColor: "var(--border)", background: "var(--surface)" }} aria-label={title}>
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
          {title}
        </span>
        <span className="flex items-center gap-1">
        {onPin && (
          <button
            type="button"
            onClick={onPin}
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--surface-2)]"
            style={{ color: pinned ? "var(--accent)" : "var(--muted)" }}
            aria-label={pinned ? "Unpin the list" : "Pin the list open"}
            aria-pressed={pinned}
            title={pinned ? "Unpin: open on hover" : "Pin: keep the list open"}
          >
            <PinIcon on={pinned} />
          </button>
        )}
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
        </span>
      </div>
      <div className="flex flex-col gap-4 px-3 pb-4 pt-2">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="px-2">
              <GroupTitle title={g.title} />
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
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{m.label}</span>
                        <Dot status={statusOf(statuses, m.id)} />
                      </span>
                      <span className="truncate text-[0.6875rem] font-normal" style={{ color: "var(--faint)" }} title={m.source}>
                        {m.author}
                      </span>
                    </span>
                  </a>
                );
              })}
            </div>
          </div>
        ))}
        {archived.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="px-2" aria-expanded={showArchived}>
              <GroupTitle title="Archived">
                {showArchived ? "▾" : "▸"} Archived ({archived.length})
              </GroupTitle>
            </button>
            {showArchived && (
              <div className="mt-1.5 flex flex-col gap-0.5">
                {archived.map((m) => {
                  const active = m.id === current;
                  return (
                    <a
                      key={m.id}
                      {...item(m, active)}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--surface-2)]"
                      style={active ? { background: "var(--accent-soft)", color: "var(--accent)" } : { color: "var(--muted)" }}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{m.label}</span>
                        <span className="truncate text-[0.6875rem]" style={{ color: "var(--faint)" }}>
                          {m.author}
                        </span>
                      </span>
                      <StyleTag style={m.style} active={active} />
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

export function SideNav({ groups: allGroups, base, title, current, onSelect, open, onToggle, pinKey = "nav" }) {
  const wide = useWide();
  const statuses = useModelStatuses();
  // archived models leave their groups for an "Archived" section at the bottom (the rail hides them)
  // listed by style (Intraday, then Positional), each model with its author; archived ones at the bottom
  // a group can put its models in their own section (section: "Options positional") instead of by style
  const every = allGroups.flatMap((g) => g.models.map((m) => ({ ...m, author: g.title, source: g.source, section: m.section || g.section || m.style })));
  const archived = every.filter((m) => statusOf(statuses, m.id) === "archived");
  const groups = ["Intraday", "Positional", "Options positional"]
    .map((section) => ({ title: section, models: every.filter((m) => m.section === section && statusOf(statuses, m.id) !== "archived") }))
    .filter((g) => g.models.length);
  const [pinned, setPinned] = useSetting(`nav.pinned.${pinKey}`, false);
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
  if (wide && pinned) {
    // pinned: the list stays open beside the page
    return (
      <div className="h-full shrink-0">
        <List groups={groups} title={title} current={current} item={item} pinned onPin={() => setPinned(false)} statuses={statuses} archived={archived} />
      </div>
    );
  }
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
        <Rail groups={groups} title={title} current={current} item={item} statuses={statuses} />
        {hover && (
          <div className="absolute inset-y-0 left-0 z-30 shadow-2xl">
            <List
              groups={groups}
              title={title}
              current={current}
              item={item}
              statuses={statuses}
              archived={archived}
              pinned={false}
              onPin={() => {
                setPinned(true);
                setHover(false);
              }}
            />
          </div>
        )}
      </div>
    );
  }
  if (!open) return <Rail groups={groups} title={title} current={current} item={item} onToggle={onToggle} statuses={statuses} />;
  return (
    <>
      <button type="button" className="fixed inset-0 z-10 bg-black/40" onClick={onToggle} aria-label="Close the model list" />
      <div className="absolute inset-y-0 left-0 z-20">
        <List groups={groups} title={title} current={current} item={item} onClose={onToggle} closeLabel="Collapse the model list" statuses={statuses} archived={archived} />
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
