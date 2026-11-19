"""Oops gap reversal paper trading (Larry Williams; the v2 backtest's book: no stop by default,
any trend, the day's first N fills, N = max open, 3 by default), on the F&O stocks' current-month
FUTURES: every price here (yesterday's low, the open, the fill, the exit) is the future's, the stock only
names it. Run by gapwatch's production scheduler every minute. Nothing here places orders.

- 09:10: yesterday's low of each current-month future, from its own daily candle (not the continuous
  series, which the day after an expiry would give the old contract's low). Fallback if that hasn't run:
  the stored continuous futures daily candles.
- 09:15:01 (the open is known): every future that opened below yesterday's low goes on the day's
  watchlist (oops_paper_watch).
- From the open: Kite's live tick stream (WebSocket) on the watched and held futures. The first tick
  whose price (or day high) reaches yesterday's low is the buy, at that level (as a resting buy-stop
  order would fill), stamped with the exchange time; at most N a day, in the order they touch. The
  once-a-minute quote stays as a backup (a dropped stream, a missed tick). Disaster stop (a setting,
  OOPS_PAPER_STOP, on by default): 10% below the buy; an open position whose low goes through it is sold there.
- Exit (a setting, OOPS_PAPER_EXIT; each position keeps the one it was bought under): "1515" sells what is
  still open at 15:15:01 at the price then; "nextopen" (the book's: "out on the opening tomorrow") holds it
  overnight and sells it at the next trading day's open (the future's opening price, at 09:15:01), except a
  position in a future that expires that day, which is sold at 15:15.

One lot each on the page. A buy is seen within a minute of happening.
"""

import threading
import time
from datetime import datetime, timedelta
from datetime import time as clock

import db
import capped
import gapwatch
import kite_auth
import priority
import realfill
import v2margin
import v2paper
import xsmr
import xsmrwatch
from db import connect, schema_once

PREPARE_AT, OPEN_AT, EXIT_AT, UNTIL = clock(9, 10), clock(9, 15, 1), clock(15, 15), clock(15, 30)
RETRY_UNTIL = clock(9, 20)  # a quiet first quote is retried each minute until then before the day counts as closed
DISASTER_PCT = 10.0  # disaster.PCT (not imported here: keep the scheduler's imports light)
STOP_BELOW = 0.999
MAX_OPEN, MAX_OPEN_LIMIT, MAX_OPEN_KEY = 3, 10, "OOPS_PAPER_MAX_OPEN"
STOP_KEY, STOPS = "OOPS_PAPER_STOP", ("on", "off")  # the 10% disaster stop (disaster.py), for new buys
EXIT_KEY, EXITS = "OOPS_PAPER_EXIT", ("1515", "nextopen")


def exit_mode():
    """'1515' (sold the same day at 15:15) or 'nextopen' (held overnight, sold at the next day's open), for new buys."""
    try:
        v = db.get_settings([EXIT_KEY]).get(EXIT_KEY)
    except Exception:
        v = None
    return v if v in EXITS else "nextopen"  # the book's; the page no longer offers 15:15


def set_exit_mode(mode):
    if mode not in EXITS:
        raise ValueError("Exit must be '1515' or 'nextopen'.")
    db.set_settings({EXIT_KEY: mode})
    return mode


_expiries = {"day": None, "map": {}}


def _expiry_of(kite, today, fut):
    """The expiry date of a futures tradingsymbol (the NFO instrument list, read once a day)."""
    if _expiries["day"] != today:
        _expiries.update(day=today, map={r["tradingsymbol"]: r["expiry"] for r in kite.instruments("NFO") if r["instrument_type"] == "FUT"})
    return _expiries["map"].get(fut)


def stop_mode():
    """'on': the 10% disaster stop below the buy (Chan's, as on Buy/Sell on gap); 'off': no stop. For new
    buys. Older values (the 0.1%-under-the-low stop, 'low' / 'none') read as the default, on."""
    try:
        v = db.get_settings([STOP_KEY]).get(STOP_KEY)
    except Exception:
        v = None
    return v if v in STOPS else "on"


def set_stop_mode(mode):
    if mode not in STOPS:
        raise ValueError("Disaster stop must be 'on' or 'off'.")
    db.set_settings({STOP_KEY: mode})
    return mode


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


