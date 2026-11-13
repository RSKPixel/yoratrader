"""Buy-on-gap paper trading on the F&O stocks, with the backtest's rules exactly.

- levels(session): from daily candles before `session`, each stock's buy zone (open below the
  previous low by more than 1σ, but above the 20-day average) and sell zone (the mirror image).
- record_open(): from 09:15, today's opening prices (Kite quotes) checked against the zones;
  every qualifying stock is stored in gap_paper with its gap size. Rankings (book: top 10 longs;
  long & short: top 10 of all) are applied when reading, by gap size as in the backtest.
- finalize(): after 15:15, the exit from that day's 15m candles: the close of the 15:00 candle,
  and whether a 1σ stop was touched first.
- refresh_daily(): tops up bt_daily for the F&O stocks after the close, for tomorrow's levels.

In production a background loop (start_scheduler) runs these on weekdays, so the log builds up
even when nobody has the page open. Nothing here places orders.
"""

import threading
import time
from datetime import date, datetime, timedelta
from datetime import time as clock

import pandas as pd
from psycopg2.extras import execute_values

import backtest
import kite_auth
from db import connect, stored_lot_sizes

IST = backtest.IST
OPEN_AT = clock(9, 15, 1)  # the scheduler wakes at 09:15:01: the open is known, trading has just begun
LIVE_FILL_BY = clock(9, 15, 30)  # a snapshot later than this isn't "a market order at the open"
EXIT_AT = clock(15, 16)  # the 15:00 candle has closed
REFRESH_AT = clock(15, 45)  # daily candles for tomorrow's levels
TOP = 10
SLIPPAGE = 0.0002  # per side, as on the backtest page default
HISTORY_ROWS = backtest.GAP_SD_DAYS + 40  # daily rows read per stock


def _now():
    return datetime.now(IST)


def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gap_paper (
            day DATE NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            prev_low DOUBLE PRECISION, prev_high DOUBLE PRECISION, prev_close DOUBLE PRECISION,
            ma20 DOUBLE PRECISION, sigma DOUBLE PRECISION,
            entry DOUBLE PRECISION NOT NULL,
            gap_pct DOUBLE PRECISION NOT NULL,
            gap_sigmas DOUBLE PRECISION NOT NULL,
            stop DOUBLE PRECISION NOT NULL,
            exit DOUBLE PRECISION, exit_reason TEXT, r DOUBLE PRECISION,
            exit_stop DOUBLE PRECISION, exit_reason_stop TEXT, r_stop DOUBLE PRECISION,
            status TEXT NOT NULL DEFAULT 'open',
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            closed_at TIMESTAMPTZ,
            PRIMARY KEY (day, symbol)
        );
        -- A realistic fill: the 09:16 price (a market order sent once the open is known), no-stop R.
        ALTER TABLE gap_paper ADD COLUMN IF NOT EXISTS entry_0916 DOUBLE PRECISION;
        ALTER TABLE gap_paper ADD COLUMN IF NOT EXISTS r_0916 DOUBLE PRECISION;
        -- The live fill: last traded price in the first seconds after 09:15:00 (what a market order
        -- sent at the open would get), its time, and the no-stop R from it.
        ALTER TABLE gap_paper ADD COLUMN IF NOT EXISTS entry_live DOUBLE PRECISION;
        ALTER TABLE gap_paper ADD COLUMN IF NOT EXISTS live_at TIME;
        ALTER TABLE gap_paper ADD COLUMN IF NOT EXISTS r_live DOUBLE PRECISION;
        CREATE TABLE IF NOT EXISTS gap_paper_days (
            day DATE PRIMARY KEY,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            quoted INTEGER NOT NULL,
            candidates INTEGER NOT NULL
        );
        """
    )


def _symbols():
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol FROM bt_symbols WHERE dataset = 'fno' ORDER BY symbol")
        return [row[0] for row in cursor.fetchall()]


def next_session(now=None):
    """The session the watchlist is for: today until 15:30 on a weekday, else the next weekday.
    Exchange holidays aren't known here."""
    now = now or _now()
    day = now.date()
    if day.weekday() < 5 and now.time() < clock(15, 30):
        return day
    day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def levels(session):
    """Buy and sell zones for `session` from the daily candles before it, per F&O stock."""
    symbols = _symbols()
    with connect() as conn:
        frame = pd.read_sql(
            "SELECT symbol, day, open, high, low, close FROM ("
            "  SELECT *, row_number() OVER (PARTITION BY symbol ORDER BY day DESC) AS rn"
            "  FROM bt_daily WHERE symbol = ANY(%s) AND day < %s) t "
            "WHERE rn <= %s ORDER BY symbol, day",
            conn, params=[symbols, session, HISTORY_ROWS],
        )
    out = []
    for symbol, g in frame.groupby("symbol"):
        if len(g) <= backtest.GAP_SD_DAYS:
            continue
        closes = g["close"].to_numpy(float)
        sigma = float(pd.Series(closes[-(backtest.GAP_SD_DAYS + 1):]).pct_change().std())
        ma = float(closes[-backtest.GAP_MA_DAYS:].mean())
        prev = g.iloc[-1]
        if not sigma or sigma <= 0:
            continue
        buy_below = float(prev["low"]) * (1 - sigma)
        sell_above = float(prev["high"]) * (1 + sigma)
        close = float(prev["close"])
        out.append({
            "symbol": symbol, "as_of": prev["day"].isoformat(), "prev_close": round(close, 2),
            "prev_low": round(float(prev["low"]), 2), "prev_high": round(float(prev["high"]), 2),
            "ma20": round(ma, 2), "sigma_pct": round(sigma * 100, 2),
            # Buy zone: ma20 < open < buy_below. Sell zone: sell_above < open < ma20.
            "buy_below": round(buy_below, 2) if buy_below > ma else None,
            "sell_above": round(sell_above, 2) if sell_above < ma else None,
            "buy_gap_pct": round((buy_below / close - 1) * 100, 2) if buy_below > ma else None,
            "sell_gap_pct": round((sell_above / close - 1) * 100, 2) if sell_above < ma else None,
            "_sigma": sigma, "_ma": ma,
        })
    return out


