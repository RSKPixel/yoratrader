"""Cross-sectional mean reversion paper trading: the backtest's "intraday-0915-top5" book, live.

- record_open(): at 09:15:01 one quote call for every F&O stock. Signal = today's open / previous
  close - 1 (moves over 20% left out, as in the backtest); deviation = signal - the average signal.
  The 5 lowest deviations are bought and the 5 highest sold, equal rupees each (10% of gross
  exposure per stock). The open is the entry; the last price at the snapshot (if taken by 09:15:30)
  is stored as the live fill.
- finalize(): after 15:15, exit at the close of the 15:00 candle (the backtest's 15:15 price).

Runs from gapwatch's production scheduler, right after buy-on-gap's recording. Nothing here
places orders.
"""

import time
from datetime import datetime
from datetime import time as clock

from psycopg2.extras import execute_values

import backtest
import gapwatch
import kite_auth
import xsmr
from db import connect, stored_lot_sizes

IST = backtest.IST
PER_SIDE = 5
WEIGHT = 0.5 / PER_SIDE  # share of gross exposure per stock
BACKTEST_VARIANT = "intraday-0915-top5"


def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS xsmr_paper (
            day DATE NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            rank INTEGER NOT NULL,             -- 1 = furthest from the average on its side
            prev_close DOUBLE PRECISION NOT NULL,
            entry DOUBLE PRECISION NOT NULL,   -- the 09:15 open
            signal_pct DOUBLE PRECISION NOT NULL,
            dev_pct DOUBLE PRECISION NOT NULL,
            entry_live DOUBLE PRECISION, live_at TIME,
            exit DOUBLE PRECISION, exit_reason TEXT,
            ret DOUBLE PRECISION, ret_live DOUBLE PRECISION,  -- signed return of the position
            status TEXT NOT NULL DEFAULT 'open',
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            closed_at TIMESTAMPTZ,
            PRIMARY KEY (day, symbol)
        );
        CREATE TABLE IF NOT EXISTS xsmr_paper_days (
            day DATE PRIMARY KEY,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            quoted INTEGER NOT NULL,
            mean_signal_pct DOUBLE PRECISION
        );
        """
    )


def record_open(force=False):
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or now.time() < gapwatch.OPEN_AT:
        return {"recorded": False, "reason": "market not open yet"}
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT 1 FROM xsmr_paper_days WHERE day = %s", (today,))
        if cursor.fetchone() and not force:
            return {"recorded": False, "reason": "already recorded"}
    kite = kite_auth.trading_client()
    quotes = gapwatch._quotes(kite, gapwatch._symbols())
    snap = gapwatch._now()
    live_ok = snap.time() <= gapwatch.LIVE_FILL_BY
    stocks = []
    for symbol, q in quotes.items():
        traded = q.get("last_trade_time")
        ohlc = q.get("ohlc") or {}
        opened, prev = float(ohlc.get("open") or 0), float(ohlc.get("close") or 0)
        if not traded or traded.date() != today or opened <= 0 or prev <= 0:
            continue
        signal = opened / prev - 1
        if abs(signal) > xsmr.MAX_MOVE:
            continue
        stocks.append({"symbol": symbol, "prev": prev, "open": opened, "signal": signal,
                       "live": float(q.get("last_price") or 0) if live_ok else 0})
    if len(stocks) < xsmr.MIN_STOCKS:
        if now.time() < clock(10, 0) and not force:
            return {"recorded": False, "reason": "no opening prices yet"}
        picks, mean = [], None  # a holiday: record the day so the scheduler stops retrying
    else:
        mean = sum(s["signal"] for s in stocks) / len(stocks)
        ordered = sorted(stocks, key=lambda s: s["signal"])
        picks = [("long", i + 1, s) for i, s in enumerate(ordered[:PER_SIDE])]
        picks += [("short", i + 1, s) for i, s in enumerate(reversed(ordered[-PER_SIDE:]))]
    rows = [(today, s["symbol"], side, rank, s["prev"], s["open"], round(100 * s["signal"], 3),
             round(100 * (s["signal"] - mean), 3), s["live"] or None,
             snap.time().replace(microsecond=0) if s["live"] else None) for side, rank, s in picks]
    with connect() as conn, conn.cursor() as cursor:
        if rows:
            execute_values(cursor, "INSERT INTO xsmr_paper (day, symbol, side, rank, prev_close, entry, signal_pct, dev_pct, "
                                   "entry_live, live_at) VALUES %s ON CONFLICT DO NOTHING", rows)
        cursor.execute("INSERT INTO xsmr_paper_days (day, quoted, mean_signal_pct) VALUES (%s, %s, %s) ON CONFLICT (day) "
                       "DO UPDATE SET recorded_at = now(), quoted = EXCLUDED.quoted, mean_signal_pct = EXCLUDED.mean_signal_pct",
                       (today, len(stocks), round(100 * mean, 3) if mean is not None else None))
        conn.commit()
    return {"recorded": True, "quoted": len(stocks), "picks": len(rows), "snapshot": snap.strftime("%H:%M:%S"),
            "live_fill": live_ok}


def finalize():
    """Close every open position whose day has passed 15:15 at the close of the 15:00 candle."""
    now = gapwatch._now()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT day, symbol, side, entry, entry_live FROM xsmr_paper WHERE status = 'open' ORDER BY day")
        pending = [r for r in cursor.fetchall() if r[0] < now.date() or now.time() >= gapwatch.EXIT_AT]
    if not pending:
        return 0
    kite = kite_auth.trading_client()
    closed = 0
    for day, symbol, side, entry, entry_live in pending:
        token = gapwatch._token(kite, symbol)
        if token is None:
            continue
        bars = kite.historical_data(token, from_date=datetime.combine(day, clock(9, 0)),
                                    to_date=datetime.combine(day, clock(15, 30)), interval="15minute")
        time.sleep(backtest.PAUSE)
        exit_bar = next((b for b in bars if b["date"].time() == clock(*backtest.GAP_EXIT_BAR)), None)
        reason = "time"
        if exit_bar is None:
            if not (day < now.date() and bars):
                continue
            exit_bar, reason = bars[-1], "session end"
        exit_px = float(exit_bar["close"])
        sign = 1 if side == "long" else -1
        ret = sign * (exit_px / entry - 1)
        ret_live = sign * (exit_px / entry_live - 1) if entry_live else None
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("UPDATE xsmr_paper SET exit = %s, exit_reason = %s, ret = %s, ret_live = %s, status = 'closed', "
                           "closed_at = now() WHERE day = %s AND symbol = %s",
                           (round(exit_px, 2), reason, ret, ret_live, day, symbol))
            conn.commit()
        closed += 1
    return closed


def paper(slippage=0.0002):
    """Today's book (live returns while open), the daily log and a summary next to the backtest."""
    now = gapwatch._now()
    cost = 2 * xsmr.cost_per_side(slippage)  # in at the open, out at 15:15: the book trades twice a day
    lots = stored_lot_sizes()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT * FROM xsmr_paper ORDER BY day DESC, side, rank")
        cols = [c.name for c in cursor.description]
        rows = [dict(zip(cols, r)) for r in cursor.fetchall()]
        cursor.execute("SELECT day, recorded_at, quoted, mean_signal_pct FROM xsmr_paper_days ORDER BY day DESC")
        days = cursor.fetchall()
    today = now.date()
    open_today = [r for r in rows if r["day"] == today and r["status"] == "open"]
    ltp_at = None
    if open_today:
        try:
            quotes = kite_auth.trading_client().ltp([f"NSE:{r['symbol']}" for r in open_today])
            ltp_at = now.strftime("%H:%M:%S")
            for r in open_today:
                q = quotes.get(f"NSE:{r['symbol']}")
                if q:
                    sign = 1 if r["side"] == "long" else -1
                    r["ltp"] = float(q["last_price"])
                    r["ret"] = sign * (r["ltp"] / r["entry"] - 1)
                    r["ret_live"] = sign * (r["ltp"] / r["entry_live"] - 1) if r["entry_live"] else None
        except Exception as error:
            print("Cross-sectional LTP failed:", error)

    by_day = {}
    for r in rows:
        r["lot_size"] = lots.get(("NSE", r["symbol"]))
        r["lot_value"] = round(r["lot_size"] * r["entry"]) if r["lot_size"] else None
        for k in ("ret", "ret_live"):
            r[f"{k}_pct"] = round(100 * r.pop(k), 3) if r.get(k) is not None else None
        r["live_at"] = r["live_at"].strftime("%H:%M:%S") if r.get("live_at") else None
        for k in ("recorded_at", "closed_at"):
            r[k] = r[k].astimezone(IST).strftime("%Y-%m-%d %H:%M") if r[k] else None
        by_day.setdefault(r["day"], []).append(r)

    log = []
    for day, recorded_at, quoted, mean_signal in days:
        picks = by_day.get(day, [])
        entry = {"day": day.isoformat(), "recorded_at": recorded_at.astimezone(IST).strftime("%H:%M:%S"), "quoted": quoted,
                 "mean_signal_pct": mean_signal, "picks": len(picks),
                 "status": "open" if any(p["status"] == "open" for p in picks) else "closed"}
        for key in ("ret_pct", "ret_live_pct"):
            vals = [p[key] for p in picks if p[key] is not None]
            full = len(vals) == len(picks) and picks
            gross = WEIGHT * sum(vals) if full else None  # % of gross exposure
            entry[f"gross{key[3:]}"] = round(gross, 3) if gross is not None else None
            entry[f"net{key[3:]}"] = round(gross - 100 * cost, 3) if gross is not None else None
        log.append(entry)

    def summary(key):
        vals = [d[key] for d in log if d[key] is not None and d["status"] == "closed"]
        if not vals:
            return None
        return {"days": len(vals), "mean_bps": round(100 * sum(vals) / len(vals), 1), "total_pct": round(sum(vals), 2),
                "win_pct": round(100 * sum(v > 0 for v in vals) / len(vals))}

    backtest_ref = None
    try:
        f = xsmr._load(BACKTEST_VARIANT, "fno", slippage)
        if not f.empty:
            recent = f[f["day"].dt.year == f["day"].iloc[-1].year]
            backtest_ref = {"all_bps": round(10000 * float(f["net_ret"].mean()), 1),
                            "year": int(f["day"].iloc[-1].year), "year_bps": round(10000 * float(recent["net_ret"].mean()), 1)}
    except Exception as error:
        print("Cross-sectional backtest reference failed:", error)

    for r in rows:
        r["day"] = r["day"].isoformat()
    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"), "today": today.isoformat(),
        "market_open": today.weekday() < 5 and clock(9, 15) <= now.time() < clock(15, 30),
        "today_recorded": bool(days and days[0][0] == today), "ltp_at": ltp_at,
        "positions": rows, "log": log, "cost_pct": round(100 * cost, 3),
        "summary": {"open": summary("net_pct"), "live": summary("net_live_pct")}, "backtest": backtest_ref,
        "per_side": PER_SIDE, "weight": WEIGHT,
    }
