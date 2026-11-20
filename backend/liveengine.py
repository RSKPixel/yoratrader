"""The live order engine for enabled live items (liveitems.py). An item's "Orders" setting: Dry run (the default) or
Real orders. REAL ORDERS ARE SENT ONLY FROM PRODUCTION with LIVE_ORDERS=on in its environment (real_orders_allowed()):
dev, previews and every other path build and log orders only. Real orders are checked against the broker's order
book every minute (reconcile): fills, the average price, a buy not filled 10 minutes on cancelled, a sale not filled
re-priced each minute to 09:45 / 15:28.

At each model's times in the live market
it decides the item's orders on the item's own settings and holdings, builds the exact request each broker's API
would get (Zerodha Kite Connect place_order / place_gtt, Angel One SmartAPI placeOrder / gtt createRule), and
LOGS it (live_order_log). Nothing is sent: this module never calls a broker's order API. An order logged is taken
as filled at the price then (the open's auction price for a pre-open order), so the item's holdings (live_positions)
move on as they would.

Built: short-term mean reversion (both setups) and turn of the month. Other models log nothing yet.

Short-term mean reversion, as its paper book (connorswatch.py) but on the item's settings:
  15:15  the item's disaster stops (the day's low reached the stop: the stop order would have sold it), the
         exits (5th trading day, or on strength: RSI(2) above 65), sold now (Exit at: At close) or queued for the
         next open (At next open: the slot stays taken until sold), and the buys into the free slots (the setup's
         most extreme signals not held): a marketable LIMIT, plus the stop order (GTT) if the disaster stop is on
  09:00  (pre-open order entry) the queued sales: a LIMIT well under the last close, so it fills at the auction
  09:09  the queued sales taken as filled at the opening price
Every LIMIT price is on the instrument's tick and inside the day's price band (circuit limits). Angel One orders use
variety NORMAL at every hour: its API has no AMO variety (sent after hours, a NORMAL order becomes an AMO itself;
tested 20 Nov 2026). Zerodha's after-hours orders would be variety "amo"; the engine's orders are in market hours
(15:15) or the pre-open (09:00-09:07), both "regular".
Run by gapwatch's production scheduler (prod only), trading days only.
"""

import json
import math
import os
import threading
from datetime import datetime, timedelta
from datetime import time as clock

import requests
from psycopg2.extras import Json

import gapwatch
import kite_auth
import liveitems
from db import connect, schema_once

def real_orders_allowed():
    """Real orders only from production, and only with LIVE_ORDERS=on set there (never from dev)."""
    return os.environ.get("APP_ENV") == "production" and os.environ.get("LIVE_ORDERS") == "on"


def _real(item, preview=False):
    return not preview and item["settings"].get("orders") == "real" and real_orders_allowed()


BUY_CANCEL_AFTER = timedelta(minutes=10)  # a buy not filled 10 minutes after it went in: cancelled (what filled is kept)
SELL_RETRY_UNTIL = {"open": clock(9, 45), "close": clock(15, 28)}  # a sale not filled: re-priced each minute until then
SELL_RETRY_BELOW = 0.01  # a re-priced sale: 1% under the last price (inside the band)
CLOSE_AT, CLOSE_UNTIL = clock(15, 15), clock(15, 20)
PREOPEN_AT, PREOPEN_UNTIL = clock(9, 0), clock(9, 7)
OPEN_FILL_AT, OPEN_FILL_UNTIL = clock(9, 9), clock(9, 30)
BUY_ABOVE = 0.005  # a buy's LIMIT: 0.5% over the last price (marketable, capped)
SELL_BELOW = 0.005  # a sale's LIMIT at 15:15: 0.5% under the last price
PREOPEN_BELOW = 0.05  # a pre-open sale's LIMIT: 5% under the last close (fills at the auction price above it)
STOP_PCT = 0.10  # the disaster stop: 10% under the buy
STOP_LIMIT_BELOW = 0.05  # the stop's sell order: a LIMIT 5% under its trigger (a fast fall still fills; inside a 5% band)
MAX_DAYS = 5
ANGEL_MASTER = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
_cache = {}
_local = __import__("threading").local()  # a preview's log lines, on its own thread only (the scheduler's runs log as usual)


@schema_once
def _ensure(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS live_positions (
            id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL, symbol TEXT NOT NULL, instrument TEXT NOT NULL,
            exchange TEXT NOT NULL, tradingsymbol TEXT NOT NULL, expiry DATE, qty INTEGER NOT NULL,
            buy_day DATE NOT NULL, buy_at TIMESTAMPTZ NOT NULL, buy_price DOUBLE PRECISION NOT NULL, stop DOUBLE PRECISION,
            sell_queued DATE, sell_reason TEXT, sell_day DATE, sell_at TIMESTAMPTZ, sell_price DOUBLE PRECISION
        );
        CREATE TABLE IF NOT EXISTS live_order_log (
            id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), item_id INTEGER NOT NULL, item_name TEXT,
            broker TEXT, event TEXT NOT NULL, symbol TEXT, reason TEXT, payload JSONB, status TEXT NOT NULL, note TEXT
        );
        CREATE INDEX IF NOT EXISTS live_order_log_item ON live_order_log (item_id, at DESC);
        CREATE TABLE IF NOT EXISTS live_runs (item_id INTEGER NOT NULL, day DATE NOT NULL, kind TEXT NOT NULL,
            at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (item_id, day, kind));
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS real BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS buy_order TEXT;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS buy_status TEXT;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS buy_placed_at TIMESTAMPTZ;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS sell_order TEXT;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS sell_status TEXT;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS sell_session TEXT;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS sell_filled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS sell_value DOUBLE PRECISION NOT NULL DEFAULT 0;
        ALTER TABLE live_order_log ADD COLUMN IF NOT EXISTS order_id TEXT;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS strike DOUBLE PRECISION;
        ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS sell_plan DATE;
        """
    )


# ---- prices on the exchange's tick, the instruments' lots and ticks -------------------------------------------

def _instruments(kite, today):
    """{(exchange, tradingsymbol): (lot_size, tick_size)} for NSE and NFO, from Kite once a day."""
    if _cache.get("inst_day") != today:
        out = {}
        for ex in ("NSE", "NFO"):
            for r in kite.instruments(ex):
                out[(ex, r["tradingsymbol"])] = (int(r.get("lot_size") or 1), float(r.get("tick_size") or 0.05))
        _cache.update(inst_day=today, inst=out)
    return _cache["inst"]


def _on_tick(price, tick, up):
    n = price / tick
    n = math.ceil(n - 1e-9) if up else math.floor(n + 1e-9)
    return round(n * tick, 2)


def _in_band(price, quote, tick, up):
    """A limit price on the tick and inside the day's price band (circuit limits): the exchanges, and Kite before
    them, refuse an order priced outside it (a buy above the upper limit, a sale under the lower)."""
    p = _on_tick(price, tick, up)
    lo, hi = (quote or {}).get("lower_circuit_limit"), (quote or {}).get("upper_circuit_limit")
    if hi and p > hi:
        p = _on_tick(hi, tick, False)
    if lo and p < lo:
        p = _on_tick(lo, tick, True)
    return p


def _angel_tokens(today):
    """{("NSE", symbol) or ("NFO", name, expiry): (Angel tradingsymbol, token)} from Angel One's scrip master, once a day."""
    if _cache.get("angel_day") != today:
        out = {}
        for r in requests.get(ANGEL_MASTER, timeout=120).json():
            seg = r.get("exch_seg")
            if seg == "NSE" and str(r.get("symbol", "")).endswith("-EQ"):
                out[("NSE", r["name"])] = (r["symbol"], r["token"])
            elif seg == "NFO" and r.get("instrumenttype") in ("FUTSTK", "FUTIDX"):
                out[("NFO", r["name"], datetime.strptime(r["expiry"], "%d%b%Y").date())] = (r["symbol"], r["token"])
            elif seg == "NFO" and r.get("instrumenttype") == "OPTIDX" and r.get("name") == "NIFTY" and str(r.get("symbol", "")).endswith("CE"):
                out[("NFO", "NIFTY", datetime.strptime(r["expiry"], "%d%b%Y").date(), int(round(float(r["strike"]) / 100)), "CE")] = (r["symbol"], r["token"])
        _cache.update(angel_day=today, angel=out)
    return _cache["angel"]