@schema_once
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
        ALTER TABLE oops_paper ALTER COLUMN stop DROP NOT NULL;  -- NULL: bought with no stop
        ALTER TABLE oops_paper_watch ADD COLUMN IF NOT EXISTS fut TEXT;  -- the future traded
        -- already back at yesterday's low by the 09:15:01 quote: a real buy-stop, placed at the open, likely misses it
        ALTER TABLE oops_paper_watch ADD COLUMN IF NOT EXISTS first_sec BOOLEAN;
        ALTER TABLE oops_paper ADD COLUMN IF NOT EXISTS fut TEXT;
        ALTER TABLE oops_paper ADD COLUMN IF NOT EXISTS exit_mode TEXT;  -- NULL (older rows): '1515'
        CREATE TABLE IF NOT EXISTS oops_paper_prev (
            day DATE NOT NULL, symbol TEXT NOT NULL, fut TEXT NOT NULL, prev_low DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (day, symbol)
        );
        -- the contract's previous high and close too: Buy/Sell on gap and cross-sectional read them (futsig)
        ALTER TABLE oops_paper_prev ADD COLUMN IF NOT EXISTS prev_high DOUBLE PRECISION;
        ALTER TABLE oops_paper_prev ADD COLUMN IF NOT EXISTS prev_close DOUBLE PRECISION;
        -- the best ask when the buy was made (realfill: a thin future's real cost when no tick log covers it)
        ALTER TABLE oops_paper ADD COLUMN IF NOT EXISTS fill_ask DOUBLE PRECISION;
        """
    )


_preparing = threading.Lock()


def prepare(today=None):
    """09:10: each current-month future's own previous-day low (one daily-candle call per future, about
    a minute and a half at Kite's rate limit), into oops_paper_prev."""
    today = today or gapwatch._now().date()
    if not _preparing.acquire(blocking=False):
        return {"prepared": False, "reason": "already running"}
    try:
        with connect() as conn, conn.cursor() as cursor:
            _ensure_tables(cursor)
            conn.commit()
            cursor.execute("SELECT count(*) FROM oops_paper_prev WHERE day = %s", (today,))
            if cursor.fetchone()[0]:
                return {"prepared": False, "reason": "done"}
        kite = kite_auth.trading_client()
        futs = xsmrwatch._current_futures(kite, today)
        rows, errors = [], 0
        for stock, (fut, token) in sorted(futs.items()):
            try:
                bars = kite.historical_data(token, datetime.combine(today - timedelta(days=10), clock(9, 0)),
                                            datetime.combine(today - timedelta(days=1), clock(15, 30)), "day")
                prev = [b for b in bars if b["date"].date() < today and b["low"] > 0]
                if prev:
                    rows.append((today, stock, fut, float(prev[-1]["low"]), float(prev[-1]["high"]), float(prev[-1]["close"])))
            except Exception as error:
                if "access_token" in str(error) or "api_key" in str(error):
                    raise
                errors += 1
            time.sleep(0.35)
        with connect() as conn, conn.cursor() as cursor:
            cursor.executemany("INSERT INTO oops_paper_prev (day, symbol, fut, prev_low, prev_high, prev_close) VALUES (%s, %s, %s, %s, %s, %s) "
                               "ON CONFLICT (day, symbol) DO NOTHING", rows)
            conn.commit()
        return {"prepared": len(rows), "errors": errors}
    finally:
        _preparing.release()


def _prev_lows(cursor, kite, today):
    """{stock: (future, yesterday's low of that future)}: from prepare(), else the stored continuous
    futures daily candles (exchange 'NSE' in eod: the near-month future, rolled at expiry)."""
    cursor.execute("SELECT symbol, fut, prev_low FROM oops_paper_prev WHERE day = %s", (today,))
    got = {s: (f, pl) for s, f, pl in cursor.fetchall()}
    if got:
        return got
    futs = xsmrwatch._current_futures(kite, today)
    cursor.execute("SELECT DISTINCT ON (symbol) symbol, low FROM eod WHERE exchange = 'NSE' AND datetime < %s "
                   "AND datetime >= %s::date - 10 AND low > 0 ORDER BY symbol, datetime DESC", (today, today))
    return {s: (futs[s][0], low) for s, low in cursor.fetchall() if s in futs}


def _fut_quotes(kite, futs):
    """{future: quote} for the given future tradingsymbols."""
    keys, quotes = [f"NFO:{f}" for f in futs], {}
    for i in range(0, len(keys), 400):
        quotes.update(kite.quote(keys[i:i + 400]))
    return {k.split(":", 1)[1]: v for k, v in quotes.items()}


def _record_open(kite, today, stamp):
    """09:15:01: the watchlist, every future that opened below its yesterday's low."""
    with connect() as conn, conn.cursor() as cursor:
        lows = _prev_lows(cursor, kite, today)
    quotes = gapwatch.open_quotes(kite, [f for f, _ in lows.values()], today)
    traded = sum(1 for q in quotes.values() if q.get("last_trade_time") and q["last_trade_time"].date() == today)
    watch = []
    for s, (fut, pl) in lows.items():
        ohlc = (quotes.get(fut) or {}).get("ohlc") or {}
        o, high = ohlc.get("open"), ohlc.get("high")
        if o and o < pl:
            watch.append((today, s, float(pl), float(o), fut, bool(high and high >= pl)))
    note = None if traded >= 0.5 * max(1, len(quotes)) else f"market closed (only {traded} of {len(quotes)} futures traded today)"
    if note and stamp.time() < RETRY_UNTIL:
        # futures quotes lag in the first second (19 Nov: 105 of 218 showed a trade at 09:15:01, the tick stream 209):
        # not "closed" yet; ask again next minute, and only a market still quiet at 09:20 counts as closed
        return {"gapped": 0, "note": None, "retry": f"only {traded} of {len(quotes)} futures traded yet"}
    late = stamp.time() >= clock(9, 15, 10)  # a later watchlist can't tell what the first second showed
    watch = [w[:5] + (None if late else w[5],) for w in watch]
    with connect() as conn, conn.cursor() as cursor:
        if watch and not note:
            cursor.executemany("INSERT INTO oops_paper_watch (day, symbol, prev_low, open, fut, first_sec) VALUES (%s, %s, %s, %s, %s, %s) "
                               "ON CONFLICT (day, symbol) DO NOTHING", watch)
        cursor.execute("INSERT INTO oops_paper_days (day, recorded_at, quoted, gapped, note) VALUES (%s, %s, %s, %s, %s) "
                       "ON CONFLICT (day) DO NOTHING", (today, stamp, len(quotes), 0 if note else len(watch), note))
        conn.commit()
    return {"gapped": 0 if note else len(watch), "note": note}


_book_lock = threading.Lock()  # the stream and the minute check both fill: one decision at a time


def _best_ask(q):
    """The best ask in a tick or quote's depth (None if empty)."""
    try:
        a = float(((q.get("depth") or {}).get("sell") or [{}])[0].get("price") or 0)
        return a or None
    except Exception:
        return None


def _fill(today, s, pl, o, stamp, low, fut, slots, with_stop, ask=None):
    """Buy s at yesterday's low if a slot is free; True if bought."""
    with _book_lock, connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol FROM oops_paper WHERE day = %s", (today,))
        have = {r[0] for r in cursor.fetchall()}
        if s in have or len(have) >= slots:
            return False
        cursor.execute("INSERT INTO oops_paper (day, symbol, prev_low, open, filled_at, entry, low_at_fill, stop, slots, fut, exit_mode, fill_ask) "
                       "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day, symbol) DO NOTHING",
                       (today, s, pl, o, stamp, pl, low, pl * (1 - DISASTER_PCT / 100) if with_stop else None, slots, fut, exit_mode(), ask))
        conn.commit()
        return cursor.rowcount == 1


def _exit_overnight(kite, today):
    """09:15:01 on: positions held from an earlier day ('nextopen') sold at today's open of their future."""
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT day, symbol, fut FROM oops_paper WHERE day < %s AND exit_at IS NULL", (today,))
        rows = cursor.fetchall()
    if not rows:
        return []
    fq = _fut_quotes(kite, sorted({f for _, _, f in rows if f}))
    stamp, sold = gapwatch._now(), []
    for day, s, fut in rows:
        q = fq.get(fut) or {}
        o, lt = (q.get("ohlc") or {}).get("open"), q.get("last_trade_time")
        if o and lt and lt.date() == today:
            with _book_lock, connect() as conn, conn.cursor() as cursor:
                cursor.execute("UPDATE oops_paper SET exit_at = %s, exit = %s, reason = 'next open' WHERE day = %s AND symbol = %s AND exit_at IS NULL",
                               (stamp, float(o), day, s))
                conn.commit()
                if cursor.rowcount == 1:
                    sold.append((s, "next open"))
    return sold


def _exit(today, s, stamp, px, reason):
    with _book_lock, connect() as conn, conn.cursor() as cursor:
        cursor.execute("UPDATE oops_paper SET exit_at = %s, exit = %s, reason = %s WHERE day = %s AND symbol = %s AND exit_at IS NULL",
                       (stamp, px, reason, today, s))
        conn.commit()
        return cursor.rowcount == 1


# ---- the live tick stream (production only: the scheduler starts it) ----------------------------

_capped = capped.OopsRecorder()
_stream = {"day": None, "ticker": None, "by_token": {}, "watch": {}, "held": {}, "slots": MAX_OPEN, "with_stop": False}
_stream_lock = threading.Lock()


def _on_ticks(ws, ticks):
    st = _stream
    today = st["day"]
    for tk in ticks:
        s = st["by_token"].get(tk.get("instrument_token"))
        if s is None:
            continue
        ltp, ohlc = tk.get("last_price"), tk.get("ohlc") or {}
        ts = tk.get("exchange_timestamp") or tk.get("last_trade_time")
        # Kite's library gives the server's local clock (UTC in the container): India time
        stamp = ts.astimezone(gapwatch.IST) if ts else gapwatch._now()
        if stamp.time() >= EXIT_AT:
            continue
        try:  # the capped-limit version's record (capped.py): every watched future, whatever the book's slots
            _capped.on_tick(s, stamp.replace(tzinfo=None), ltp, _best_ask(tk))
        except Exception as error:
            print("Oops capped record:", s, error)
        try:
            if s in st["held"]:
                stop, low = st["held"][s], ohlc.get("low")
                if stop is not None and low and low <= stop and _exit(today, s, stamp, float(stop), "disaster stop"):
                    st["held"][s] = None
                    print("Oops paper (stream): stopped", s, stamp.strftime("%H:%M:%S"))
            elif s in st["watch"]:
                pl, o, fut = st["watch"][s]
                high = max(ltp or 0, ohlc.get("high") or 0)
                if high >= pl:
                    low = ohlc.get("low") or ltp
                    del st["watch"][s]
                    if _fill(today, s, pl, o, stamp, float(low), fut, st["slots"], st["with_stop"], _best_ask(tk)):
                        st["held"][s] = float(pl) * (1 - DISASTER_PCT / 100) if st["with_stop"] else None
                        print("Oops paper (stream): bought", s, "at", pl, stamp.strftime("%H:%M:%S"))
        except Exception as error:
            print("Oops paper (stream):", s, error)


def _close_stream():
    t = _stream["ticker"]
    _stream.update(ticker=None, by_token={}, watch={}, held={})
    if t is not None:
        try:
            from twisted.internet import reactor
            reactor.callFromThread(t.close)
        except Exception as error:
            print("Oops paper: closing the stream failed:", error)


def _sync_stream(kite, today, watch, fut_of, held, bought, slots, with_stop):
    """Start today's stream if it isn't running, and refresh what it watches from the stored book."""
    from kiteconnect import KiteTicker
    with _stream_lock:
        if _stream["day"] != today:
            _close_stream()
            _stream["day"] = today
        futs = xsmrwatch._current_futures(kite, today)
        token_of = {f: tok for f, tok in futs.values()}
        _stream["watch"] = {s: (pl, o, fut_of[s]) for s, (pl, o) in watch.items() if s not in bought and fut_of.get(s)}
        _stream["held"] = dict(held)
        _stream["slots"], _stream["with_stop"] = slots, with_stop
        if len(bought) >= slots:
            _stream["watch"] = {}
        _capped.reset(today, {s: pl for s, (pl, o) in watch.items()})
        wanted = {token_of[fut_of[s]]: s for s in set(_stream["watch"]) | set(held) | _capped.symbols() if token_of.get(fut_of.get(s))}
        _stream["by_token"] = wanted
        t = _stream["ticker"]
        if t is None and wanted:
            t = KiteTicker(kite.api_key, kite.access_token)
            t.on_ticks = _on_ticks
            t.on_connect = lambda ws, resp: (ws.subscribe(list(_stream["by_token"])), ws.set_mode(ws.MODE_FULL, list(_stream["by_token"])))
            t.on_error = lambda ws, code, reason: print("Oops paper stream error:", code, reason)
            t.on_reconnect = lambda ws, n: print("Oops paper stream: reconnecting", n)
            _stream["ticker"] = t
            t.connect(threaded=True)
            print("Oops paper: tick stream started,", len(wanted), "futures")
        elif t is not None and t.is_connected():
            from twisted.internet import reactor
            toks = list(wanted)
            if toks:
                reactor.callFromThread(lambda: (t.subscribe(toks), t.set_mode(t.MODE_FULL, toks)))


def stream_status():
    t = _stream["ticker"]
    return {"day": _stream["day"].isoformat() if _stream["day"] else None, "connected": bool(t and t.is_connected()),
            "watching": len(_stream["watch"]), "held": len(_stream["held"])}


def tick(force=False, stream=True):
    """Once a minute: the open's watchlist once, the tick stream kept running, the backup check of
    fills and stops from a quote, and the 15:15 exit."""
    now = gapwatch._now()
    today, t = now.date(), now.time()
    if today.weekday() >= 5 or not (OPEN_AT <= t < UNTIL or force):
        if _stream["ticker"] is not None:
            _close_stream()
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
        if out["open"].get("retry"):
            return {**out, "done": False}
        day = (out["open"]["note"],)
    if day[0]:  # market closed
        return {"done": False, "reason": day[0]}
    try:  # the book's exit: yesterday's overnight positions out at today's open
        overnight = _exit_overnight(kite, today)
        if overnight:
            out["sold_at_open"] = overnight
    except Exception as error:
        print("Oops paper: next-open exits failed (retried next minute):", error)
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol, prev_low, open, fut FROM oops_paper_watch WHERE day = %s", (today,))
        rows = cursor.fetchall()
        watch = {s: (pl, o) for s, pl, o, _ in rows}
        fut_of = {s: f for s, _, _, f in rows}
        cursor.execute("SELECT symbol, stop, COALESCE(exit_mode, '1515'), fut FROM oops_paper WHERE day = %s AND exit_at IS NULL", (today,))
        held_rows = cursor.fetchall()
        held = {s: stop for s, stop, _, _ in held_rows}
        overnight_ok = {s for s, _, m, f in held_rows if m == "nextopen"}
        fut_of.update({s: f for s, _, _, f in held_rows if f})
        cursor.execute("SELECT symbol FROM oops_paper WHERE day = %s", (today,))
        bought = {r[0] for r in cursor.fetchall()}
    slots = max_open()
    with_stop = stop_mode() == "on"
    if stream and t < EXIT_AT:
        try:
            _sync_stream(kite, today, watch, fut_of, held, bought, slots, with_stop)
        except Exception as error:
            print("Oops paper: tick stream failed (the minute check carries on):", error)
    elif t >= EXIT_AT and _stream["ticker"] is not None:
        _close_stream()
    waiting = [s for s in watch if s not in bought]
    if not waiting and not held:
        return {**out, "done": True}
    fq = _fut_quotes(kite, sorted({fut_of[s] for s in set(waiting) | set(held) if fut_of.get(s)}))
    quotes = {s: fq.get(fut_of.get(s)) or {} for s in set(waiting) | set(held)}
    stamp = gapwatch._now()
    sold, got = [], []
    for s, stop in held.items():
        q = quotes.get(s) or {}
        low, ltp = (q.get("ohlc") or {}).get("low"), q.get("last_price")
        if stop is not None and low is not None and low <= stop:
            if _exit(today, s, stamp, float(stop), "disaster stop"):
                sold.append((s, "disaster stop"))
        elif t >= EXIT_AT and ltp:
            if s in overnight_ok and _expiry_of(kite, today, fut_of.get(s)) != today:
                continue  # held overnight: sold at tomorrow's open
            if _exit(today, s, stamp, float(ltp), "15:15"):
                sold.append((s, "15:15"))
    if t < EXIT_AT and len(bought) < slots:
        cands = []
        for s in waiting:
            q = quotes.get(s) or {}
            high, low = (q.get("ohlc") or {}).get("high"), (q.get("ohlc") or {}).get("low")
            pl, o = watch[s]
            if high is not None and high >= pl:
                cands.append((pl / o - 1, s, pl, o, float(low), _best_ask(q)))
        for _, s, pl, o, low, ask in sorted(cands):  # missed by the stream: the smallest gap first
            if _fill(today, s, pl, o, stamp, low, fut_of.get(s), slots, with_stop, ask):
                got.append(s)
    if got or sold:
        out.update(bought=got, sold=sold)
    return {**out, "done": True}


def _first_second(days):
    """Fills that were already back at yesterday's low by 09:15:01 (a real buy-stop placed at the open
    would likely miss them), against the rest: count and net rupees (one lot each)."""
    picks = [r for d in days for r in d["picks"]]
    def part(rows):
        return {"fills": len(rows), "net_rs": round(sum(r.get("net_rs") or 0 for r in rows))}
    return {"first": part([r for r in picks if r["first_second"]]), "later": part([r for r in picks if not r["first_second"]])}


def _next_opens(items):
    """{(symbol, day): (next trading day, its future's open)} from the futures daily candles (eod 'NSE')."""
    out = {}
    if not items:
        return out
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT w.symbol, w.day, n.datetime::date, n.open FROM unnest(%s::text[], %s::date[]) AS w(symbol, day) "
                       "CROSS JOIN LATERAL (SELECT datetime, open FROM eod WHERE exchange = 'NSE' AND symbol = w.symbol AND datetime > w.day "
                       "AND open > 0 ORDER BY datetime LIMIT 1) n", ([i[0] for i in items], [i[1] for i in items]))
        for s, d, nd, o in cursor.fetchall():
            out[(s, d)] = (nd, float(o))
    return out