def _quotes(kite, symbols):
    quotes = {}
    keys = [f"NSE:{s}" for s in symbols]
    for i in range(0, len(keys), 400):
        quotes.update(kite.quote(keys[i:i + 400]))
    return {k.split(":", 1)[1]: v for k, v in quotes.items()}


def _is_recorded(cursor, day):
    cursor.execute("SELECT 1 FROM gap_paper_days WHERE day = %s", (day,))
    return cursor.fetchone() is not None


def record_open(force=False):
    """Check today's opening prices against today's zones and store every qualifying stock.

    Returns a dict with the counts; does nothing before 09:15, on weekends, or when today is
    already recorded (unless force). A day on which no stock traded (a holiday) is recorded with
    zero quotes so the scheduler stops retrying."""
    now = _now()
    today = now.date()
    if today.weekday() >= 5 or now.time() < OPEN_AT:
        return {"recorded": False, "reason": "market not open yet"}
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        if _is_recorded(cursor, today) and not force:
            return {"recorded": False, "reason": "already recorded"}
    cached = _state.get("zones")
    zones = cached[1] if cached and cached[0] == today else [z for z in levels(today) if z["buy_below"] or z["sell_above"]]
    kite = kite_auth.trading_client()
    quotes = _quotes(kite, [z["symbol"] for z in zones]) if zones else {}
    snap = _now()
    live_ok = snap.time() <= LIVE_FILL_BY
    rows, quoted = [], 0
    for z in zones:
        q = quotes.get(z["symbol"])
        if not q:
            continue
        traded = q.get("last_trade_time")
        opened = float((q.get("ohlc") or {}).get("open") or 0)
        if not traded or traded.date() != today or opened <= 0:
            continue
        quoted += 1
        sigma, ma = z["_sigma"], z["_ma"]
        side = None
        if z["buy_below"] and ma < opened < z["buy_below"]:
            side, gap = "long", opened / z["prev_low"] - 1
        elif z["sell_above"] and z["sell_above"] < opened < ma:
            side, gap = "short", opened / z["prev_high"] - 1
        if not side:
            continue
        risk = opened * sigma
        stop = opened - risk if side == "long" else opened + risk
        live = float(q.get("last_price") or 0) if live_ok else 0
        rows.append((today, z["symbol"], side, z["prev_low"], z["prev_high"], z["prev_close"], round(ma, 2),
                     sigma, opened, round(gap * 100, 3), round(abs(gap) / sigma, 3), round(stop, 2),
                     live or None, snap.time().replace(microsecond=0) if live else None))
    if zones and quoted == 0 and not force:
        # Nothing traded today: a holiday, or quotes not in yet. Only a holiday after 10:00.
        if now.time() < clock(10, 0):
            return {"recorded": False, "reason": "no opening prices yet"}
    with connect() as conn, conn.cursor() as cursor:
        if rows:
            execute_values(cursor, "INSERT INTO gap_paper (day, symbol, side, prev_low, prev_high, prev_close, ma20, "
                                   "sigma, entry, gap_pct, gap_sigmas, stop, entry_live, live_at) VALUES %s "
                                   "ON CONFLICT DO NOTHING", rows)
        cursor.execute("INSERT INTO gap_paper_days (day, quoted, candidates) VALUES (%s, %s, %s) ON CONFLICT (day) "
                       "DO UPDATE SET recorded_at = now(), quoted = EXCLUDED.quoted, candidates = EXCLUDED.candidates",
                       (today, quoted, len(rows)))
        conn.commit()
    return {"recorded": True, "zones": len(zones), "quoted": quoted, "candidates": len(rows),
            "snapshot": snap.strftime("%H:%M:%S"), "live_fill": live_ok}


