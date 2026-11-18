"""The open, tick by tick: every Kite tick of every current-month stock future from just before the open to
09:15:30 (price, last traded quantity, volume, best bid and ask with their quantities, the five-level depth
totals, the exchange time), stored in tick_open. It answers whether a real order sent a second or two after
the open would have filled where a paper book assumes (the opening price, an Oops level).

Kite streams snapshots (about one a second per instrument when something changes), not every exchange
trade, so this is the finest it offers. Started by gapwatch's production scheduler at 09:14 on trading days;
a separate WebSocket from the Oops stream (Kite allows three per API key; one twisted loop runs both).
Nothing here places orders.
"""

import threading
from datetime import datetime
from datetime import time as clock

from psycopg2.extras import Json, execute_values

import gapwatch
import kite_auth
import xsmrwatch
from db import connect, schema_once

START_AT, UNTIL = clock(9, 14), clock(9, 15, 30)
_state = {"day": None, "ticker": None, "rows": [], "by_token": {}, "saved": None}
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
        _state["rows"].append((now.date(), tk["instrument_token"], meta[0], meta[1], ts, now, tk.get("last_price"),
                               tk.get("last_traded_quantity") or tk.get("last_quantity"), tk.get("volume_traded") or tk.get("volume"),
                               b.get("price") or None, b.get("quantity") or None, a.get("price") or None, a.get("quantity") or None,
                               tk.get("total_buy_quantity"), tk.get("total_sell_quantity"), Json(d) if d else None))
    if now.time() >= UNTIL:
        threading.Thread(target=stop, daemon=True, name="ticklog-stop").start()


def start():
    """09:14 on a trading day: open the stream on every current-month stock future, once a day."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or not (START_AT <= now.time() < UNTIL):
        return {"started": False}
    with _lock:
        if _state["day"] == today:
            return {"started": False, "reason": "already today"}
        if not kite_auth.status().get("connected"):
            return {"started": False, "reason": "Kite not connected"}
        from kiteconnect import KiteTicker
        kite = kite_auth.trading_client()
        futs = xsmrwatch._current_futures(kite, today)
        _state.update(day=today, rows=[], saved=None, by_token={tok: (f, s) for s, (f, tok) in futs.items()})
        t = KiteTicker(kite.api_key, kite.access_token)
        toks = list(_state["by_token"])
        t.on_ticks = _on_ticks
        t.on_connect = lambda ws, resp: (ws.subscribe(toks), ws.set_mode(ws.MODE_FULL, toks))
        t.on_error = lambda ws, code, reason: print("Tick log stream error:", code, reason)
        _state["ticker"] = t
        t.connect(threaded=True)
        threading.Timer(120, stop).start()  # a fallback: closed and saved by 09:16 even if the ticks stop
        print("Tick log: stream started,", len(toks), "futures")
        return {"started": True, "futures": len(toks)}


def stop():
    """Close the stream and store the ticks (once)."""
    with _lock:
        t, rows = _state["ticker"], _state["rows"]
        if t is None:
            return
        _state.update(ticker=None, rows=[])
    try:
        from twisted.internet import reactor
        reactor.callFromThread(t.close)
    except Exception as error:
        print("Tick log: closing the stream failed:", error)
    rows = [r for r in rows if r[5].time() <= clock(9, 16)]
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