def _capped_version(days, today, live, fills_slip, cps, lots):
    """The capped-limit version (capped.py) next to the book: each day's watchlist, a buy limit at the low
    +CAP for WAIT seconds from the trade back at the low, slots to the first filled; out at the next open as
    the book. Missed ones are listed with what they'd have made bought at the level."""
    first = None
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT min(day) FROM tick_open WHERE exch_ts::time >= '09:15'")
        first = cursor.fetchone()[0]
        if not first:
            return None
        cursor.execute("SELECT day, symbol, prev_low, open, fut FROM oops_paper_watch WHERE day >= %s ORDER BY day", (first,))
        watch_rows = cursor.fetchall()
        cursor.execute("SELECT day, max(slots) FROM oops_paper WHERE day >= %s GROUP BY day", (first,))
        slots_of = dict(cursor.fetchall())
    market = {(d["day"], r["symbol"]): r for d in days for r in d["picks"]}
    by_day = {}
    for d, s, pl, o, fut in watch_rows:
        by_day.setdefault(d, {})[s] = (pl, o, fut)
    fills = realfill.Fills(fills_slip)
    out_days, misses, todo = [], [], []
    for d, watch in sorted(by_day.items(), reverse=True):
        events = capped.oops_events(d, {s: w[0] for s, w in watch.items()})
        slots = slots_of.get(d) or max_open()
        skip = priority.skipped("oops", d)  # held by Gap / Cross-sectional before this buy: the next one instead
        taken = [e for e in events if e[2] and e[0] not in skip][:slots]
        todo.append((d, watch, taken, [e for e in events if not e[2]], [e for e in events if e[2] and e[0] in skip], skip))
    nxt = _next_opens([(s, d) for d, _, taken, missed, held, _ in todo for s, *_ in taken + missed + held if d < today])
    # held from an earlier day and today's daily candle not in yet: today's open from a quote (the next-open sale)
    need = {watch[s][2]: s for d, watch, taken, missed, held, _ in todo if d < today for s, *_ in taken + missed + held
            if (s, d) not in nxt and not (market.get((d.isoformat(), s)) or {}).get("closed") and watch[s][2]}
    if need and kite_auth.status().get("connected"):
        try:
            for f, q in _fut_quotes(kite_auth.trading_client(), sorted(need)).items():
                o, lt = (q.get("ohlc") or {}).get("open"), q.get("last_trade_time")
                if o and lt and lt.date() == today:
                    for d, watch, taken, missed, held, _ in todo:
                        if d < today and need.get(f) in watch and (need[f], d) not in nxt:
                            nxt[(need[f], d)] = (today, float(o))
        except Exception as error:
            print("Oops tick book: today's opens failed:", error)

    def exit_of(d, s):
        """(exit price, closed, exit day) as the book would: its own exit if it held it, else the next open."""
        m = market.get((d.isoformat(), s))
        if m and m["closed"]:
            return m["exit"], True, None
        if d == today:
            return (live.get(s) or {}).get("last_price"), False, None
        n = nxt.get((s, d))
        if n:
            return n[1], True, n[0]
        return (live.get(s) or {}).get("last_price"), False, None

    for d, watch, taken, missed, held, skip in todo:
        picks = []
        for s, trig, fill_at, px in taken:
            pl, o, fut = watch[s]
            ex, closed, xd = exit_of(d, s)
            k_out = fills.want(xd or d, s, "sell", realfill.at_open(xd), ex) if closed and xd else None
            picks.append({"symbol": s, "fut": fut, "side": "long", "gap_pct": round(100 * (o / pl - 1), 2), "prev_low": round(pl, 2),
                          "open": round(o, 2), "first_second": fill_at.time() <= clock(9, 15, 1), "stop": None,
                          "exit_at": "09:15:01" if xd else None,
                          "paper_entry": round(pl, 2), "entry": round(px, 2), "triggered_at": trig.strftime("%H:%M:%S"),
                          "filled_at": fill_at.strftime("%H:%M:%S"), "entry_at": f"{d.isoformat()} {fill_at:%H:%M:%S}",
                          "exit": round(ex, 2) if ex else None, "closed": closed, "reason": "next open" if closed else ("live" if ex else "open"),
                          "weight_pct": round(100 / slots, 3), "_w": 1.0 / slots, "_ret": ex / px - 1 if ex else None,
                          "_k": (None, k_out), "_x_in": -fills_slip})
        out_days.append({"day": d.isoformat(), "status": "closed" if all(r["closed"] for r in picks) else "open", "picks": picks})
        for s, trig, _, _ in missed + held:
            pl, o, fut = watch[s]
            ex, closed, xd = exit_of(d, s)
            k_in = fills.want(d, s, "buy", trig, pl) if realfill.in_window(trig) else None
            k_out = fills.want(xd, s, "sell", realfill.at_open(xd), ex) if closed and xd else None
            misses.append({"day": d.isoformat(), "symbol": s, "side": "long", "prev_low": round(pl, 2), "triggered_at": trig.strftime("%H:%M:%S"),
                           "reason": f"skipped: {skip[s]}" if s in skip else f"not filled within {capped.WAIT} s at {pl * (1 + capped.CAP['oops']):.2f} or better",
                           "skipped": s in skip,
                           "_row": {"symbol": s, "side": "long", "entry": pl, "exit": ex, "closed": closed,
                                    "_w": 1.0 / slots, "_ret": ex / pl - 1 if ex else None, "_k": (k_in, k_out)}})
    fills.load()
    return v2paper._capped_finish("oops", out_days, misses, fills, cps, lots, days)