_tokens = {"at": None, "map": {}}


def _token(kite, symbol):
    if _tokens["at"] is None or time.time() - _tokens["at"] > 6 * 3600:
        _tokens["map"] = {r["tradingsymbol"]: r["instrument_token"] for r in kite.instruments("NSE")
                          if r["segment"] == "NSE"}
        _tokens["at"] = time.time()
    return _tokens["map"].get(symbol)


def finalize():
    """Exit every open pick whose day has passed 15:15: the close of the 15:00 candle, and the
    1σ-stop variant from the day's 15m lows/highs. Returns the number closed."""
    now = _now()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT day, symbol, side, entry, stop, entry_live FROM gap_paper WHERE status = 'open' ORDER BY day")
        pending = [r for r in cursor.fetchall() if r[0] < now.date() or now.time() >= EXIT_AT]
    if not pending:
        return 0
    kite = kite_auth.trading_client()
    closed = 0
    for day, symbol, side, entry, stop, entry_live in pending:
        result = _exit_for(kite, day, symbol, side, entry, stop, past=day < now.date())
        if result is None:
            continue
        sign = 1 if side == "long" else -1
        r_live = round(sign * (result[0] - entry_live) / abs(entry - stop), 3) if entry_live else None
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute(
                "UPDATE gap_paper SET exit = %s, exit_reason = %s, r = %s, exit_stop = %s, exit_reason_stop = %s, "
                "r_stop = %s, entry_0916 = %s, r_0916 = %s, r_live = %s, status = 'closed', closed_at = now() "
                "WHERE day = %s AND symbol = %s",
                (*result, r_live, day, symbol),
            )
            conn.commit()
        closed += 1
    return closed


