"""In-app alerts (no outside service): the live trading items' orders and problems, the 08:45 morning check and
the 15:35 daily summary. Shown on the site and the phone app (a bell with the unread count, and the list).

- Orders and problems come straight from the live engine's own log (live_order_log): every real order sent,
  filled, part filled, not filled, cancelled or rejected; errors (a failed run, a sale not done by its time,
  a buy not placed); skips (no price: not sold). Dry runs show as "Dry run" lines. The engine's "nothing to
  do" run lines are left out.
- The morning check (trading days, 08:45, once): Kite logged in? Each enabled item's account has the money
  it needs (Angel One's cash for C-RSI's capital; Zerodha's cash or margin for the turn of the month, only
  when its buy is today or within 2 trading days).
- The daily summary (trading days, 15:35, once): each enabled item's orders today, realized and unrealized.

app_alerts holds the morning checks and summaries (one a day each: a unique key, so a second server can't
add it twice). Read / unread: each user's alerts_seen_at setting (the newest alert seen).
"""

from datetime import datetime, time as clock, timedelta

from psycopg2.extras import Json

import gapwatch
from db import connect

MORNING_AT, MORNING_UNTIL = clock(8, 45), clock(9, 0)
SUMMARY_AT, SUMMARY_UNTIL = clock(15, 35), clock(16, 30)
SEEN_KEY = "alerts_seen_at"
DAYS = 30  # the list goes back this far


def _ensure(cursor):
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS app_alerts (
            id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL, level TEXT NOT NULL,
            title TEXT NOT NULL, lines JSONB, item_id INTEGER, key TEXT UNIQUE);
        CREATE INDEX IF NOT EXISTS app_alerts_at ON app_alerts (at DESC);
    """)


def add(kind, level, title, lines=None, item_id=None, key=None):
    """One alert (level: ok, info, warn, error). key: once only (a second call with it does nothing)."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        cursor.execute("INSERT INTO app_alerts (kind, level, title, lines, item_id, key) VALUES (%s, %s, %s, %s, %s, %s) "
                       "ON CONFLICT (key) DO NOTHING RETURNING id", (kind, level, title, Json(lines or []), item_id, key))
        made = cursor.fetchone()
        conn.commit()
    return bool(made)


def _trading_day(day):
    import v2tom
    if day.weekday() >= 5:
        return False
    holidays, _ = v2tom._holidays(day)
    return day not in holidays


def _rs(v):
    if v is None:
        return "—"
    a = abs(v)
    s = f"₹{a / 1e5:.2f} L" if a >= 1e5 else f"₹{a:,.0f}"
    return ("−" if v < 0 else "") + s


def _signed(v):
    return "—" if v is None else ("+" if v > 0 else "") + _rs(v)


# ---- the morning check ------------------------------------------------------------------------------------------

def morning_check(now=None, force=False):
    """Kite logged in, and each enabled item's money. One alert a trading day (force: again, for a test)."""
    import kite_auth
    import liveengine
    import liveitems
    import v2tom
    now = now or gapwatch._now()
    today = now.date()
    lines, bad = [], False
    kite = kite_auth.status().get("connected")
    if kite:
        lines.append(["ok", "Kite logged in"])
    else:
        bad = True
        lines.append(["error", "Kite not logged in: log in before 09:00 (every item's prices and signals come from Kite)"])
    items = [i for i in liveitems.items()["items"] if i["enabled"]]
    try:
        fx = liveengine.funds()
    except Exception as error:
        fx = {}
        lines.append(["warn", f"Funds not read: {error}"])
    plan = None
    for it in items:
        s = it["settings"] or {}
        acct = it["account"]
        f = fx.get(acct) or {"error": "not read"}
        name = it["name"]
        broker = "Zerodha" if acct == "kite" else "Angel One" if acct == "angel" else acct
        if it["model"] == "turn-of-month":
            plan = plan or v2tom.plan()
            soon = plan.get("state", "").startswith("buy") or (plan.get("days_to_buy") is not None and plan["days_to_buy"] <= 2)
            if not soon:
                lines.append(["ok", f"{name}: no buy due (next buy {plan.get('buy')})"])
                continue
            need = liveengine.tom_need(s)
            fut = s.get("instrument") == "future"
        else:
            need = s.get("capital") if s.get("price", "spot") == "spot" else None
            fut = s.get("price") == "futures"
        if f.get("error"):
            bad = True
            lines.append(["error", f"{name}: {broker} funds not read ({f['error']})"])
            continue
        have = f.get("available") if fut else f.get("cash")
        what = "margin" if fut else "cash"
        if need is None:
            lines.append(["ok", f"{name}: {broker} {what} {_rs(have)}"])
        elif have is not None and have < need:
            bad = True
            lines.append(["error", f"{name}: {broker} {what} {_rs(have)}, below the {_rs(need)} it needs"])
        else:
            lines.append(["ok", f"{name}: {broker} {what} {_rs(have)} (needs {_rs(need)})"])
    if not items:
        lines.append(["info", "No live trading item is enabled"])
    title = "Morning check: action needed" if bad else "Morning check: all good"
    key = None if force else f"morning:{today.isoformat()}"
    return add("morning", "error" if bad else "ok", title, lines, key=key)


# ---- the daily summary ------------------------------------------------------------------------------------------

