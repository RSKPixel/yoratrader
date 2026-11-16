"""Oops gap reversal paper trading (Larry Williams; the v2 backtest's book: stop below the day's low,
any trend, the day's first N fills, N = max open, 3 by default). Run by gapwatch's production scheduler
every minute (tick()), from the open to 15:15. Nothing here places orders.

- 09:15:01 (the open is known): every F&O stock that opened below yesterday's low goes on the day's
  watchlist (oops_paper_watch), with yesterday's low from the stored daily candles.
- Every minute after: the watchlist and the open positions are quoted. A watched stock whose high of the
  day has reached yesterday's low is bought at that level (as a resting buy-stop order would fill), at
  most N a day, the earliest first; its stop is 0.1% below the day's low at that moment. An open position
  whose low of the day has gone through its stop is sold at the stop.
- 15:15:01: whatever is still open is sold at the price then.

Prices are the stocks' (one F&O lot each on the page). A buy is seen within a minute of happening.
"""

import time
from datetime import time as clock

import db
import gapwatch
import kite_auth
import v2margin
import v2paper
import xsmr
from db import connect

OPEN_AT, EXIT_AT, UNTIL = clock(9, 15, 1), clock(15, 15), clock(15, 30)
STOP_BELOW = 0.999
MAX_OPEN, MAX_OPEN_LIMIT, MAX_OPEN_KEY = 3, 10, "OOPS_PAPER_MAX_OPEN"


def max_open():
    try:
        return min(MAX_OPEN_LIMIT, max(1, int(db.get_settings([MAX_OPEN_KEY]).get(MAX_OPEN_KEY, MAX_OPEN))))
    except (TypeError, ValueError):
        return MAX_OPEN


def set_max_open(n):
    n = int(n)
    if not 1 <= n <= MAX_OPEN_LIMIT:
        raise ValueError(f"Max open must be 1 to {MAX_OPEN_LIMIT}.")
    db.set_settings({MAX_OPEN_KEY: str(n)})
    return n


def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS oops_paper_watch (
            day DATE NOT NULL, symbol TEXT NOT NULL, prev_low DOUBLE PRECISION NOT NULL, open DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (day, symbol)
        );
        CREATE TABLE IF NOT EXISTS oops_paper (
            day DATE NOT NULL, symbol TEXT NOT NULL, prev_low DOUBLE PRECISION NOT NULL, open DOUBLE PRECISION NOT NULL,
            filled_at TIMESTAMPTZ NOT NULL, entry DOUBLE PRECISION NOT NULL, low_at_fill DOUBLE PRECISION NOT NULL,
            stop DOUBLE PRECISION NOT NULL, exit_at TIMESTAMPTZ, exit DOUBLE PRECISION, reason TEXT, slots INTEGER NOT NULL,
            PRIMARY KEY (day, symbol)
        );
        CREATE TABLE IF NOT EXISTS oops_paper_days (
            day DATE PRIMARY KEY, recorded_at TIMESTAMPTZ NOT NULL, quoted INTEGER, gapped INTEGER, note TEXT
        );
        """
    )


def _prev_lows(cursor, today):
    """Yesterday's low for every F&O stock (the latest stored daily candle before today)."""
    cursor.execute(
        "SELECT DISTINCT ON (d.symbol) d.symbol, d.low FROM bt_daily d JOIN bt_symbols s ON s.symbol = d.symbol "
        "WHERE s.dataset = 'fno' AND d.day < %s AND d.day >= %s::date - 10 AND d.low > 0 ORDER BY d.symbol, d.day DESC",
        (today, today))
    return dict(cursor.fetchall())


def _record_open(kite, today, stamp):
    """09:15:01: the watchlist, every stock that opened below yesterday's low."""
    with connect() as conn, conn.cursor() as cursor:
        lows = _prev_lows(cursor, today)
    quotes = gapwatch._quotes(kite, list(lows))
    traded = sum(1 for q in quotes.values() if q.get("last_trade_time") and q["last_trade_time"].date() == today)
    watch = []
    for s, q in quotes.items():
        o = (q.get("ohlc") or {}).get("open")
        if o and s in lows and o < lows[s]:
            watch.append((today, s, float(lows[s]), float(o)))
    note = None if traded >= 0.5 * max(1, len(quotes)) else f"market closed (only {traded} of {len(quotes)} stocks traded today)"
    with connect() as conn, conn.cursor() as cursor:
        if watch and not note:
            cursor.executemany("INSERT INTO oops_paper_watch (day, symbol, prev_low, open) VALUES (%s, %s, %s, %s) "
                               "ON CONFLICT (day, symbol) DO NOTHING", watch)
        cursor.execute("INSERT INTO oops_paper_days (day, recorded_at, quoted, gapped, note) VALUES (%s, %s, %s, %s, %s) "
                       "ON CONFLICT (day) DO NOTHING", (today, stamp, len(quotes), 0 if note else len(watch), note))
        conn.commit()
    return {"gapped": 0 if note else len(watch), "note": note}


