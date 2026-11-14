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


# ---------------------------------------------------------------------------------------------
# Pre-open test (futures). Since 8 Dec 2025 NSE runs a call auction for current-month futures
# (orders 09:00-09:08, matched by ~09:12); a market order placed in it fills at the auction price,
# i.e. the futures open. The plan being tested: at ~09:06 read the futures' indicative prices,
# pick the stocks from them, and order inside the auction, so the fill is the 09:15 open itself.
# (Equity's pre-open order entry closes at a random moment between 09:07 and 09:08, so 09:06 is
# the last snapshot an order could safely follow; 09:07 is recorded for comparison only.)
#
# Every F&O stock's current-month future is quoted at 09:06, 09:07 and just after 09:15 (the
# open is known then). The picks are worked out on the page from the stored signals, for any
# take. Exits: the futures' 15:15 price (close of the 15:00 candle). Nothing places orders.
# What Kite reports during the auction is unverified, so the raw quote fields are kept too.
# ---------------------------------------------------------------------------------------------

PREOPEN_SNAPS = {"0906": clock(9, 6), "0907": clock(9, 7)}
PREOPEN_TAKES = (3, 5)
_futures = {"day": None, "map": {}}


def _ensure_preopen_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS xsmr_preopen_quotes (
            day DATE NOT NULL,
            snap TEXT NOT NULL,                -- '0906', '0907' (auction, indicative) or '0915' (after the open)
            symbol TEXT NOT NULL,              -- the stock
            fut TEXT NOT NULL,                 -- its current-month future
            price DOUBLE PRECISION,            -- last_price at the snapshot (indicative price in the auction, if Kite shows it)
            prev_close DOUBLE PRECISION,       -- previous futures close (ohlc.close)
            open DOUBLE PRECISION,             -- ohlc.open (the auction price, once known)
            bid DOUBLE PRECISION, ask DOUBLE PRECISION, volume BIGINT,
            last_trade_time TIMESTAMP,
            taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (day, snap, symbol)
        );
        CREATE TABLE IF NOT EXISTS xsmr_preopen_trades (
            day DATE NOT NULL, symbol TEXT NOT NULL, fut TEXT NOT NULL, token BIGINT,
            entry DOUBLE PRECISION,            -- futures open (the auction price)
            exit DOUBLE PRECISION, exit_reason TEXT, closed_at TIMESTAMPTZ,
            PRIMARY KEY (day, symbol)
        );
        """
    )


def _current_futures(kite, today):
    """{stock: (future tradingsymbol, token)}: the nearest current-month future of each F&O stock."""
    if _futures["day"] != today:
        stocks = set(gapwatch._symbols())
        best = {}
        for r in kite.instruments("NFO"):
            if r["instrument_type"] != "FUT" or r["name"] not in stocks or r["expiry"] < today:
                continue
            if r["name"] not in best or r["expiry"] < best[r["name"]]["expiry"]:
                best[r["name"]] = r
        _futures["day"], _futures["map"] = today, {k: (v["tradingsymbol"], v["instrument_token"]) for k, v in best.items()}
    return _futures["map"]


def _snapshot(kite, today, snap):
    futs = _current_futures(kite, today)
    by_fut = {fut: stock for stock, (fut, _) in futs.items()}
    keys = [f"NFO:{fut}" for fut in by_fut]
    quotes = {}
    for i in range(0, len(keys), 400):
        quotes.update(kite.quote(keys[i:i + 400]))
    rows = []
    for key, q in quotes.items():
        fut = key.split(":", 1)[1]
        ohlc, depth = q.get("ohlc") or {}, q.get("depth") or {}
        bid = (depth.get("buy") or [{}])[0].get("price")
        ask = (depth.get("sell") or [{}])[0].get("price")
        ltt = q.get("last_trade_time")
        rows.append((today, snap, by_fut[fut], fut, q.get("last_price") or None, ohlc.get("close") or None,
                     ohlc.get("open") or None, bid or None, ask or None, q.get("volume"),
                     ltt.replace(tzinfo=None) if ltt else None))
    with connect() as conn, conn.cursor() as cursor:
        execute_values(cursor, "INSERT INTO xsmr_preopen_quotes (day, snap, symbol, fut, price, prev_close, open, bid, ask, "
                               "volume, last_trade_time) VALUES %s ON CONFLICT (day, snap, symbol) DO NOTHING", rows)
        conn.commit()
    return rows


def _snapped(today, snap):
    with connect() as conn, conn.cursor() as cursor:
        _ensure_preopen_tables(cursor)
        conn.commit()
        cursor.execute("SELECT 1 FROM xsmr_preopen_quotes WHERE day = %s AND snap = %s LIMIT 1", (today, snap))
        return cursor.fetchone() is not None


def record_preopen():
    """09:06 and 09:07: one quote call for every current-month stock future, during the auction."""
    now = gapwatch._now()
    today = now.date()
    for snap, at in PREOPEN_SNAPS.items():
        if at <= now.time() < clock(at.hour, at.minute + 1) and not _snapped(today, snap):
            rows = _snapshot(kite_auth.trading_client(), today, snap)
            return {"recorded": snap, "quoted": len(rows)}
    return {"recorded": None}


def _signals(rows, use_open=False):
    """{stock: signal} from snapshot rows (dicts): price (or open) / previous futures close - 1."""
    out = {}
    for r in rows:
        px = r["open"] if use_open else r["price"]
        if px and r["prev_close"] and abs(px / r["prev_close"] - 1) <= xsmr.MAX_MOVE:
            out[r["symbol"]] = px / r["prev_close"] - 1
    return out if len(out) >= xsmr.MIN_STOCKS else {}


def _picks(signals, n):
    """{stock: 'long'/'short'}: the n lowest and n highest signals (= deviations from the mean)."""
    ordered = sorted(signals, key=signals.get)
    if len(ordered) < 2 * n:
        return {}
    return {**{s: "long" for s in ordered[:n]}, **{s: "short" for s in ordered[-n:]}}


def _snap_rows(cursor, day=None):
    cursor.execute("SELECT * FROM xsmr_preopen_quotes" + (" WHERE day = %s" if day else "") + " ORDER BY day, snap, symbol",
                   (day,) if day else None)
    cols = [c.name for c in cursor.description]
    return [dict(zip(cols, r)) for r in cursor.fetchall()]


def record_preopen_open(force=False):
    """Just after 09:15: the futures open for every stock, and a trade row (entry = futures open)
    for every stock any of the tested picks would hold (09:06 / 09:07 / open-based, up to 5 + 5)."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or now.time() < gapwatch.OPEN_AT:
        return {"recorded": False}
    if _snapped(today, "0915") and not force:
        return {"recorded": False, "reason": "already recorded"}
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM xsmr_preopen_quotes WHERE day = %s AND snap IN ('0906', '0907')", (today,))
        if cursor.fetchone()[0] == 0 and not force:
            return {"recorded": False, "reason": "no pre-open snapshot today"}
    kite = kite_auth.trading_client()
    _snapshot(kite, today, "0915")
    with connect() as conn, conn.cursor() as cursor:
        rows = _snap_rows(cursor, today)
    by_snap = {}
    for r in rows:
        by_snap.setdefault(r["snap"], []).append(r)
    opens = {r["symbol"]: r for r in by_snap.get("0915", [])}
    wanted = set()
    for snap in ("0906", "0907"):
        wanted |= set(_picks(_signals(by_snap.get(snap, [])), max(PREOPEN_TAKES)))
    wanted |= set(_picks(_signals(by_snap.get("0915", []), use_open=True), max(PREOPEN_TAKES)))
    futs = _current_futures(kite, today)
    trades = [(today, s, opens[s]["fut"], futs[s][1], opens[s]["open"]) for s in wanted if s in opens and s in futs]
    with connect() as conn, conn.cursor() as cursor:
        execute_values(cursor, "INSERT INTO xsmr_preopen_trades (day, symbol, fut, token, entry) VALUES %s "
                               "ON CONFLICT (day, symbol) DO NOTHING", trades)
        conn.commit()
    return {"recorded": True, "trades": len(trades)}