def daily_summary(now=None, force=False):
    """After the 15:15 runs: each enabled item's orders today, realized and unrealized (before charges)."""
    import liveengine
    now = now or gapwatch._now()
    today = now.date()
    s = liveengine.summary()
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT item_id, event, symbol, status FROM live_order_log WHERE (at AT TIME ZONE 'Asia/Kolkata')::date = %s "
                       "AND event NOT IN ('run') ORDER BY at", (today,))
        logs = cursor.fetchall()
    lines, bad = [], False
    for it in s["items"]:
        if not it["enabled"]:
            continue
        mine = [r for r in logs if r[0] == it["id"]]
        buys = [r[2] for r in mine if r[1] == "buy" and r[3] in ("sent", "dry-run")]
        sells = [r[2] for r in mine if r[1] == "sell" and r[3] in ("sent", "dry-run")]
        problems = [r for r in mine if r[1] == "error" or r[3] == "rejected"]
        bad = bad or bool(problems)
        mode = "" if it["real"] else " (dry run)"
        did = []
        if buys:
            did.append(f"bought {', '.join(buys)}")
        if sells:
            did.append(f"sold {', '.join(sells)}")
        held = ", ".join(p["symbol"] for p in it["open"]) or "nothing"
        lines.append(["error" if problems else "info",
                      f"{it['name']}{mode}: {'; '.join(did) or 'no orders today'}"
                      f"{f' · {len(problems)} problem(s)' if problems else ''} · holding {held} · realized {_signed(it['realized_rs'])}"
                      f" · unrealized {_signed(it['unrealized_rs'])}"])
    if not lines:
        lines.append(["info", "No live trading item is enabled"])
    title = "Today's live trading: problems to check" if bad else "Today's live trading"
    key = None if force else f"summary:{today.isoformat()}"
    return add("summary", "error" if bad else "info", title, lines, key=key)


def tick():
    """Every minute (prod scheduler): the morning check and the daily summary on trading days, once each."""
    now = gapwatch._now()
    t = now.time()
    if not (MORNING_AT <= t < MORNING_UNTIL or SUMMARY_AT <= t < SUMMARY_UNTIL):
        return
    if not _trading_day(now.date()):
        return
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        kind = "morning" if t < MORNING_UNTIL else "summary"
        cursor.execute("SELECT 1 FROM app_alerts WHERE key = %s", (f"{kind}:{now.date().isoformat()}",))
        if cursor.fetchone():
            return
    (morning_check if kind == "morning" else daily_summary)(now)


# ---- the list ---------------------------------------------------------------------------------------------------

def _from_log(r):
    """An order log row as an alert, or None (the engine's routine lines)."""
    _id, at, item_id, name, broker, event, symbol, reason, status, note, order_id = r
    b = {"zerodha": "Zerodha", "angelone": "Angel One"}.get(broker, broker or "")
    what = f"{symbol or ''}".strip()
    if event == "run":
        return None
    if event == "error":
        level, title = "error", f"Problem: {name}"
    elif status == "rejected":
        level, title = "error", f"{event.capitalize()} rejected: {what}"
    elif event in ("not filled",):
        level, title = "warn", f"Not filled: {what} ({reason})"
    elif event == "stop hit":
        level, title = "warn", f"Stop hit: {what}"
    elif event == "skip":
        level, title = "warn", f"Skipped: {what}"
    elif status == "dry-run":
        level, title = "info", f"Dry run: would {event} {what}"
    elif event in ("filled", "part filled"):
        level, title = "ok", f"{event.capitalize()}: {what} ({reason})"
    elif event in ("buy", "sell") and status == "sent":
        level, title = "order", f"{event.capitalize()} order sent: {what}"
    elif event == "cancel":
        level, title = "warn", f"Order cancelled: {what} ({reason})"
    elif event == "sell queued":
        level, title = "info", f"Sale queued: {what}"
    else:
        level, title = "info", f"{event.capitalize()}: {what}"
    detail = " · ".join(x for x in (name, b, reason if event not in ("filled", "part filled", "not filled", "cancel") else None, note,
                                    f"order {order_id}" if order_id else None) if x)
    return {"id": f"log-{_id}", "at": at, "kind": "order", "level": level, "title": title, "lines": [[level, detail]] if detail else [],
            "item_id": item_id}


def feed(user_id, limit=150):
    """The newest alerts first (orders and problems, morning checks, summaries) and how many are unread."""
    import usersettings
    since = datetime.now(gapwatch.IST) - timedelta(days=DAYS)
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT id, at, kind, level, title, lines, item_id FROM app_alerts WHERE at >= %s ORDER BY at DESC LIMIT %s", (since, limit))
        mine = [{"id": f"a-{r[0]}", "at": r[1], "kind": r[2], "level": r[3], "title": r[4], "lines": r[5] or [], "item_id": r[6]}
                for r in cursor.fetchall()]
        try:
            cursor.execute("SELECT id, at, item_id, item_name, broker, event, symbol, reason, status, note, order_id FROM live_order_log "
                           "WHERE at >= %s AND event <> 'run' ORDER BY at DESC LIMIT %s", (since, limit))
            logs = [x for x in (_from_log(r) for r in cursor.fetchall()) if x]
        except Exception:
            conn.rollback()
            logs = []
    rows = sorted(mine + logs, key=lambda x: x["at"], reverse=True)[:limit]
    seen = usersettings.get_all(user_id).get(SEEN_KEY)
    seen_at = datetime.fromisoformat(seen) if seen else None
    for x in rows:
        x["unread"] = seen_at is None or x["at"] > seen_at
        x["at"] = x["at"].astimezone(gapwatch.IST).isoformat()
    unread = [x for x in rows if x["unread"]]
    return {"alerts": rows, "unread": len(unread), "unread_problems": sum(1 for x in unread if x["level"] in ("error", "warn")),
            "seen_at": seen}


def mark_seen(user_id):
    import usersettings
    usersettings.put(user_id, {SEEN_KEY: datetime.now(gapwatch.IST).isoformat()})
    return {"ok": True}