def tick(force=False):
    """One minute of the day: the open's watchlist once, then fills, stops and the 15:15 exit."""
    now = gapwatch._now()
    today, t = now.date(), now.time()
    if today.weekday() >= 5 or not (OPEN_AT <= t < UNTIL or force):
        return {"done": False}
    kite = kite_auth.trading_client()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT note FROM oops_paper_days WHERE day = %s", (today,))
        day = cursor.fetchone()
    out = {}
    if day is None:
        out["open"] = _record_open(kite, today, now)
        day = (out["open"]["note"],)
    if day[0]:  # market closed
        return {"done": False, "reason": day[0]}
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol, prev_low, open FROM oops_paper_watch WHERE day = %s", (today,))
        watch = {s: (pl, o) for s, pl, o in cursor.fetchall()}
        cursor.execute("SELECT symbol, stop FROM oops_paper WHERE day = %s AND exit_at IS NULL", (today,))
        held = dict(cursor.fetchall())
        cursor.execute("SELECT symbol FROM oops_paper WHERE day = %s", (today,))
        bought = {r[0] for r in cursor.fetchall()}
    waiting = [s for s in watch if s not in bought]
    if not waiting and not held:
        return {**out, "done": True}
    quotes = gapwatch._quotes(kite, sorted(set(waiting) | set(held)))
    stamp = gapwatch._now()
    exits, fills = [], []
    for s, stop in held.items():
        q = quotes.get(s) or {}
        low, ltp = (q.get("ohlc") or {}).get("low"), q.get("last_price")
        if low is not None and low <= stop:
            exits.append((stamp, float(stop), "stop", today, s))
        elif t >= EXIT_AT and ltp:
            exits.append((stamp, float(ltp), "15:15", today, s))
    slots = max_open()
    free = slots - len(bought)
    if t < EXIT_AT and free > 0:
        cands = []
        for s in waiting:
            q = quotes.get(s) or {}
            high, low = (q.get("ohlc") or {}).get("high"), (q.get("ohlc") or {}).get("low")
            pl, o = watch[s]
            if high is not None and high >= pl:
                cands.append((pl / o - 1, s, pl, o, float(low)))
        for _, s, pl, o, low in sorted(cands)[:free]:  # several at once: the smallest gap first
            fills.append((today, s, pl, o, stamp, pl, low, low * STOP_BELOW, slots))
    with connect() as conn, conn.cursor() as cursor:
        if fills:
            cursor.executemany("INSERT INTO oops_paper (day, symbol, prev_low, open, filled_at, entry, low_at_fill, stop, slots) "
                               "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day, symbol) DO NOTHING", fills)
        if exits:
            cursor.executemany("UPDATE oops_paper SET exit_at = %s, exit = %s, reason = %s WHERE day = %s AND symbol = %s AND exit_at IS NULL",
                               exits)
        conn.commit()
    if fills or exits:
        out.update(bought=[f[1] for f in fills], sold=[(e[4], e[2]) for e in exits])
    return {**out, "done": True}