def _exit_for(kite, day, symbol, side, entry, stop, past=True):
    """(exit, reason, r, exit_stop, reason_stop, r_stop, entry_0916, r_0916) from the day's 15m
    candles (and the 09:16 minute candle), or None if the 15:00 candle isn't there yet. Same rules
    as the backtest: out at the 15:00 candle's close; the 1σ variant stops out if any candle up to
    and including that one touches the stop. entry_0916 / r_0916: the same trade entered at the
    09:16 price (a market order sent once the open is known), no stop, same 1R."""
    token = _token(kite, symbol)
    if token is None:
        return None
    bars = kite.historical_data(token, from_date=datetime.combine(day, clock(9, 0)),
                                to_date=datetime.combine(day, clock(15, 30)), interval="15minute")
    time.sleep(backtest.PAUSE)
    exit_bar = next((b for b in bars if b["date"].time() == clock(*backtest.GAP_EXIT_BAR)), None)
    reason = "time"
    if exit_bar is None:
        if not (past and bars):
            return None
        exit_bar, reason = bars[-1], "session end"  # short session: out at its last close
    long = side == "long"
    sign = 1 if long else -1
    risk = abs(entry - stop)
    exit_px = float(exit_bar["close"])
    exit_stop, reason_stop = exit_px, reason
    for b in bars:
        if b["date"] > exit_bar["date"]:
            break
        if (long and b["low"] <= stop) or (not long and b["high"] >= stop):
            exit_stop, reason_stop = stop, "stop"
            break
    entry_0916 = r_0916 = None
    minutes = kite.historical_data(token, from_date=datetime.combine(day, clock(9, 15)),
                                   to_date=datetime.combine(day, clock(9, 17)), interval="minute")
    time.sleep(backtest.PAUSE)
    at_0916 = next((b for b in minutes if b["date"].time() == clock(9, 16)), None)
    if at_0916:
        entry_0916 = float(at_0916["open"])
        r_0916 = round(sign * (exit_px - entry_0916) / risk, 3)
    return (round(exit_px, 2), reason, round(sign * (exit_px - entry) / risk, 3), round(exit_stop, 2), reason_stop,
            round(sign * (exit_stop - entry) / risk, 3), entry_0916, r_0916)


def refresh_daily(on_progress=None):
    """Top up bt_daily for the F&O stocks (from each one's last stored day to today)."""
    kite = kite_auth.trading_client()
    today = date.today()
    errors = []
    symbols = _symbols()
    with connect() as conn, conn.cursor() as cursor:
        for i, symbol in enumerate(symbols):
            if on_progress:
                on_progress({"done": i, "total": len(symbols), "symbol": symbol})
            token = _token(kite, symbol)
            if token is None:
                errors.append(f"{symbol}: not in Kite instruments")
                continue
            try:
                last = backtest._last_stored(cursor, "bt_daily", "day", symbol) or today - timedelta(days=200)
                bars = backtest._fetch(kite, token, last, today, "day", backtest.CHUNK_DAY)
                backtest._store(cursor, symbol, [], bars)
                conn.commit()
            except Exception as error:
                conn.rollback()
                if "access_token" in str(error) or "api_key" in str(error):
                    raise
                errors.append(f"{symbol}: {error}")
    return {"symbols": len(symbols), "errors": errors}


def _with_selection(rows):
    """Mark each day's book picks (top 10 longs) and long & short picks (top 10 of all), by gap size."""
    by_day = {}
    for r in rows:
        by_day.setdefault(r["day"], []).append(r)
    for picks in by_day.values():
        picks.sort(key=lambda r: -abs(r["gap_pct"]))
        longs = [r for r in picks if r["side"] == "long"]
        for i, r in enumerate(picks):
            r["rank"] = i + 1
            r["in_both"] = i < TOP
        for i, r in enumerate(longs):
            r["in_book"] = i < TOP
        for r in picks:
            r.setdefault("in_book", False)
    return rows