def finalize_preopen():
    """After 15:15: each trade's exit at the close of the future's 15:00 candle."""
    now = gapwatch._now()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_preopen_tables(cursor)
        conn.commit()
        cursor.execute("SELECT day, symbol, token FROM xsmr_preopen_trades WHERE exit IS NULL AND token IS NOT NULL ORDER BY day")
        pending = [r for r in cursor.fetchall() if r[0] < now.date() or now.time() >= gapwatch.EXIT_AT]
    if not pending:
        return 0
    kite = kite_auth.trading_client()
    closed = 0
    for day, symbol, token in pending:
        bars = kite.historical_data(token, from_date=datetime.combine(day, clock(9, 0)),
                                    to_date=datetime.combine(day, clock(15, 30)), interval="15minute")
        time.sleep(backtest.PAUSE)
        bar = next((b for b in bars if b["date"].time() == clock(*backtest.GAP_EXIT_BAR)), None)
        reason = "time"
        if bar is None:
            if not (day < now.date() and bars):
                continue
            bar, reason = bars[-1], "session end"
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("UPDATE xsmr_preopen_trades SET exit = %s, exit_reason = %s, closed_at = now() "
                           "WHERE day = %s AND symbol = %s", (float(bar["close"]), reason, day, symbol))
            conn.commit()
        closed += 1
    return closed