def paper(slippage=0.0002):
    """The log in the paper pages' shape: days, each with its positions (one lot each, live prices for
    today's open ones), the watchlist, and the totals."""
    cps = xsmr.cost_per_side(slippage)
    now = gapwatch._now()
    today = now.date()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT p.day, p.symbol, p.prev_low, p.open, p.filled_at, p.entry, p.low_at_fill, p.stop, p.exit_at, p.exit, "
                       "p.reason, p.slots, p.fut, w.first_sec, p.fill_ask FROM oops_paper p LEFT JOIN oops_paper_watch w "
                       "ON w.day = p.day AND w.symbol = p.symbol ORDER BY p.day DESC, p.filled_at")
        trades = cursor.fetchall()
        cursor.execute("SELECT day, recorded_at, quoted, gapped, note FROM oops_paper_days ORDER BY day DESC LIMIT 60")
        day_rows = cursor.fetchall()
        cursor.execute("SELECT symbol, prev_low, open, fut FROM oops_paper_watch WHERE day = %s ORDER BY symbol", (today,))
        watch_rows = cursor.fetchall()
    watch = [w[:3] for w in watch_rows]
    fut_of = {w[0]: w[3] for w in watch_rows if w[3]}
    fut_of.update({t[1]: t[12] for t in trades if t[8] is None and t[12]})
    live = {}
    open_today = [r[1] for r in trades if r[8] is None]  # today's open ones and any held overnight
    want = sorted(set(open_today) | {w[0] for w in watch})
    ltp_at = None
    if want and kite_auth.status().get("connected"):
        try:
            fq = _fut_quotes(kite_auth.trading_client(), sorted({fut_of[s] for s in want if s in fut_of}))
            live = {s: fq[fut_of[s]] for s in want if fut_of.get(s) in fq}
            ltp_at = gapwatch._now().strftime("%H:%M:%S")
        except Exception as error:
            print("Oops paper: live prices failed:", error)
    lots = v2margin.table()
    fills = realfill.Fills(slippage)
    by_day = {}
    for day, s, pl, o, filled_at, entry, low_fill, stop, exit_at, exit_, reason, slots, fut, first_sec, fill_ask in trades:
        closed = exit_at is not None
        px = exit_ if closed else (live.get(s) or {}).get("last_price")
        w = 1.0 / slots
        ret = px / entry - 1 if px else None
        f_at = filled_at.astimezone(gapwatch.IST).replace(tzinfo=None)
        k_in = (fills.want(day, s, "buy", f_at, entry) if realfill.in_window(f_at) else
                fills.want_ask(entry, fill_ask) if fill_ask else None)  # the book at the fill: the tick log, else the stored ask
        k_out = None
        if closed and reason in ("next open", "15:15"):
            x_at = exit_at.astimezone(gapwatch.IST)
            k_out = fills.want(x_at.date(), s, "sell", realfill.at_open(x_at.date()) if reason == "next open" else realfill.at_close(x_at.date()), px)
        by_day.setdefault(day.isoformat(), []).append({"_k": (k_in, k_out), "_w": w, "_ret": ret,
            "symbol": s, "fut": fut, "first_second": bool(first_sec), "side": "long", "gap_pct": round(100 * (o / pl - 1), 2), "prev_low": round(pl, 2), "open": round(o, 2),
            "filled_at": filled_at.astimezone(gapwatch.IST).strftime("%H:%M:%S"), "entry": round(entry, 2), "stop": round(stop, 2) if stop is not None else None,
            "entry_at": f"{day.isoformat()} {filled_at.astimezone(gapwatch.IST).strftime('%H:%M:%S')}",
            "exit_at": f"{day.isoformat()} {exit_at.astimezone(gapwatch.IST).strftime('%H:%M:%S')}" if exit_at else f"{day.isoformat()} open",
            "exit": round(px, 2) if px else None, "reason": reason or ("live" if px else "open"), "closed": closed,
            "exit_at": exit_at.astimezone(gapwatch.IST).strftime("%H:%M:%S") if exit_at else None,
            "weight_pct": round(100 * w, 3)})
    fills.load()
    days = []
    for day, rows in sorted(by_day.items(), reverse=True):
        status = "closed" if all(r["closed"] for r in rows) else "open"
        for r in rows:
            v2paper.apply_row(r, fills, cps)
        days.append({"day": day, "status": status, "picks": rows, "net_pct": round(sum(r["book_net_pct"] for r in rows), 4),
                     **v2paper._lots(rows, lots, cps)})
    cap = _capped_version(days, today, live, fills_slip=slippage, cps=cps, lots=lots)
    days = v2paper.tick_book(days, cap)
    held = {r["symbol"] for d in days if d["day"] == today.isoformat() for r in d["picks"]}
    watchlist = [{"symbol": s, "prev_low": round(pl, 2), "open": round(o, 2), "gap_pct": round(100 * (o / pl - 1), 2),
                  "ltp": (live.get(s) or {}).get("last_price"), "high": ((live.get(s) or {}).get("ohlc") or {}).get("high"),
                  "to_trigger_pct": round(100 * (pl / live[s]["last_price"] - 1), 2) if (live.get(s) or {}).get("last_price") else None,
                  "bought": s in held}
                 for s, pl, o in watch]
    return {"now": now.strftime("%Y-%m-%d %H:%M:%S"), "today": today.isoformat(), "ltp_at": ltp_at,
            "market_open": today.weekday() < 5 and OPEN_AT <= now.time() < UNTIL, "max_open": max_open(), "stop_mode": stop_mode(), "exit_mode": exit_mode(), "stream": stream_status(), "max_open_limit": MAX_OPEN_LIMIT,
            "watchlist": sorted(watchlist, key=lambda w: (w["bought"], w["to_trigger_pct"] if w["to_trigger_pct"] is not None else 99)),
            "days": days, "summary": {**v2paper._summary(days), **v2paper._lot_summary(days, lots)},
            "first_second": _first_second(days),
            "log": [{"day": d.isoformat(), "recorded_at": r.astimezone(gapwatch.IST).strftime("%H:%M:%S"), "quoted": q, "gapped": g, "note": n}
                    for d, r, q, g, n in day_rows],
            "cost_per_side_bps": round(10000 * cps, 2), "capped": cap}
