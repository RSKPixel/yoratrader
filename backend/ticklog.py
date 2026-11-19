"""The open and the 15:15 exit, tick by tick: every Kite tick of every current-month stock future in two
windows a day, 09:14-09:16:30 and 15:14-15:15:30 (price, last traded quantity, volume, best bid and ask with their quantities, the five-level depth
totals, the exchange time), stored in tick_open. It answers whether a real order sent a second or two after
the open would have filled where a paper book assumes (the opening price, an Oops level).

Kite streams snapshots (about one a second per instrument when something changes), not every exchange
trade, so this is the finest it offers. Started by gapwatch's production scheduler at 09:14 on trading days;
a separate WebSocket from the Oops stream (Kite allows three per API key; one twisted loop runs both).
Nothing here places orders.
"""

import threading
from datetime import datetime, timedelta
from datetime import time as clock

from psycopg2.extras import Json, execute_values

import gapwatch
import kite_auth
import xsmrwatch
from db import connect, schema_once

# (start, until): the open (to 09:16:30: the capped-limit version's replacement orders, see capped.py), the 15:15 exit
WINDOWS = ((clock(9, 14), clock(9, 16, 30)), (clock(15, 14), clock(15, 15, 30)))
START_AT, UNTIL = WINDOWS[0]
_state = {"day": None, "ticker": None, "rows": [], "by_token": {}, "saved": None, "window": None}


def window(t):
    """The window a time of day falls in (to start a recording), or None."""
    return next((w for w in WINDOWS if w[0] <= t < w[1]), None)
_lock = threading.Lock()


@schema_once
def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS tick_open (
            day DATE NOT NULL, token BIGINT NOT NULL, fut TEXT NOT NULL, symbol TEXT NOT NULL,
            exch_ts TIMESTAMP, recv_ts TIMESTAMPTZ NOT NULL,
            ltp DOUBLE PRECISION, last_qty INTEGER, volume BIGINT,
            bid DOUBLE PRECISION, bid_qty INTEGER, ask DOUBLE PRECISION, ask_qty INTEGER,
            buy_qty BIGINT, sell_qty BIGINT, depth JSONB
        );
        CREATE INDEX IF NOT EXISTS tick_open_day ON tick_open (day, symbol, exch_ts);
        """
    )


def _on_ticks(ws, ticks):
    now = gapwatch._now()
    for tk in ticks:
        meta = _state["by_token"].get(tk.get("instrument_token"))
        if not meta:
            continue
        d = tk.get("depth") or {}
        b, a = (d.get("buy") or [{}])[0], (d.get("sell") or [{}])[0]
        ts = tk.get("exchange_timestamp") or tk.get("last_trade_time")
        if ts is not None:  # Kite's library gives the server's local clock (UTC in the container): store India time
            ts = ts.astimezone(gapwatch.IST).replace(tzinfo=None)
        _state["rows"].append((now.date(), tk["instrument_token"], meta[0], meta[1], ts, now, tk.get("last_price"),
                               tk.get("last_traded_quantity") or tk.get("last_quantity"), tk.get("volume_traded") or tk.get("volume"),
                               b.get("price") or None, b.get("quantity") or None, a.get("price") or None, a.get("quantity") or None,
                               tk.get("total_buy_quantity"), tk.get("total_sell_quantity"), Json(d) if d else None))
    if _state["window"] and now.time() >= _state["window"][1]:
        threading.Thread(target=stop, daemon=True, name="ticklog-stop").start()


def start():
    """09:14 and 15:14 on a trading day: open the stream on every current-month stock future, once a window."""
    now = gapwatch._now()
    today = now.date()
    w = window(now.time())
    if today.weekday() >= 5 or not w:
        return {"started": False}
    with _lock:
        if (_state["day"], _state["window"]) == (today, w):
            return {"started": False, "reason": "already this window"}
        if not kite_auth.status().get("connected"):
            return {"started": False, "reason": "Kite not connected"}
        from kiteconnect import KiteTicker
        kite = kite_auth.trading_client()
        futs = xsmrwatch._current_futures(kite, today)
        _state.update(day=today, window=w, rows=[], saved=None, by_token={tok: (f, s) for s, (f, tok) in futs.items()})
        t = KiteTicker(kite.api_key, kite.access_token)
        toks = list(_state["by_token"])
        t.on_ticks = _on_ticks
        t.on_connect = lambda ws, resp: (ws.subscribe(toks), ws.set_mode(ws.MODE_FULL, toks))
        t.on_error = lambda ws, code, reason: print("Tick log stream error:", code, reason)
        _state["ticker"] = t
        t.connect(threaded=True)
        left = (datetime.combine(today, w[1]) - now.replace(tzinfo=None)).total_seconds()
        threading.Timer(max(30, left + 30), stop).start()  # a fallback: closed and saved 30 s after the window even if the ticks stop
        print("Tick log: stream started,", len(toks), "futures")
        return {"started": True, "futures": len(toks)}


def stop():
    """Close the stream and store the ticks (once)."""
    with _lock:
        t, rows, w = _state["ticker"], _state["rows"], _state["window"]
        if t is None:
            return
        _state.update(ticker=None, rows=[])
    try:
        from twisted.internet import reactor
        reactor.callFromThread(t.close)
    except Exception as error:
        print("Tick log: closing the stream failed:", error)
    end = (datetime.combine(datetime.min, w[1]) + timedelta(seconds=30)).time()
    rows = [r for r in rows if r[5].time() <= end]
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        if rows:
            execute_values(cursor, "INSERT INTO tick_open (day, token, fut, symbol, exch_ts, recv_ts, ltp, last_qty, volume, bid, bid_qty, "
                                   "ask, ask_qty, buy_qty, sell_qty, depth) VALUES %s", rows, page_size=2000)
        conn.commit()
    _state["saved"] = len(rows)
    print("Tick log: stored", len(rows), "ticks")


def status():
    return {"day": _state["day"].isoformat() if _state["day"] else None, "recording": _state["ticker"] is not None,
            "saved": _state["saved"]}