def preopen(slippage=0.0002):
    """Per day and take: the picks from the 09:06 / 09:07 indicative prices against the picks from
    the futures open, how many matched, and what each would have made entering at the futures open."""
    cost = 2 * xsmr.cost_per_side(slippage)
    with connect() as conn, conn.cursor() as cursor:
        _ensure_preopen_tables(cursor)
        conn.commit()
        rows = _snap_rows(cursor)
        cursor.execute("SELECT day, symbol, fut, entry, exit, exit_reason FROM xsmr_preopen_trades")
        trades = {(d, s): {"fut": f, "entry": e, "exit": x, "reason": rs} for d, s, f, e, x, rs in cursor.fetchall()}
    by_day = {}
    for r in rows:
        by_day.setdefault(r["day"], {}).setdefault(r["snap"], []).append(r)
    days = []
    for day in sorted(by_day, reverse=True):
        snaps = by_day[day]
        sig = {snap: _signals(snaps.get(snap, [])) for snap in ("0906", "0907")}
        sig["open"] = _signals(snaps.get("0915", []), use_open=True)
        fresh = {snap: sum(1 for r in snaps.get(snap, []) if r["price"] and r["prev_close"] and r["price"] != r["prev_close"])
                 for snap in ("0906", "0907")}

        def ret(stock, side):
            t = trades.get((day, stock))
            if not t or not t["entry"] or not t["exit"]:
                return None
            return (1 if side == "long" else -1) * (t["exit"] / t["entry"] - 1)

        takes = {}
        for n in PREOPEN_TAKES:
            ref = _picks(sig["open"], n)
            entry = {}
            for key in ("0906", "0907", "open"):
                picks = _picks(sig[key], n)
                rets = [ret(s, side) for s, side in picks.items()]
                done = picks and all(r is not None for r in rets)
                gross = 100 * sum(rets) / (2 * n) if done else None  # % of gross exposure, equal rupees
                entry[key] = {"picks": len(picks), "matched": sum(1 for s, side in picks.items() if ref.get(s) == side),
                              "gross_pct": round(gross, 3) if gross is not None else None,
                              "net_pct": round(gross - 100 * cost, 3) if gross is not None else None}
            takes[n] = entry
        stocks = []
        quoted = {r["symbol"]: r for r in snaps.get("0915", [])}
        for stock in sorted(set(trades_key[1] for trades_key in trades if trades_key[0] == day)):
            t, q = trades[(day, stock)], quoted.get(stock, {})
            stocks.append({"symbol": stock, "fut": t["fut"],
                           **{f"sig_{k}": round(100 * sig[k][stock], 2) if stock in sig[k] else None for k in sig},
                           "prev_close": q.get("prev_close"), "open": t["entry"], "exit": t["exit"], "exit_reason": t["reason"],
                           "move_pct": round(100 * (t["exit"] / t["entry"] - 1), 2) if t["entry"] and t["exit"] else None})
        days.append({"day": day.isoformat(), "quoted": {k: len(v) for k, v in snaps.items()}, "fresh": fresh,
                     "takes": {str(n): v for n, v in takes.items()}, "stocks": stocks})
    return {"days": days, "cost_pct": round(100 * cost, 3), "takes": list(PREOPEN_TAKES)}