# ---- the orders, as each broker's API would get them -----------------------------------------------------------

def _payloads(broker, item_id, side, pos, price, today, kind="order"):
    """The request for one order. pos: {symbol, instrument, exchange, tradingsymbol, qty, expiry}. kind: "order"
    (a DAY LIMIT order) or "stop" (a GTT: trigger at price, a LIMIT sell STOP_LIMIT_BELOW under it)."""
    fut = pos["exchange"] == "NFO"  # futures and options: carried overnight (NRML / CARRYFORWARD)
    tag = f"ytlive{item_id}"[:20]
    if broker == "kite":
        product = "NRML" if fut else "CNC"
        if kind == "stop":
            limit = _on_tick(price * (1 - STOP_LIMIT_BELOW), pos["tick"], False)
            return {"api": "kite.place_gtt", "trigger_type": "single", "tradingsymbol": pos["tradingsymbol"], "exchange": pos["exchange"],
                    "trigger_values": [price], "last_price": pos.get("last"),
                    "orders": [{"exchange": pos["exchange"], "tradingsymbol": pos["tradingsymbol"], "transaction_type": "SELL",
                                "quantity": pos["qty"], "order_type": "LIMIT", "product": product, "price": limit}]}
        return {"api": "kite.place_order", "variety": "regular", "exchange": pos["exchange"], "tradingsymbol": pos["tradingsymbol"],
                "transaction_type": side, "quantity": pos["qty"], "product": product, "order_type": "LIMIT", "price": price,
                "validity": "DAY", "tag": tag}
    # Angel One SmartAPI: strings, its own symbols and tokens (scrip master)
    try:
        toks = _angel_tokens(today)
        key = (("NFO", pos["symbol"], pos["expiry"], int(round(pos["strike"])), "CE") if pos["instrument"] == "call"
               else ("NFO", pos["symbol"], pos["expiry"]) if fut else ("NSE", pos["symbol"]))
        a_sym, a_tok = toks[key]
    except Exception as error:
        a_sym, a_tok = None, None
        print("Live engine: Angel One symbol not found:", pos["symbol"], error)
    product = "CARRYFORWARD" if fut else "DELIVERY"
    if kind == "stop":
        if fut:
            return {"api": "angel.gtt.createRule", "unsupported": "Angel One GTT is for cash (NSE / BSE) only: no stop on a future or option"}
        limit = _on_tick(price * (1 - STOP_LIMIT_BELOW), pos["tick"], False)
        return {"api": "angel.gtt.createRule", "tradingsymbol": a_sym, "symboltoken": a_tok, "exchange": "NSE", "transactiontype": "SELL",
                "producttype": product, "price": str(limit), "qty": str(pos["qty"]), "triggerprice": str(price), "disclosedqty": "0",
                "timeperiod": "365"}
    return {"api": "angel.placeOrder", "variety": "NORMAL", "tradingsymbol": a_sym, "symboltoken": a_tok, "transactiontype": side,
            "exchange": pos["exchange"], "ordertype": "LIMIT", "producttype": product, "duration": "DAY", "price": str(price),
            "squareoff": "0", "stoploss": "0", "quantity": str(pos["qty"]), "ordertag": tag}