def paper(slippage=0.0002):
    """The log in the paper pages' shape: days, each with its positions (one lot each, live prices for
    today's open ones), the watchlist, and the totals."""
    cps = xsmr.cost_per_side(slippage)
    now = gapwatch._now()
    today = now.date()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT day, symbol, prev_low, open, filled_at, entry, low_at_fill, stop, exit_at, exit, reason, slots "
                       "FROM oops_paper ORDER BY day DESC, filled_at")
        trades = cursor.fetchall()
        cursor.execute("SELECT day, recorded_at, quoted, gapped, note FROM oops_paper_days ORDER BY day DESC LIMIT 60")
        day_rows = cursor.fetchall()
        cursor.execute("SELECT symbol, prev_low, open FROM oops_paper_watch WHERE day = %s ORDER BY symbol", (today,))
        watch = cursor.fetchall()
    live = {}
    open_today = [r[1] for r in trades if r[0] == today and r[8] is None]
    want = sorted(set(open_today) | {w[0] for w in watch})
    ltp_at = None
    if want and kite_auth.status().get("connected"):
        try:
            q = kite_auth.trading_client().quote([f"NSE:{s}" for s in want])
            live = {k.split(":", 1)[1]: v for k, v in q.items()}
            ltp_at = gapwatch._now().strftime("%H:%M:%S")
        except Exception as error:
            print("Oops paper: live prices failed:", error)
    lots = v2margin.table()
    by_day = {}
    for day, s, pl, o, filled_at, entry, low_fill, stop, exit_at, exit_, reason, slots in trades:
        closed = exit_at is not None
        px = exit_ if closed else (live.get(s) or {}).get("last_price")
        w = 1.0 / slots
        ret = px / entry - 1 if px else None
        cost = (1 + (px / entry if px else 1)) * cps
        by_day.setdefault(day.isoformat(), []).append({
            "symbol": s, "side": "long", "gap_pct": round(100 * (o / pl - 1), 2), "prev_low": round(pl, 2), "open": round(o, 2),
            "filled_at": filled_at.astimezone(gapwatch.IST).strftime("%H:%M:%S"), "entry": round(entry, 2), "stop": round(stop, 2),
            "entry_at": f"{day.isoformat()} {filled_at.astimezone(gapwatch.IST).strftime('%H:%M:%S')}",
            "exit_at": f"{day.isoformat()} {exit_at.astimezone(gapwatch.IST).strftime('%H:%M:%S')}" if exit_at else f"{day.isoformat()} open",
            "exit": round(px, 2) if px else None, "reason": reason or ("live" if px else "open"), "closed": closed,
            "exit_at": exit_at.astimezone(gapwatch.IST).strftime("%H:%M:%S") if exit_at else None,
            "weight_pct": round(100 * w, 3), "ret_pct": round(100 * ret, 3) if ret is not None else None,
            "net_pct": round(100 * (ret - cost), 3) if ret is not None else None,
            "book_net_pct": round(100 * w * (ret - cost), 4) if ret is not None else 0.0, "book_cost_pct": round(100 * w * cost, 4)})
    days = []
    for day, rows in sorted(by_day.items(), reverse=True):
        status = "closed" if all(r["closed"] for r in rows) else "open"
        days.append({"day": day, "status": status, "picks": rows, "net_pct": round(sum(r["book_net_pct"] for r in rows), 4),
                     **v2paper._lots(rows, lots, cps)})
    held = {r["symbol"] for d in days if d["day"] == today.isoformat() for r in d["picks"]}
    watchlist = [{"symbol": s, "prev_low": round(pl, 2), "open": round(o, 2), "gap_pct": round(100 * (o / pl - 1), 2),
                  "ltp": (live.get(s) or {}).get("last_price"), "high": ((live.get(s) or {}).get("ohlc") or {}).get("high"),
                  "to_trigger_pct": round(100 * (pl / live[s]["last_price"] - 1), 2) if (live.get(s) or {}).get("last_price") else None,
                  "bought": s in held}
                 for s, pl, o in watch]
    return {"now": now.strftime("%Y-%m-%d %H:%M:%S"), "today": today.isoformat(), "ltp_at": ltp_at,
            "market_open": today.weekday() < 5 and OPEN_AT <= now.time() < UNTIL, "max_open": max_open(), "max_open_limit": MAX_OPEN_LIMIT,
            "watchlist": sorted(watchlist, key=lambda w: (w["bought"], w["to_trigger_pct"] if w["to_trigger_pct"] is not None else 99)),
            "days": days, "summary": {**v2paper._summary(days), **v2paper._lot_summary(days, lots)},
            "log": [{"day": d.isoformat(), "recorded_at": r.astimezone(gapwatch.IST).strftime("%H:%M:%S"), "quoted": q, "gapped": g, "note": n}
                    for d, r, q, g, n in day_rows],
            "cost_per_side_bps": round(10000 * cps, 2)}