def paper(slippage=SLIPPAGE):
    """Everything the page shows: today's session, its picks (live R from LTP while open), the
    watchlist for the next session, and the log with summaries."""
    now = _now()
    session = next_session(now)
    lots = stored_lot_sizes()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT * FROM gap_paper ORDER BY day DESC, symbol")
        cols = [c.name for c in cursor.description]
        rows = [dict(zip(cols, r)) for r in cursor.fetchall()]
        cursor.execute("SELECT day, recorded_at, quoted, candidates FROM gap_paper_days ORDER BY day DESC LIMIT 1")
        last_day = cursor.fetchone()
        cursor.execute("SELECT max(day) FROM bt_daily WHERE symbol = ANY(%s)", (_symbols(),))
        daily_as_of = cursor.fetchone()[0]
    for r in rows:
        r["day"] = r["day"].isoformat()
        for k in ("recorded_at", "closed_at"):
            r[k] = r[k].astimezone(IST).strftime("%Y-%m-%d %H:%M") if r[k] else None
    _with_selection(rows)

    today = now.date().isoformat()
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
                    risk = abs(r["entry"] - r["stop"])
                    r["ltp"] = float(q["last_price"])
                    r["r_live"] = round(sign * (r["ltp"] - r["entry"]) / risk, 3)
                    hit = (sign == 1 and r["ltp"] <= r["stop"]) or (sign == -1 and r["ltp"] >= r["stop"])
                    r["stop_hit_now"] = hit
        except Exception as error:
            print("Gap LTP failed:", error)

    for r in rows:
        lot = lots.get(("NSE", r["symbol"]))
        r["lot_size"] = lot
        risk_pts = abs(r["entry"] - r["stop"])
        r["risk_rs"] = round(risk_pts * lot) if lot else None
        r["live_at"] = r["live_at"].strftime("%H:%M:%S") if r.get("live_at") else None
        for key in ("r", "r_stop", "r_0916", "r_live"):
            if r.get(key) is not None:
                entry = {"r_0916": r["entry_0916"], "r_live": r["entry_live"]}.get(key, r["entry"])
                sign = 1 if r["side"] == "long" else -1
                cost = backtest._cost_r({"entry": entry, "stop": entry - sign * risk_pts, "r": r[key], "side": r["side"],
                                         "t1_hit": False}, "fno", slippage)
                r[f"net_{key}"] = round(r[key] - cost, 3)
                r[f"net_{key}_rs"] = round((r[key] - cost) * risk_pts * lot) if lot else None
        for k in ("sigma",):
            r["sigma_pct"] = round(r.pop(k) * 100, 2)

    watch = [{k: v for k, v in z.items() if not k.startswith("_")} for z in levels(session)]
    watch = [z for z in watch if z["buy_below"] or z["sell_above"]]
    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"), "session": session.isoformat(), "today": today,
        "market_open": now.date().weekday() < 5 and clock(9, 15) <= now.time() < clock(15, 30),
        "today_recorded": bool(last_day and last_day[0].isoformat() == today),
        "last_recorded": ({"day": last_day[0].isoformat(), "at": last_day[1].astimezone(IST).strftime("%H:%M"),
                           "quoted": last_day[2], "candidates": last_day[3]} if last_day else None),
        "daily_as_of": daily_as_of.isoformat() if daily_as_of else None,
        "ltp_at": ltp_at, "picks": rows, "watchlist": watch, "slippage": slippage,
    }


# ---- scheduler (production only) -------------------------------------------------------------

_state = {"refreshed_on": None, "started": False, "last_error": None}


def _tick():
    now = _now()
    if now.weekday() >= 5:
        return
    t = now.time()
    if clock(9, 14) <= t < OPEN_AT:  # work out the zones a minute early so 09:15:01 is one quote call
        _state["zones"] = (now.date(), [z for z in levels(now.date()) if z["buy_below"] or z["sell_above"]])
    if OPEN_AT <= t < clock(15, 30):
        result = record_open()
        if result.get("recorded"):
            print("Gap paper: recorded", result)
    if t >= EXIT_AT:
        closed = finalize()
        if closed:
            print(f"Gap paper: closed {closed} picks")
    if t >= REFRESH_AT and _state["refreshed_on"] != now.date():
        result = refresh_daily()
        _state["refreshed_on"] = now.date()
        print("Gap paper: daily candles refreshed", len(result["errors"]), "errors")


def _loop():
    while True:
        try:
            _tick()
            _state["last_error"] = None
        except Exception as error:  # an expired Kite login, a network blip: try again next minute
            if str(error) != _state["last_error"]:
                print("Gap paper scheduler:", error)
            _state["last_error"] = str(error)
        now = _now()  # wake at hh:mm:01 every minute, so the open is caught at 09:15:01
        time.sleep(max(1.0, 61 - now.second - now.microsecond / 1e6))


def start_scheduler():
    if not _state["started"]:
        _state["started"] = True
        threading.Thread(target=_loop, daemon=True, name="gap-paper").start()