def _log(cursor, item, event, symbol=None, reason=None, payload=None, note=None, status=None, order_id=None):
    broker = "zerodha" if item["account"] == "kite" else "angelone" if item["account"] == "angel" else item["account"]
    status = status or ("dry-run" if payload and not payload.get("unsupported") else "note")
    if getattr(_local, "capture", None) is not None:  # a preview: kept in memory only
        _local.capture.append({"event": event, "symbol": symbol, "reason": reason, "payload": payload, "status": status, "note": note})
        return
    cursor.execute("INSERT INTO live_order_log (item_id, item_name, broker, event, symbol, reason, payload, status, note, order_id) "
                   "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                   (item["id"], item["name"], broker, event, symbol, reason, Json(payload) if payload else None, status, note, order_id))
    print(f"Live engine [{status}] {item['name']}: {event} {symbol or ''} {reason or ''} {json.dumps(payload) if payload else note or ''}")


# ---- the brokers (real orders) -------------------------------------------------------------------------------

def _angel(method, path, payload=None):
    """An Angel One SmartAPI call, logged in (again, once, if the session has expired)."""
    import angel_auth
    for attempt in (1, 2):
        if not angel_auth._session["jwt"]:
            angel_auth.login()
        h = angel_auth._headers(angel_auth._settings()["ANGEL_API_KEY"], angel_auth._session["jwt"])
        r = requests.request(method, f"{angel_auth.BASE}{path}", headers=h, json=payload, timeout=30)
        body = r.json() if r.content else {"status": False, "message": f"HTTP {r.status_code}"}
        if body.get("status") is False and attempt == 1 and ("token" in str(body.get("message", "")).lower() or r.status_code in (401, 403)):
            angel_auth._session.update(jwt=None)
            continue
        return body
    return body


def _send(item, payload):
    """Send one order (REAL). Returns (order_id, error)."""
    if not real_orders_allowed():
        return None, "real orders are not allowed here"
    req = {k: v for k, v in payload.items() if k != "api"}
    try:
        if item["account"] == "kite":
            return kite_auth.trading_client().place_order(**req), None
        if item["account"] == "angel":
            if not req.get("symboltoken"):
                return None, "Angel One symbol not found"
            body = _angel("POST", "/rest/secure/angelbroking/order/v1/placeOrder", req)
            oid = (body.get("data") or {}).get("orderid")
            return (oid, None) if body.get("status") and oid else (None, body.get("message") or "refused")
        return None, f"unknown account {item['account']}"
    except Exception as error:
        return None, str(error)


def _statuses(item, order_ids):
    """{order_id: {"status": open | complete | cancelled | rejected, "filled", "avg", "text"}} from the broker's order book."""
    out = {}
    if item["account"] == "kite":
        for o in kite_auth.trading_client().orders():
            if o["order_id"] in order_ids:
                st = {"COMPLETE": "complete", "CANCELLED": "cancelled", "REJECTED": "rejected"}.get(o["status"], "open")
                out[o["order_id"]] = {"status": st, "filled": int(o.get("filled_quantity") or 0), "avg": float(o.get("average_price") or 0),
                                      "text": o.get("status_message") or o["status"]}
    elif item["account"] == "angel":
        body = _angel("GET", "/rest/secure/angelbroking/order/v1/getOrderBook")
        for o in body.get("data") or []:
            if o.get("orderid") in order_ids:
                raw = str(o.get("orderstatus") or o.get("status") or "").lower()
                st = "complete" if raw == "complete" else "cancelled" if raw == "cancelled" else "rejected" if raw == "rejected" else "open"
                out[o["orderid"]] = {"status": st, "filled": int(float(o.get("filledshares") or 0)), "avg": float(o.get("averageprice") or 0),
                                     "text": o.get("text") or raw}
    return out


def _cancel(item, order_id):
    if not real_orders_allowed():
        return "real orders are not allowed here"
    try:
        if item["account"] == "kite":
            kite_auth.trading_client().cancel_order(variety="regular", order_id=order_id)
            return None
        body = _angel("POST", "/rest/secure/angelbroking/order/v1/cancelOrder", {"variety": "NORMAL", "orderid": order_id})
        return None if body.get("status") else body.get("message") or "refused"
    except Exception as error:
        return str(error)


def _once(cursor, item_id, today, kind):
    """True the first time an item's run of this kind happens today (claimed then)."""
    cursor.execute("INSERT INTO live_runs (item_id, day, kind) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING RETURNING 1", (item_id, today, kind))
    return cursor.fetchone() is not None


# ---- short-term mean reversion -------------------------------------------------------------------------------

def _sr_market(kite, today):
    """The 15:15 prices and signals both setups use, once a run: spot quotes, futures map and moves, and the
    signals on spot and on futures (computed when an item needs them)."""
    import connors
    import connorswatch
    quotes = gapwatch._quotes(kite, gapwatch._symbols())
    traded = sum(1 for q in quotes.values() if q.get("last_trade_time") and q["last_trade_time"].date() == today)
    if traded < 0.5 * max(1, len(quotes)):
        return None
    prices = {s: float(q["last_price"]) for s, q in quotes.items() if q.get("last_price")}
    futures = connorswatch._futures_for(kite, today)
    m = {"quotes": quotes, "prices": prices, "futures": futures, "signals": {}}

    def signals(pr):
        if pr not in m["signals"]:
            if pr == "futures":
                m["signals"][pr] = connors.live_signals_fut(connorswatch._fut_moves(kite, futures), today, "fno")
            else:
                m["signals"][pr] = connors.live_signals(prices, today, "fno")
        return m["signals"][pr]
    m["live"] = signals
    return m


def _fut_quotes(kite, symbols):
    q = {}
    keys = [f"NFO:{s}" for s in symbols]
    for i in range(0, len(keys), 400):
        q.update(kite.quote(keys[i:i + 400]))
    return {k.split(":", 1)[1]: v for k, v in q.items()}


def _held(cursor, item_id):
    cursor.execute("SELECT id, symbol, instrument, exchange, tradingsymbol, expiry, qty, buy_day, buy_price, stop, sell_queued, sell_reason, "
                   "real, buy_order, buy_status, buy_placed_at, sell_order, sell_status, sell_session, sell_filled, sell_value, strike, sell_plan "
                   "FROM live_positions WHERE item_id = %s AND sell_day IS NULL ORDER BY buy_day, id", (item_id,))
    cols = ("id", "symbol", "instrument", "exchange", "tradingsymbol", "expiry", "qty", "buy_day", "buy_price", "stop", "sell_queued", "sell_reason",
            "real", "buy_order", "buy_status", "buy_placed_at", "sell_order", "sell_status", "sell_session", "sell_filled", "sell_value", "strike", "sell_plan")
    return [dict(zip(cols, r)) for r in cursor.fetchall()]


def _sr_close(item, kite, today, now, market, preview=False):
    import connors
    import connorswatch
    s = item["settings"]
    pr, setup, mode = s.get("price", "spot"), s.get("setup", "rsi2"), s.get("trade_at", "closeopen")
    live = market["live"](pr)
    if not live["stocks"]:
        return {"item": item["id"], "note": "no session"}
    inst = _instruments(kite, today)
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()  # the tables first, on their own (a preview rolls its run back)
        if not _once(cursor, item["id"], today, "close") and not preview:
            return None
        real = _real(item, preview)
        if real:
            if s.get("disaster") == "on":
                _log(cursor, item, "error", note="the disaster stop isn't built for live orders yet: turn it off, or Orders to Dry run")
                conn.commit()
                return None
            conn.commit()  # the run claimed before any order goes out: a crash can't send twice
        held = _held(cursor, item["id"])
        futs_held = [p["tradingsymbol"] for p in held if p["instrument"] == "futures"]
        fq = _fut_quotes(kite, futs_held) if futs_held else {}

        def quote(p):
            return fq.get(p["tradingsymbol"]) if p["instrument"] == "futures" else market["quotes"].get(p["symbol"])

        def last(p):
            return float((quote(p) or {}).get("last_price") or 0) or None

        def pos_of(p):
            return {**p, "tick": inst.get((p["exchange"], p["tradingsymbol"]), (1, 0.05))[1]}

        # the disaster stops: the day's low reached the stop, so the stop order (GTT) would have sold it
        for p in held:
            if p["stop"] is None or p["sell_queued"] or p["real"]:
                continue
            lo = ((quote(p) or {}).get("ohlc") or {}).get("low")
            if lo and lo <= p["stop"]:
                cursor.execute("UPDATE live_positions SET sell_day = %s, sell_at = %s, sell_price = %s, sell_reason = 'stop' WHERE id = %s",
                               (today, now, p["stop"], p["id"]))
                _log(cursor, item, "stop hit", p["symbol"], "disaster stop",
                     note=f"the day's low {lo} reached the stop {p['stop']}: its GTT would have sold {p['qty']} (taken as filled at the stop)")
                p["gone"] = True
        held = [p for p in held if not p.get("gone")]
        # the exits: the 5th trading day, or on strength (RSI(2) above 65)
        rsi_now = live.get("rsi_all", {})
        sells = []
        for p in held:
            if p["sell_queued"] or p["sell_order"] or p["buy_status"] == "pending":
                continue
            age = connorswatch._trading_days_between(cursor, p["buy_day"], today) + 1
            if age >= MAX_DAYS:
                sells.append((p, "time"))
            elif s.get("exit") == "strength" and rsi_now.get(p["symbol"]) is not None and rsi_now[p["symbol"]] > connors.EXIT_RSI:
                sells.append((p, "strength"))
        for p, reason in sells:
            if mode == "closeopen":  # sold at the next open: queued, the slot stays taken until then
                cursor.execute("UPDATE live_positions SET sell_queued = %s, sell_reason = %s WHERE id = %s", (today, reason, p["id"]))
                _log(cursor, item, "sell queued", p["symbol"], reason, note=f"sold at the next session's open (pre-open order from 09:00): {p['qty']} {p['tradingsymbol']}")
                p["sell_queued"] = today
            else:
                px = last(p)
                if not px:
                    _log(cursor, item, "skip", p["symbol"], reason, note="no price now: not sold")
                    continue
                q = pos_of(p)
                limit = _in_band(px * (1 - SELL_BELOW), quote(p), q["tick"], False)
                payload = _payloads(item["account"], item["id"], "SELL", q, limit, today)
                if p["real"] and real:
                    oid, err = _send(item, payload)
                    _log(cursor, item, "sell", p["symbol"], reason, payload, status="sent" if oid else "rejected", order_id=oid, note=err)
                    if oid:
                        cursor.execute("UPDATE live_positions SET sell_order = %s, sell_status = 'pending', sell_session = 'close', sell_reason = %s, "
                                       "sell_queued = %s WHERE id = %s", (oid, reason, today, p["id"]))
                    conn.commit()
                    continue
                _log(cursor, item, "sell", p["symbol"], reason, payload)
                cursor.execute("UPDATE live_positions SET sell_day = %s, sell_at = %s, sell_price = %s, sell_reason = %s WHERE id = %s",
                               (today, now, px, reason, p["id"]))
                p["gone"] = True
        held = [p for p in held if not p.get("gone")]
        # the buys: the setup's most extreme signals not held, into the free slots
        taken = {p["symbol"] for p in held}
        score = "cum" if setup == "cumrsi2" else "rsi"
        flag = "signal_cum" if setup == "cumrsi2" else "signal"
        cands = sorted((x for x in live["stocks"] if x[flag] and x["symbol"] not in taken), key=lambda x: x[score])
        free = max(0, int(s.get("max_open", 3)) - len(held))
        bought = []
        for x in cands:
            if len(bought) >= free:
                break
            sym = x["symbol"]
            if pr == "futures":
                fut, expiry = market["futures"].get(sym, (None, None))
                if not fut:
                    continue
                bq = _fut_quotes(kite, [fut]).get(fut) or {}
                px = float(bq.get("last_price") or 0) or None
                lot, tick = inst.get(("NFO", fut), (None, 0.05))
                pos = {"symbol": sym, "instrument": "futures", "exchange": "NFO", "tradingsymbol": fut, "qty": lot, "expiry": expiry, "tick": tick}
            else:
                px = market["prices"].get(sym)
                bq = market["quotes"].get(sym) or {}
                tick = inst.get(("NSE", sym), (1, 0.05))[1]
                qty = int(float(s.get("capital", 0)) / int(s.get("max_open", 3)) // px) if px else 0
                pos = {"symbol": sym, "instrument": "spot", "exchange": "NSE", "tradingsymbol": sym, "qty": qty, "expiry": None, "tick": tick}
            if not px or not pos["qty"]:
                _log(cursor, item, "skip", sym, f"{score} {x[score]}", note="no price, or the capital per slot buys less than one share")
                continue
            pos["last"] = px
            limit = _in_band(px * (1 + BUY_ABOVE), bq, pos["tick"], True)
            why = f"{'cumulative RSI(2)' if score == 'cum' else 'RSI(2)'} {x[score]:.1f}"
            payload = _payloads(item["account"], item["id"], "BUY", pos, limit, today)
            if real:
                slot_rs = float(s.get("capital", 0)) / int(s.get("max_open", 3)) if pr == "spot" else None
                if slot_rs and pos["qty"] * limit > slot_rs * 1.02:
                    _log(cursor, item, "skip", sym, why, note=f"the order's value {pos['qty'] * limit:.0f} is over the slot's {slot_rs:.0f}: not sent")
                    continue
                oid, err = _send(item, payload)
                _log(cursor, item, "buy", sym, why, payload, status="sent" if oid else "rejected", order_id=oid, note=err)
                if oid:
                    cursor.execute("INSERT INTO live_positions (item_id, symbol, instrument, exchange, tradingsymbol, expiry, qty, buy_day, buy_at, "
                                   "buy_price, real, buy_order, buy_status, buy_placed_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true, %s, 'pending', %s)",
                                   (item["id"], sym, pos["instrument"], pos["exchange"], pos["tradingsymbol"], pos["expiry"], pos["qty"], today, now,
                                    limit, oid, now))
                    bought.append(sym)
                conn.commit()
                continue
            _log(cursor, item, "buy", sym, why, payload)
            stop = _on_tick(px * (1 - STOP_PCT), pos["tick"], False) if s.get("disaster") == "on" else None
            if stop:
                _log(cursor, item, "stop", sym, "disaster stop 10%", _payloads(item["account"], item["id"], "SELL", pos, stop, today, kind="stop"))
            cursor.execute("INSERT INTO live_positions (item_id, symbol, instrument, exchange, tradingsymbol, expiry, qty, buy_day, buy_at, buy_price, stop) "
                           "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                           (item["id"], sym, pos["instrument"], pos["exchange"], pos["tradingsymbol"], pos["expiry"], pos["qty"], today, now, px, stop))
            bought.append(sym)
        if not bought and not sells:
            _log(cursor, item, "run", reason="15:15", note=f"nothing to do: {len(held)} held of {s.get('max_open')}, {len(cands)} signals not held")
        if preview:
            conn.rollback()  # a preview: nothing kept
        else:
            conn.commit()
    return {"item": item["id"], "sold": [p["symbol"] for p, _ in sells], "bought": bought}


def _sr_preopen(item, kite, today):
    """09:00-09:07: the queued sales as pre-open LIMIT orders, well under the last close (filled at the auction)."""
    inst = _instruments(kite, today)
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        held = [p for p in _held(cursor, item["id"]) if p["sell_queued"] and p["sell_queued"] < today and not p["sell_order"]]
        if not held or not _once(cursor, item["id"], today, "preopen"):
            return None
        conn.commit()  # claimed before any order goes out
        q = kite.quote([f"{p['exchange']}:{p['tradingsymbol']}" for p in held])
        for p in held:
            pq = q.get(f"{p['exchange']}:{p['tradingsymbol']}") or {}
            close = (pq.get("ohlc") or {}).get("close")
            if not close:
                _log(cursor, item, "skip", p["symbol"], p["sell_reason"], note="no last close: the pre-open sale not built")
                continue
            pos = {**p, "tick": inst.get((p["exchange"], p["tradingsymbol"]), (1, 0.05))[1]}
            payload = _payloads(item["account"], item["id"], "SELL", pos, _in_band(close * (1 - PREOPEN_BELOW), pq, pos["tick"], False), today)
            if p["real"]:
                if not _real(item):
                    _log(cursor, item, "error", p["symbol"], p["sell_reason"], payload,
                         note="a live holding, but live orders are off here (Orders setting, or not production): sell it by hand")
                    continue
                oid, err = _send(item, payload)
                _log(cursor, item, "sell", p["symbol"], f"{p['sell_reason']} (pre-open)", payload, status="sent" if oid else "rejected", order_id=oid, note=err)
                if oid:
                    cursor.execute("UPDATE live_positions SET sell_order = %s, sell_status = 'pending', sell_session = 'open' WHERE id = %s", (oid, p["id"]))
                conn.commit()
                continue
            _log(cursor, item, "sell", p["symbol"], f"{p['sell_reason']} (pre-open)", payload)
        conn.commit()
    return {"item": item["id"], "preopen": [p["symbol"] for p in held]}


def _sr_open_fill(item, kite, today, now):
    """09:09 on: the queued sales taken as filled at the opening (auction) price."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        held = [p for p in _held(cursor, item["id"]) if p["sell_queued"] and p["sell_queued"] < today and not p["real"]]
        if not held:
            return None
        q = kite.quote([f"{p['exchange']}:{p['tradingsymbol']}" for p in held])
        done = []
        for p in held:
            x = q.get(f"{p['exchange']}:{p['tradingsymbol']}") or {}
            o, ltt = (x.get("ohlc") or {}).get("open"), x.get("last_trade_time")
            if not o or not ltt or ltt.date() != today:
                continue  # not opened yet: the next minute
            cursor.execute("UPDATE live_positions SET sell_day = %s, sell_at = %s, sell_price = %s WHERE id = %s", (today, now, o, p["id"]))
            _log(cursor, item, "filled", p["symbol"], p["sell_reason"], note=f"the pre-open sale taken as filled at the open {o} ({p['qty']})")
            done.append(p["symbol"])
        conn.commit()
    return {"item": item["id"], "filled": done} if done else None


# ---- turn of the month ---------------------------------------------------------------------------------------
# As its paper book (tomwatch.py) and the backtest: bought at 15:15 on the month's 5th-last trading day, sold at
# 15:15 on the next month's 3rd trading day (v2tom's calendar, NSE's holidays). On the item's settings: the
# instrument (an in-the-money Nifty call of the next month's expiry, v2tom's pick: 2-3.5% in the money, the
# tightest spread; or the nearest Nifty future expiring after the sale day, as the paper book) and the lots.
# A buy's LIMIT: the best offer (or the last price) + 0.5%, a sale's: the best bid (or the last) - 0.5%, both on
# the tick and inside the band. No stop (the book has none).

def _tom_pick(kite, today, plan, s, inst):
    """What the buy day's run buys: a position dict (with "last", "quote") or (None, why)."""
    import tomwatch
    import v2tom
    lots = int(s.get("lots", 1))
    buy = datetime.fromisoformat(plan["buy"]).date()
    sell = datetime.fromisoformat(plan["sell"]).date()
    if s.get("instrument", "call") == "future":
        fut, expiry, lot = tomwatch._contract(kite, sell)
        pos = {"symbol": "NIFTY", "instrument": "futures", "exchange": "NFO", "tradingsymbol": fut, "expiry": expiry, "strike": None}
    else:
        exp = v2tom._nifty_option_expiry(kite, (buy.year, buy.month))
        fut = v2tom._plan_cache.get("futures", {}).get(exp) if exp else None
        if not exp or not fut:
            return None, "no Nifty option expiry / future for next month"
        best, _ = v2tom._best_call(kite, float(kite.ltp([f"NFO:{fut}"])[f"NFO:{fut}"]["last_price"]), exp)
        if not best:
            return None, "no in-the-money call 2-3.5% under the future with a bid and an offer"
        lot = best["lot"]
        pos = {"symbol": "NIFTY", "instrument": "call", "exchange": "NFO", "tradingsymbol": best["symbol"], "expiry": exp, "strike": best["strike"]}
    k = f"NFO:{pos['tradingsymbol']}"
    q = kite.quote([k]).get(k) or {}
    pos.update(qty=int(lot) * lots, tick=inst.get(("NFO", pos["tradingsymbol"]), (1, 0.05))[1], last=q.get("last_price"), quote=q, sell_plan=sell)
    return pos, None


def _best(q, side):
    d = ((q.get("depth") or {}).get("sell" if side == "BUY" else "buy") or [{}])[0]
    return d.get("price") or q.get("last_price")


def _tom_close(item, kite, today, now, preview=False, force_buy=False):
    import v2tom
    s = item["settings"]
    holidays, _ = v2tom._holidays(today)
    if today in holidays and not preview:
        return None
    plan = v2tom.plan(today, live=False)
    inst = _instruments(kite, today)
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()  # the tables first, on their own (a preview rolls its run back)
        if not _once(cursor, item["id"], today, "close") and not preview:
            return None
        real = _real(item, preview)
        if real:
            conn.commit()  # the run claimed before any order goes out: a crash can't send twice
        held = _held(cursor, item["id"])
        sold, bought = [], []
        for p in held:  # the sale: on its own sale day (a missed one: the next run)
            if p["sell_order"] or p["buy_status"] == "pending" or not p["sell_plan"] or today < p["sell_plan"]:
                continue
            k = f"{p['exchange']}:{p['tradingsymbol']}"
            q = kite.quote([k]).get(k) or {}
            px = _best(q, "SELL")
            if not px:
                _log(cursor, item, "skip", p["tradingsymbol"], "sale day", note="no price now: not sold")
                continue
            pos = {**p, "tick": inst.get((p["exchange"], p["tradingsymbol"]), (1, 0.05))[1]}
            limit = _in_band(px * (1 - SELL_BELOW), q, pos["tick"], False)
            payload = _payloads(item["account"], item["id"], "SELL", pos, limit, today)
            if p["real"]:
                if not real:
                    _log(cursor, item, "error", p["tradingsymbol"], "sale day", payload,
                         note="a live holding, but live orders are off here (Orders setting, or not production): sell it by hand")
                    continue
                oid, err = _send(item, payload)
                _log(cursor, item, "sell", p["tradingsymbol"], "sale day (3rd trading day)", payload, status="sent" if oid else "rejected", order_id=oid, note=err)
                if oid:
                    cursor.execute("UPDATE live_positions SET sell_order = %s, sell_status = 'pending', sell_session = 'close', sell_reason = 'tom', "
                                   "sell_queued = %s WHERE id = %s", (oid, today, p["id"]))
                    sold.append(p["tradingsymbol"])
                conn.commit()
                continue
            _log(cursor, item, "sell", p["tradingsymbol"], "sale day (3rd trading day)", payload)
            cursor.execute("UPDATE live_positions SET sell_day = %s, sell_at = %s, sell_price = %s, sell_reason = 'tom' WHERE id = %s",
                           (today, now, q.get("last_price") or px, p["id"]))
            sold.append(p["tradingsymbol"])
        still = [p for p in held if p["tradingsymbol"] not in sold]
        is_buy_day = plan["buy"] == today.isoformat() or force_buy
        if is_buy_day and not still:
            pos, why = _tom_pick(kite, today, plan, s, inst)
            if not pos:
                _log(cursor, item, "error", "NIFTY", "buy day", note=f"not bought: {why}")
            else:
                px = _best(pos["quote"], "BUY")
                if not px:
                    _log(cursor, item, "error", pos["tradingsymbol"], "buy day", note="not bought: no price")
                else:
                    limit = _in_band(px * (1 + BUY_ABOVE), pos["quote"], pos["tick"], True)
                    what = "call" if pos["instrument"] == "call" else "future"
                    why = f"buy day (5th-last trading day): {s.get('lots', 1)} lot{'s' if int(s.get('lots', 1)) > 1 else ''} of the {what}, sold {pos['sell_plan']}"
                    payload = _payloads(item["account"], item["id"], "BUY", pos, limit, today)
                    cols = ("INSERT INTO live_positions (item_id, symbol, instrument, exchange, tradingsymbol, expiry, strike, qty, buy_day, buy_at, buy_price, "
                            "sell_plan, real, buy_order, buy_status, buy_placed_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)")
                    if real:
                        oid, err = _send(item, payload)
                        _log(cursor, item, "buy", pos["tradingsymbol"], why, payload, status="sent" if oid else "rejected", order_id=oid, note=err)
                        if oid:
                            cursor.execute(cols, (item["id"], "NIFTY", pos["instrument"], "NFO", pos["tradingsymbol"], pos["expiry"], pos["strike"], pos["qty"],
                                                  today, now, limit, pos["sell_plan"], True, oid, "pending", now))
                            bought.append(pos["tradingsymbol"])
                        conn.commit()
                    else:
                        _log(cursor, item, "buy", pos["tradingsymbol"], why, payload)
                        cursor.execute(cols, (item["id"], "NIFTY", pos["instrument"], "NFO", pos["tradingsymbol"], pos["expiry"], pos["strike"], pos["qty"],
                                              today, now, pos["last"] or px, pos["sell_plan"], False, None, None, None))
                        bought.append(pos["tradingsymbol"])
        if not sold and not bought:
            _log(cursor, item, "run", reason="15:15", note=(f"holding {', '.join(p['tradingsymbol'] for p in still)}: sold {still[0]['sell_plan']}" if still
                 else f"nothing to do: next buy {plan['buy']}, sold {plan['sell']}"))
        if preview:
            conn.rollback()
        else:
            conn.commit()
    return {"item": item["id"], "sold": sold, "bought": bought}


# ---- real orders: fills from the broker's order book ---------------------------------------------------------

def reconcile(item, kite, now):
    """Every minute in market hours, for an item's real orders: a buy's fill (quantity and average price; not
    filled 10 minutes on: cancelled, what filled kept), a sale's fill (not filled: cancelled and re-priced 1% under
    the last price each minute, until 09:45 for a pre-open sale or 15:28 at the close; then left for you)."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        held = [p for p in _held(cursor, item["id"]) if p["real"] and (p["buy_status"] == "pending" or p["sell_status"] == "pending")]
        if not held:
            return None
        st = _statuses(item, {p["buy_order"] for p in held if p["buy_status"] == "pending"} | {p["sell_order"] for p in held if p["sell_status"] == "pending"})
        out = []
        for p in held:
            if p["buy_status"] == "pending":
                o = st.get(p["buy_order"])
                if not o:
                    if p["buy_placed_at"] and p["buy_placed_at"].astimezone(gapwatch.IST).date() < now.date():  # gone from today's book
                        cursor.execute("UPDATE live_positions SET buy_status = 'unknown' WHERE id = %s", (p["id"],))
                        _log(cursor, item, "error", p["symbol"], "buy", order_id=p["buy_order"],
                             note="the buy order isn't in today's order book: check it in the broker's app")
                    continue
                if o["status"] == "complete" or (o["status"] in ("cancelled", "rejected") and o["filled"]):
                    cursor.execute("UPDATE live_positions SET qty = %s, buy_price = %s, buy_status = 'filled' WHERE id = %s",
                                   (o["filled"], o["avg"] or p["buy_price"], p["id"]))
                    _log(cursor, item, "filled", p["symbol"], "buy", status="filled", order_id=p["buy_order"],
                         note=f"bought {o['filled']} at {o['avg']}" + ("" if o["status"] == "complete" else f" (the rest {o['status']}: {o['text']})"))
                    out.append(("bought", p["symbol"]))
                elif o["status"] in ("cancelled", "rejected"):
                    cursor.execute("DELETE FROM live_positions WHERE id = %s", (p["id"],))
                    _log(cursor, item, "not filled", p["symbol"], "buy", status=o["status"], order_id=p["buy_order"], note=o["text"])
                elif p["buy_placed_at"] and now - p["buy_placed_at"] > BUY_CANCEL_AFTER:
                    err = _cancel(item, p["buy_order"])
                    _log(cursor, item, "cancel", p["symbol"], "buy not filled in 10 minutes", status="sent" if not err else "rejected",
                         order_id=p["buy_order"], note=err)
            elif p["sell_status"] == "pending":
                o = st.get(p["sell_order"])
                if not o:
                    if p["sell_queued"] and p["sell_queued"] < now.date() and p["sell_session"] == "close":
                        cursor.execute("UPDATE live_positions SET sell_order = NULL, sell_status = 'retry' WHERE id = %s", (p["id"],))
                    continue
                left = p["qty"] - p["sell_filled"]
                if o["status"] == "complete" or (o["status"] in ("cancelled", "rejected") and o["filled"]):
                    filled, value = p["sell_filled"] + o["filled"], p["sell_value"] + o["filled"] * o["avg"]
                    if filled >= p["qty"]:
                        cursor.execute("UPDATE live_positions SET sell_day = %s, sell_at = %s, sell_price = %s, sell_status = 'filled', "
                                       "sell_filled = %s, sell_value = %s WHERE id = %s", (now.date(), now, round(value / filled, 4), filled, value, p["id"]))
                        _log(cursor, item, "filled", p["symbol"], "sell", status="filled", order_id=p["sell_order"],
                             note=f"sold {filled} at {round(value / filled, 2)}")
                        out.append(("sold", p["symbol"]))
                    else:
                        cursor.execute("UPDATE live_positions SET sell_filled = %s, sell_value = %s, sell_order = NULL, sell_status = 'retry' WHERE id = %s",
                                       (filled, value, p["id"]))
                        _log(cursor, item, "part filled", p["symbol"], "sell", status="filled", order_id=p["sell_order"],
                             note=f"{filled} of {p['qty']} sold: the rest re-priced")
                elif o["status"] in ("cancelled", "rejected"):
                    cursor.execute("UPDATE live_positions SET sell_order = NULL, sell_status = 'retry' WHERE id = %s", (p["id"],))
                    _log(cursor, item, "not filled", p["symbol"], "sell", status=o["status"], order_id=p["sell_order"], note=o["text"])
                elif now.time() >= (clock(9, 16) if p["sell_session"] == "open" else clock(15, 18)):
                    err = _cancel(item, p["sell_order"])  # still open after the auction / 3 minutes at the close: re-priced
                    _log(cursor, item, "cancel", p["symbol"], "sale not filled: re-pricing", status="sent" if not err else "rejected",
                         order_id=p["sell_order"], note=err)
        conn.commit()
        # a sale to send again: what's left, 1% under the last price, inside the band, until the session's limit
        cursor.execute("SELECT id FROM live_positions WHERE item_id = %s AND real AND sell_day IS NULL AND sell_status = 'retry'", (item["id"],))
        retry = {r[0] for r in cursor.fetchall()}
        if retry:
            inst = _instruments(kite, now.date())
            for p in _held(cursor, item["id"]):
                if p["id"] not in retry:
                    continue
                if now.time() >= SELL_RETRY_UNTIL.get(p["sell_session"] or "close", clock(15, 28)):
                    _log(cursor, item, "error", p["symbol"], "sell", note=f"not sold by {SELL_RETRY_UNTIL.get(p['sell_session'] or 'close')}: sell it by hand "
                         f"({p['qty'] - p['sell_filled']} {p['tradingsymbol']})")
                    cursor.execute("UPDATE live_positions SET sell_status = 'manual' WHERE id = %s", (p["id"],))
                    continue
                k = f"{p['exchange']}:{p['tradingsymbol']}"
                q = kite.quote([k]).get(k) or {}
                if not q.get("last_price"):
                    continue
                pos = {**p, "qty": p["qty"] - p["sell_filled"], "tick": inst.get((p["exchange"], p["tradingsymbol"]), (1, 0.05))[1]}
                payload = _payloads(item["account"], item["id"], "SELL", pos, _in_band(q["last_price"] * (1 - SELL_RETRY_BELOW), q, pos["tick"], False), now.date())
                oid, err = _send(item, payload)
                _log(cursor, item, "sell", p["symbol"], f"{p['sell_reason']} (re-priced)", payload, status="sent" if oid else "rejected", order_id=oid, note=err)
                if oid:
                    cursor.execute("UPDATE live_positions SET sell_order = %s, sell_status = 'pending' WHERE id = %s", (oid, p["id"]))
                conn.commit()
        conn.commit()
    return {"item": item["id"], "reconciled": out} if out else None


# ---- the scheduler's call ------------------------------------------------------------------------------------

ENGINES = ("short-term-reversion", "cumulative-rsi", "turn-of-month")
SR = ("short-term-reversion", "cumulative-rsi")


_tick_lock = threading.Lock()


def tick():
    """Every minute on a trading day (prod scheduler, in its own thread): each enabled item's run at its model's
    times, and its real orders checked against the broker (09:00-15:35). One run at a time."""
    if not _tick_lock.acquire(blocking=False):
        return {}
    try:
        return _tick()
    finally:
        _tick_lock.release()


def _tick():
    now = gapwatch._now()
    today, t = now.date(), now.time()
    if today.weekday() >= 5 or not (clock(9, 0) <= t < clock(15, 35)):
        return {}
    items = [i for i in liveitems.items()["items"] if i["enabled"] and i["model"] in ENGINES]
    if not items or not kite_auth.status().get("connected"):
        return {}  # Kite gives the prices and signals for every broker's item
    kite = kite_auth.trading_client()
    out = []
    market = None
    for item in items:
        try:
            if real_orders_allowed() and t >= clock(9, 1):
                r = reconcile(item, kite, now)
                if r:
                    out.append(r)
            if item["model"] == "turn-of-month":
                if CLOSE_AT <= t < CLOSE_UNTIL:
                    out.append(_tom_close(item, kite, today, now))
                continue
            if CLOSE_AT <= t < CLOSE_UNTIL:
                market = market or _sr_market(kite, today)
                if market is None:
                    continue  # a holiday: nothing traded today
                out.append(_sr_close(item, kite, today, now, market))
            elif PREOPEN_AT <= t < PREOPEN_UNTIL:
                out.append(_sr_preopen(item, kite, today))
            elif OPEN_FILL_AT <= t < OPEN_FILL_UNTIL:
                out.append(_sr_open_fill(item, kite, today, now))
        except Exception as error:
            print(f"Live engine: item {item['id']} failed:", error)
            try:
                with connect() as conn, conn.cursor() as cursor:
                    _ensure(cursor)
                    _log(cursor, item, "error", note=str(error))
                    conn.commit()
            except Exception:
                pass
    return {"runs": [r for r in out if r]}


def log(item_id, limit=100):
    """An item's order log (newest first) and its holdings (dry run)."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT id, at, broker, event, symbol, reason, payload, status, note, order_id FROM live_order_log WHERE item_id = %s "
                       "ORDER BY at DESC, id DESC LIMIT %s", (item_id, limit))
        rows = [{"id": i, "at": a.astimezone(gapwatch.IST).strftime("%Y-%m-%d %H:%M:%S"), "broker": b, "event": e, "symbol": s,
                 "reason": r, "payload": p, "status": st, "note": n, "order_id": o} for i, a, b, e, s, r, p, st, n, o in cursor.fetchall()]
        cursor.execute("SELECT symbol, instrument, tradingsymbol, qty, buy_day, buy_price, stop, sell_queued, sell_reason, sell_day, sell_price, "
                       "real, buy_status, sell_status FROM live_positions WHERE item_id = %s ORDER BY buy_day DESC, id DESC LIMIT 100", (item_id,))
        cols = ("symbol", "instrument", "tradingsymbol", "qty", "buy_day", "buy_price", "stop", "sell_queued", "sell_reason", "sell_day", "sell_price",
                "real", "buy_status", "sell_status")
        pos = []
        for r in cursor.fetchall():
            d = dict(zip(cols, r))
            for k in ("buy_day", "sell_queued", "sell_day"):
                d[k] = d[k].isoformat() if d[k] else None
            pos.append(d)
    return {"log": rows, "positions": pos, "real_allowed": real_orders_allowed()}


_preview_lock = __import__("threading").Lock()


def preview(item_id):
    """What the item's 15:15 run would do on the prices now: its orders as each broker's API would get them.
    Nothing is saved or sent (the run's changes are rolled back)."""
    item = next((i for i in liveitems.items()["items"] if i["id"] == item_id), None)
    if not item:
        raise ValueError("No such item")
    if item["model"] not in ENGINES:
        raise ValueError("No order engine for this model yet")
    if not kite_auth.status().get("connected"):
        raise ValueError("Kite isn't connected: the prices and signals come from Kite")
    kite = kite_auth.trading_client()
    now = gapwatch._now()
    if item["model"] == "turn-of-month":  # as if today were the buy day (or its sale day for what it holds)
        with _preview_lock:
            _local.capture = []
            try:
                _tom_close(item, kite, now.date(), now, preview=True, force_buy=True)
                lines = _local.capture
            finally:
                _local.capture = None
        return {"at": now.strftime("%Y-%m-%d %H:%M:%S"), "lines": lines}
    with _preview_lock:
        market = _sr_market(kite, now.date())
        if market is None:
            raise ValueError("The market hasn't traded today")
        _local.capture = []
        try:
            _sr_close(item, kite, now.date(), now, market, preview=True)
            lines = _local.capture
        finally:
            _local.capture = None
    return {"at": now.strftime("%Y-%m-%d %H:%M:%S"), "lines": lines}


_sig_cache = {}


def signals(item_id, settings=None):
    """settings: the settings on screen, not saved yet (shown on them). The model's signals now for an item, on the item's setup and instrument: every F&O stock above its
    200-day average with its 2-day RSI and cumulative RSI (the price now as today's close, as the 15:15 run
    computes them), whether it signals, and what the item would do with it (held / buy into a free slot /
    signal, no slot). Cached 30 s."""
    import time
    import connors
    item = next((i for i in liveitems.items()["items"] if i["id"] == item_id), None)
    if not item:
        raise ValueError("No such item")
    if item["model"] not in ENGINES:
        raise ValueError("No signals for this model yet")
    if settings:
        item = {**item, "settings": {**item["settings"], **liveitems._clean(item["model"], settings, strict=False)}}
    if not kite_auth.status().get("connected"):
        raise ValueError("Kite isn't connected: the prices and signals come from Kite")
    if item["model"] == "turn-of-month":
        return _tom_signals(item)
    s = item["settings"]
    pr, setup = s.get("price", "spot"), s.get("setup", "rsi2")
    now = gapwatch._now()
    hit = _sig_cache.get(pr)
    if hit and time.time() - hit[0] < 30:
        market = hit[1]
    else:
        market = _sr_market(kite_auth.trading_client(), now.date())
        _sig_cache[pr] = (time.time(), market)
    if market is None:
        return {"at": now.strftime("%H:%M:%S"), "stocks": [], "note": "No session today (weekend or holiday)"}
    live = market["live"](pr)
    import connorswatch
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        held = {p["symbol"]: p for p in _held(cursor, item_id)}
        for p in held.values():
            p["age"] = connorswatch._trading_days_between(cursor, p["buy_day"], now.date()) + 1
    rsi_all = live.get("rsi_all", {})
    fq = _fut_quotes(kite_auth.trading_client(), [p["tradingsymbol"] for p in held.values() if p["instrument"] == "futures"]) \
        if any(p["instrument"] == "futures" for p in held.values()) else {}

    def sell_signal(p):
        """A holding's sell signal now (the 15:15 run's checks), or None."""
        if p["sell_queued"]:
            return f"sale queued: next open ({p['sell_reason']})"
        q = fq.get(p["tradingsymbol"]) if p["instrument"] == "futures" else market["quotes"].get(p["symbol"])
        lo = ((q or {}).get("ohlc") or {}).get("low")
        if p["stop"] and lo and lo <= p["stop"]:
            return f"stop hit: the day's low {lo} reached {p['stop']}"
        if p["age"] >= MAX_DAYS:
            return f"sell: day {p['age']} of {MAX_DAYS} (time exit)"
        r = rsi_all.get(p["symbol"])
        if s.get("exit") == "strength" and r is not None and r > connors.EXIT_RSI:
            return f"sell on strength: RSI(2) {r:.1f} above {connors.EXIT_RSI:.0f}"
        return None
    flag, score = ("signal_cum", "cum") if setup == "cumrsi2" else ("signal", "rsi")
    free = max(0, int(s.get("max_open", 3)) - len(held))
    rows, slot = [], 0
    for x in sorted(live["stocks"], key=lambda x: (x[score] is None, x[score] if x[score] is not None else 0)):
        sym = x["symbol"]
        if sym in held:
            status = "queued to sell" if held[sym]["sell_queued"] else "held"
        elif x[flag]:
            status = "buy" if slot < free else "signal, no slot"
            slot += status == "buy"
        else:
            status = "watch"
        px = market["prices"].get(sym)
        if pr == "futures":
            fut = market["futures"].get(sym, (None, None))[0]
        rows.append({"symbol": sym, "rsi": x["rsi"], "cum": x["cum"], "signal": bool(x[flag]), "status": status, "price": px,
                     "future": fut if pr == "futures" else None, "day": held[sym]["age"] if sym in held else None,
                     "sell": sell_signal(held[sym]) if sym in held else None})
    listed = {r["symbol"] for r in rows}
    for sym, p in held.items():  # a holding below its 200-day average now: not a candidate, still shown
        if sym not in listed:
            r = live.get("rsi_all", {}).get(sym)
            rows.insert(0, {"symbol": sym, "rsi": round(r, 2) if r is not None else None, "cum": None, "signal": False,
                            "status": "queued to sell" if p["sell_queued"] else "held", "price": market["prices"].get(sym), "future": None,
                            "day": p["age"], "sell": sell_signal(p)})
    return {"at": now.strftime("%H:%M:%S"), "setup": setup, "price": pr, "max_open": int(s.get("max_open", 3)), "held": len(held),
            "free": free, "rule": "Cumulative RSI(2) below 35" if setup == "cumrsi2" else "RSI(2) below 10",
            "exit_rsi": connors.EXIT_RSI, "above_average": len(live["stocks"]), "signals": sum(r["signal"] for r in rows),
            "sells": sum(bool(r.get("sell")) for r in rows), "stocks": rows}


_funds_cache = {}
_need_cache = {}


def tom_need(settings):
    """What a turn of the month buy needs now, on these settings: the call's premium (cash) or the future's margin
    (Kite's calculator), for the lots. Cached 5 minutes. None when it can't be worked out."""
    import time
    import v2tom
    key = (settings.get("instrument", "call"), int(settings.get("lots", 1)))
    hit = _need_cache.get(key)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    out = None
    try:
        if kite_auth.status().get("connected"):
            kite = kite_auth.trading_client()
            today = gapwatch._now().date()
            pos, _ = _tom_pick(kite, today, v2tom.plan(today, live=False), settings, _instruments(kite, today))
            if pos:
                px = _best(pos["quote"], "BUY") or pos["last"]
                m = kite.order_margins([{"exchange": "NFO", "tradingsymbol": pos["tradingsymbol"], "transaction_type": "BUY", "variety": "regular",
                                         "product": "NRML", "order_type": "LIMIT", "quantity": pos["qty"], "price": px}])[0]
                out = round(float(m.get("total") or 0)) or None
    except Exception as error:
        print("Live engine: turn of the month need:", error)
    _need_cache[key] = (time.time(), out)
    return out


def funds():
    """{account: {"available", "cash", "used"} or {"error"}}: each trading account's funds now (Kite: equity
    segment; Angel One: its RMS limits). "available": what can be used for new orders. Cached 60 s."""
    import time
    if _funds_cache.get("at") and time.time() - _funds_cache["at"] < 60:
        return _funds_cache["data"]
    out = {}
    f = lambda v: round(float(v), 2) if v not in (None, "") else None
    if kite_auth.status().get("connected"):
        try:
            e = kite_auth.trading_client().margins().get("equity") or {}
            a, u = e.get("available") or {}, e.get("utilised") or {}
            out["kite"] = {"available": f(e.get("net")), "cash": f(a.get("live_balance", a.get("cash"))), "used": f(u.get("debits"))}
        except Exception as error:
            out["kite"] = {"error": str(error)}
    else:
        out["kite"] = {"error": "not connected"}
    try:
        if any(a["id"] == "angel" for a in liveitems.accounts()):
            b = _angel("GET", "/rest/secure/angelbroking/user/v1/getRMS")
            d = b.get("data") or {}
            out["angel"] = ({"available": f(d.get("net")), "cash": f(d.get("availablecash")), "used": f(d.get("utiliseddebits"))}
                            if b.get("status") else {"error": b.get("message") or "refused"})
    except Exception as error:
        out["angel"] = {"error": str(error)}
    _funds_cache.update(at=time.time(), data=out)
    return out


def summary():
    """Every live item for the dashboard: its state, holdings marked now (Kite's last prices), realized and
    unrealized (gross: before charges), today's orders and its last log line."""
    items = liveitems.items()
    accts = {a["id"]: a for a in items["accounts"]}
    today = gapwatch._now().date()
    out = []
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT item_id, symbol, instrument, exchange, tradingsymbol, qty, buy_day, buy_price, sell_day, sell_price, sell_queued, "
                       "real, buy_status, sell_status FROM live_positions")
        cols = ("item_id", "symbol", "instrument", "exchange", "tradingsymbol", "qty", "buy_day", "buy_price", "sell_day", "sell_price",
                "sell_queued", "real", "buy_status", "sell_status")
        pos = [dict(zip(cols, r)) for r in cursor.fetchall()]
        cursor.execute("SELECT item_id, count(*) FILTER (WHERE status = 'sent'), count(*) FILTER (WHERE status = 'dry-run'), "
                       "count(*) FILTER (WHERE status IN ('rejected') OR event = 'error') FROM live_order_log "
                       "WHERE (at AT TIME ZONE 'Asia/Kolkata')::date = %s GROUP BY item_id", (today,))
        counts = {r[0]: r[1:] for r in cursor.fetchall()}
        cursor.execute("SELECT DISTINCT ON (item_id) item_id, at, event, symbol, note, status FROM live_order_log ORDER BY item_id, at DESC, id DESC")
        last = {r[0]: {"at": r[1].astimezone(gapwatch.IST).strftime("%d %b %H:%M"), "event": r[2], "symbol": r[3], "note": r[4], "status": r[5]}
                for r in cursor.fetchall()}
    held = [p for p in pos if not p["sell_day"]]
    ltp = {}
    if held and kite_auth.status().get("connected"):
        try:
            keys = sorted({f"{p['exchange']}:{p['tradingsymbol']}" for p in held})
            ltp = {k: v.get("last_price") for k, v in kite_auth.trading_client().ltp(keys).items()}
        except Exception as error:
            print("Live summary: prices failed:", error)
    for it in items["items"]:
        mine = [p for p in pos if p["item_id"] == it["id"]]
        open_ = []
        for p in mine:
            if p["sell_day"]:
                continue
            now = ltp.get(f"{p['exchange']}:{p['tradingsymbol']}")
            open_.append({"symbol": p["tradingsymbol"] if p["symbol"] == "NIFTY" else p["symbol"], "instrument": p["instrument"], "qty": p["qty"], "buy_day": p["buy_day"].isoformat(),
                          "buy_price": p["buy_price"], "last": now, "pnl_rs": round((now - p["buy_price"]) * p["qty"], 2) if now else None,
                          "state": "buy order in" if p["buy_status"] == "pending" else "sale order in" if p["sell_status"] == "pending"
                          else "sell at next open" if p["sell_queued"] else "sell by hand" if p["sell_status"] == "manual" else "held"})
        closed = [p for p in mine if p["sell_day"] and p["sell_price"] is not None]
        sent, dry, bad = counts.get(it["id"], (0, 0, 0))
        out.append({"id": it["id"], "name": it["name"], "model": it["model_label"], "account": (accts.get(it["account"]) or {}).get("label", it["account"]),
                    "enabled": it["enabled"], "real": it.get("real"), "engine": it["orders"] == "engine", "settings": it["settings"],
                    "open": open_, "unrealized_rs": round(sum(x["pnl_rs"] or 0 for x in open_), 2) if open_ else None,
                    "invested_rs": round(sum(x["buy_price"] * x["qty"] for x in open_), 2),
                    "realized_rs": round(sum((p["sell_price"] - p["buy_price"]) * p["qty"] for p in closed), 2), "trades": len(closed),
                    "sold_today_rs": round(sum((p["sell_price"] - p["buy_price"]) * p["qty"] for p in closed if p["sell_day"] == today), 2),
                    "today": {"sent": sent, "dry": dry, "problems": bad}, "last": last.get(it["id"])})
    try:
        fx = funds()
    except Exception as error:
        fx = {}
        print("Live summary: funds failed:", error)
    for o, it in zip(out, items["items"]):
        o["funds"] = fx.get(it["account"])
        if it["model"] == "turn-of-month":
            o["need_rs"] = tom_need(it["settings"])
    return {"items": out, "real_allowed": real_orders_allowed(), "funds": fx}


def _tom_signals(item):
    """Turn of the month's "signal": this cycle's buy and sale days, what it holds, and what the buy day's run
    would buy on the prices now."""
    import v2tom
    now = gapwatch._now()
    today = now.date()
    kite = kite_auth.trading_client()
    plan = v2tom.plan(today, live=False)
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        held = _held(cursor, item["id"])
    out = {"tom": True, "at": now.strftime("%H:%M:%S"), "buy": plan["buy"], "sell": plan["sell"], "state": plan["state"],
           "days_to_buy": plan.get("days_to_buy"), "holidays": plan.get("holidays_source"), "held": [], "pick": None}
    for p in held:
        k = f"{p['exchange']}:{p['tradingsymbol']}"
        last = (kite.ltp([k]).get(k) or {}).get("last_price")
        out["held"].append({"tradingsymbol": p["tradingsymbol"], "qty": p["qty"], "buy_day": p["buy_day"].isoformat(), "buy_price": p["buy_price"],
                            "last": last, "sell_plan": p["sell_plan"].isoformat() if p["sell_plan"] else None,
                            "state": "buy order in" if p["buy_status"] == "pending" else "sale order in" if p["sell_status"] == "pending" else "held"})
    if not held:
        try:
            pos, why = _tom_pick(kite, today, plan, item["settings"], _instruments(kite, today))
        except Exception as error:
            pos, why = None, str(error)
        if pos:
            q = pos["quote"]
            out["pick"] = {"tradingsymbol": pos["tradingsymbol"], "instrument": pos["instrument"], "strike": pos["strike"],
                           "expiry": pos["expiry"].isoformat(), "qty": pos["qty"], "last": pos["last"], "ask": _best(q, "BUY"),
                           "bid": _best(q, "SELL"), "value": round((pos["last"] or 0) * pos["qty"])}
            try:  # what the account needs for the buy (Kite's margin calculator; a call: its premium)
                m = kite.order_margins([{"exchange": "NFO", "tradingsymbol": pos["tradingsymbol"], "transaction_type": "BUY", "variety": "regular",
                                         "product": "NRML", "order_type": "LIMIT", "quantity": pos["qty"], "price": _best(q, "BUY") or pos["last"]}])[0]
                out["pick"]["margin"] = round(float(m.get("total") or 0)) or None
            except Exception as error:
                out["pick"]["margin_error"] = str(error)
        else:
            out["pick_error"] = why
    return out
