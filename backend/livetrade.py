"""Live trading: REAL orders on the Kite account, placed only when the signed-in user clicks (and confirms)
on the Live trading page. Nothing here runs on a schedule.

First model: turn of the month (v2tom.plan), an in-the-money Nifty call of the next month's expiry,
bought at the close of the month's 5th-last trading day and sold at the close of the next month's 3rd.

Guards on every order: LIMIT only, product NRML (carried overnight), DAY validity; a buy only for a listed
Nifty call 2-3.5% in the money of the plan's expiry; a sale only of a call the account holds, up to what
it holds; 1 to MAX_LOTS lots; the price on the 0.05 tick and within PRICE_BAND of the live bid/ask mid.
Every order is logged in live_orders (who, what, Kite's order id) and tagged on Kite (TAG).

A buy only on the plan's buy day. Stop loss (optional): a Kite GTT (good till triggered, so it lasts
the whole hold) on the held call: when its last price falls to the trigger, Kite sends a LIMIT sell
STOP_LIMIT_BELOW under it. Selling from the page removes that call's GTT first, so it can't sell twice.
"""

from datetime import datetime

import kite_auth
import v2tom
from db import connect

# The Live trading landing page: each model's mode, a server setting (LIVE_MODES, JSON). "off": not traded;
# "manual": traded by hand from its page; "auto": automatic orders, which no model has yet (refused).
LIVE_MODES_KEY = "LIVE_MODES"
LIVE_MODELS = ("turn-of-month", "books-gold", "short-term-reversion", "cumulative-rsi", "oops", "buy-on-gap", "xs-mean-reversion")
MODES = ("off", "manual", "auto")
AUTOMATIC = ()  # models whose orders the scheduler could place itself: none yet
DEFAULT_MODES = {"turn-of-month": "manual"}


def modes():
    import json
    import db
    try:
        saved = json.loads(db.get_settings([LIVE_MODES_KEY]).get(LIVE_MODES_KEY) or "{}")
    except ValueError:
        saved = {}
    return {m: saved.get(m, DEFAULT_MODES.get(m, "off")) if saved.get(m) in MODES or m not in saved else "off" for m in LIVE_MODELS}


def set_mode(model, mode):
    import json
    import db
    if model not in LIVE_MODELS or mode not in MODES:
        raise ValueError("unknown model or mode")
    if mode == "auto" and model not in AUTOMATIC:
        raise ValueError("Automatic orders aren't built for this model yet: use Manual")
    m = modes()
    m[model] = mode
    db.set_settings({LIVE_MODES_KEY: json.dumps(m)})
    return m


MODEL = "turn-of-month"
TAG = "yt-tom"
MAX_LOTS = 5
PRICE_BAND = 0.05  # a limit price more than 5% off the mid is refused (a typo, a stale price)
STOP_LIMIT_BELOW = 0.10  # the stop's sell order: a LIMIT 10% under the trigger, so a fast fall still fills


def _ensure(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS live_orders (
            id SERIAL PRIMARY KEY, placed_at TIMESTAMPTZ NOT NULL DEFAULT now(), model TEXT NOT NULL,
            username TEXT, side TEXT NOT NULL, tradingsymbol TEXT NOT NULL, quantity INTEGER NOT NULL,
            price DOUBLE PRECISION NOT NULL, order_id TEXT, error TEXT
        );
        """
    )


def _quote(kite, symbols):
    q = kite.quote([f"NFO:{s}" for s in symbols]) if symbols else {}
    out = {}
    for key, x in q.items():
        depth = x.get("depth") or {}
        bid = ((depth.get("buy") or [{}])[0]).get("price") or None
        ask = ((depth.get("sell") or [{}])[0]).get("price") or None
        ltp = x.get("last_price")
        mid = (bid + ask) / 2 if bid and ask else ltp
        out[key.split(":", 1)[1]] = {"bid": bid, "ask": ask, "ltp": ltp, "mid": round(mid, 2) if mid else None,
                                     "limit": round(round(mid / 0.05) * 0.05, 2) if mid else None, "oi": x.get("oi")}
    return out


def _held(kite):
    """The account's open Nifty call positions (NRML): {tradingsymbol: position}."""
    pos = kite.positions().get("net") or []
    return {p["tradingsymbol"]: p for p in pos
            if p["exchange"] == "NFO" and p["tradingsymbol"].startswith("NIFTY") and p["tradingsymbol"].endswith("CE")
            and p["product"] == "NRML" and p["quantity"] != 0}


def state():
    """Everything the page shows: the plan (dates, the best call and the others), the account's held
    Nifty calls with live prices and P&L, today's orders from this page, and the order log."""
    kite_ok = kite_auth.status().get("connected")
    plan = v2tom.plan(live=kite_ok)
    out = {"plan": plan, "kite": bool(kite_ok), "max_lots": MAX_LOTS, "positions": [], "orders": [], "log": []}
    if kite_ok:
        kite = kite_auth.trading_client()
        held = _held(kite)
        q = _quote(kite, list(held))
        for s, p in held.items():
            x = q.get(s) or {}
            ltp = x.get("ltp") or p.get("last_price")
            out["positions"].append({"tradingsymbol": s, "quantity": p["quantity"], "average_price": p["average_price"],
                                     "ltp": ltp, "bid": x.get("bid"), "ask": x.get("ask"), "mid": x.get("mid"), "limit": x.get("limit"),
                                     "pnl": round((ltp - p["average_price"]) * p["quantity"], 2) if ltp else p.get("pnl"),
                                     "value": round((ltp or 0) * p["quantity"]), "lot": _lot(s)})
        for p in out["positions"]:
            try:
                p["scenarios"] = _scenarios(kite, p, plan)
            except Exception as error:
                p["scenarios"] = None
                print("Live trading: scenarios failed:", error)
        stops = _stops(kite)
        for p in out["positions"]:
            g = stops.get(p["tradingsymbol"])
            p["stop"] = {"id": g["id"], "trigger": g["condition"]["trigger_values"][0], "limit": g["orders"][0]["price"],
                         "quantity": g["orders"][0]["quantity"]} if g else None
        out["orders"] = [{"order_id": o["order_id"], "time": str(o.get("order_timestamp") or ""), "side": o["transaction_type"],
                          "tradingsymbol": o["tradingsymbol"], "quantity": o["quantity"], "filled": o.get("filled_quantity"),
                          "price": o.get("price"), "average_price": o.get("average_price"), "status": o["status"],
                          "message": o.get("status_message")}
                         for o in kite.orders() if (o.get("tag") or "") == TAG]
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT placed_at, username, side, tradingsymbol, quantity, price, order_id, error FROM live_orders "
                       "WHERE model = %s ORDER BY placed_at DESC LIMIT 50", (MODEL,))
        out["log"] = [{"placed_at": a.isoformat(timespec="seconds"), "by": u, "side": sd, "tradingsymbol": ts, "quantity": qn,
                       "price": pr, "order_id": oid, "error": err} for a, u, sd, ts, qn, pr, oid, err in cursor.fetchall()]
    return out


SCENARIOS = (0.08, 0.05, 0.03, 0.02, 0.01, 0.0, -0.01, -0.02, -0.03, -0.05, -0.08)
RATE = 0.065


def _call(F, K, T, vol):
    """Black-76: a European call on the future F, strike K, T years, volatility vol."""
    from math import erf, exp, log, sqrt
    if T <= 0 or vol <= 0:
        return max(0.0, F - K)
    n = lambda x: 0.5 * (1 + erf(x / sqrt(2)))
    d1 = (log(F / K) + 0.5 * vol * vol * T) / (vol * sqrt(T))
    return exp(-RATE * T) * (F * n(d1) - K * n(d1 - vol * sqrt(T)))


def _scenarios(kite, p, plan):
    """What the held call would be worth at the sell day's close if the same-expiry future moved by each
    of SCENARIOS from now (volatility as the call's price implies now): price, P&L on the position
    against its average, and a future's P&L on the same quantity for comparison."""
    from datetime import date as ddate
    sym = p["tradingsymbol"]
    row = next(((e, k) for e, k, ts, _ in v2tom._nifty_calls(kite) if ts == sym), None)
    fut = v2tom._plan_cache.get("futures", {}).get(row[0]) if row else None
    if not row or not fut or not p.get("mid"):
        return None
    expiry, strike = row
    F = kite.ltp([f"NFO:{fut}"])[f"NFO:{fut}"]["last_price"]
    import gapwatch
    today = gapwatch._now().date()
    t_now = max(1, (expiry - today).days) / 365
    sell = ddate.fromisoformat(plan["sell"]) if plan.get("sell") else today
    t_sell = max(0, (expiry - sell).days) / 365
    lo, hi = 0.01, 2.0  # the volatility that prices the call at its mid now
    for _ in range(60):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if _call(F, strike, t_now, m) < p["mid"] else (lo, m)
    vol, q, avg = (lo + hi) / 2, p["quantity"], p["average_price"]
    rows = []
    for mv in SCENARIOS:
        f = F * (1 + mv)
        v = _call(f, strike, t_sell, vol)
        rows.append({"move_pct": round(100 * mv, 1), "points": round(f - F), "future": round(f, 1), "call": round(v, 1),
                     "pnl": round((v - avg) * q), "future_pnl": round((f - F) * q)})
    return {"future": F, "future_symbol": fut, "strike": int(strike), "sell": sell.isoformat(), "vol_pct": round(100 * vol, 1), "rows": rows}


def _stops(kite):
    """{tradingsymbol: GTT}: the active single-trigger SELL GTTs on Nifty calls (the stops)."""
    out = {}
    for g in kite.get_gtts():
        o = (g.get("orders") or [{}])[0]
        sym = (g.get("condition") or {}).get("tradingsymbol", "")
        if g.get("status") == "active" and g.get("type") == "single" and o.get("transaction_type") == "SELL" \
                and sym.startswith("NIFTY") and sym.endswith("CE"):
            out[sym] = g
    return out


def _tick(x):
    return round(round(x / 0.05) * 0.05, 2)


def set_stop(symbol, trigger, username):
    """Place (or replace) the stop on a held call: a GTT that sells all of it when it trades at the trigger."""
    if not kite_auth.status().get("connected"):
        raise ValueError("Kite isn't connected.")
    kite = kite_auth.trading_client()
    held = _held(kite).get(symbol)
    if not held or held["quantity"] <= 0:
        raise ValueError(f"The account doesn't hold {symbol}.")
    trigger = float(trigger)
    if abs(_tick(trigger) - trigger) > 1e-6 or trigger <= 0:
        raise ValueError("The trigger must be a positive price on the 0.05 tick.")
    ltp = (_quote(kite, [symbol]).get(symbol) or {}).get("ltp")
    if not ltp or trigger >= ltp:
        raise ValueError(f"The trigger must be below the last price (₹{ltp}).")
    qty, limit = held["quantity"], _tick(trigger * (1 - STOP_LIMIT_BELOW))
    old = _stops(kite).get(symbol)
    if old:
        kite.delete_gtt(old["id"])
    try:
        gid = kite.place_gtt(trigger_type=kite.GTT_TYPE_SINGLE, tradingsymbol=symbol, exchange=kite.EXCHANGE_NFO, trigger_values=[trigger],
                             last_price=ltp, orders=[{"exchange": kite.EXCHANGE_NFO, "tradingsymbol": symbol, "transaction_type": "SELL",
                                                      "quantity": qty, "order_type": kite.ORDER_TYPE_LIMIT, "product": kite.PRODUCT_NRML, "price": limit}])
    except Exception as error:
        _log(username, "STOP", symbol, qty, trigger, error=str(error))
        raise ValueError(f"Kite refused the stop: {error}")
    gid = gid.get("trigger_id") if isinstance(gid, dict) else gid
    _log(username, "STOP", symbol, qty, trigger, order_id=f"GTT {gid}")
    return {"id": gid, "trigger": trigger, "limit": limit, "quantity": qty}


def remove_stop(symbol, username):
    kite = kite_auth.trading_client()
    g = _stops(kite).get(symbol)
    if not g:
        raise ValueError(f"No stop on {symbol}.")
    kite.delete_gtt(g["id"])
    _log(username, "STOP REMOVED", symbol, g["orders"][0]["quantity"], g["condition"]["trigger_values"][0], order_id=f"GTT {g['id']}")
    return {"removed": g["id"]}


def _lot(symbol):
    kite = kite_auth.trading_client()
    return next((lot for _, _, ts, lot in v2tom._nifty_calls(kite) if ts == symbol), None)


def _log(username, side, symbol, qty, price, order_id=None, error=None):
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        cursor.execute("INSERT INTO live_orders (model, username, side, tradingsymbol, quantity, price, order_id, error) "
                       "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)", (MODEL, username, side, symbol, qty, price, order_id, error))
        conn.commit()


def _check_price(kite, symbol, price):
    if abs(round(price / 0.05) * 0.05 - price) > 1e-6:
        raise ValueError("The price must be on the 0.05 tick.")
    x = _quote(kite, [symbol]).get(symbol) or {}
    mid = x.get("mid")
    if not mid:
        raise ValueError("No live price for that call right now.")
    if abs(price / mid - 1) > PRICE_BAND:
        raise ValueError(f"₹{price} is more than {int(PRICE_BAND * 100)}% away from the live mid ₹{mid}.")


def place(side, symbol, lots, price, username):
    """One REAL limit order (BUY or SELL) for the turn-of-the-month call; returns Kite's order id."""
    if not kite_auth.status().get("connected"):
        raise ValueError("Kite isn't connected.")
    side = side.upper()
    if side not in ("BUY", "SELL"):
        raise ValueError("Side must be BUY or SELL.")
    if side == "BUY" and modes().get(MODEL) == "off":  # selling what's held stays allowed
        raise ValueError("Turn of the month is Off on the Live trading page: set it to Manual to buy.")
    lots = int(lots)
    if not 1 <= lots <= MAX_LOTS:
        raise ValueError(f"Lots must be 1 to {MAX_LOTS}.")
    price = round(float(price), 2)
    kite = kite_auth.trading_client()
    lot = _lot(symbol)
    if lot is None:
        raise ValueError(f"{symbol} isn't a listed Nifty call.")
    qty = lots * lot
    if side == "BUY":
        plan = v2tom.plan(live=True)
        if not str(plan.get("state", "")).startswith("buy"):
            raise ValueError(f"Buying opens on the buy day ({plan.get('buy')}).")
        allowed = {c["symbol"] for c in plan.get("calls") or []}
        if symbol not in allowed:
            raise ValueError("Only one of the plan's calls (2-3.5% in the money, the plan's expiry) can be bought here.")
    else:
        held = _held(kite).get(symbol)
        if not held or held["quantity"] <= 0:
            raise ValueError(f"The account doesn't hold {symbol}.")
        if qty > held["quantity"]:
            raise ValueError(f"The account holds {held['quantity']}, not {qty}.")
    _check_price(kite, symbol, price)
    if side == "SELL":  # the page's sale replaces the stop: drop its GTT so the call can't be sold twice
        g = _stops(kite).get(symbol)
        if g:
            kite.delete_gtt(g["id"])
            _log(username, "STOP REMOVED", symbol, g["orders"][0]["quantity"], g["condition"]["trigger_values"][0], order_id=f"GTT {g['id']}")
    try:
        order_id = kite.place_order(variety=kite.VARIETY_REGULAR, exchange=kite.EXCHANGE_NFO, tradingsymbol=symbol,
                                    transaction_type=side, quantity=qty, product=kite.PRODUCT_NRML,
                                    order_type=kite.ORDER_TYPE_LIMIT, price=price, validity=kite.VALIDITY_DAY, tag=TAG)
    except Exception as error:
        _log(username, side, symbol, qty, price, error=str(error))
        raise ValueError(f"Kite refused the order: {error}")
    _log(username, side, symbol, qty, price, order_id=str(order_id))
    return {"order_id": str(order_id), "side": side, "tradingsymbol": symbol, "quantity": qty, "price": price}


def _own_open_order(kite, order_id):
    o = next((o for o in kite.orders() if o["order_id"] == order_id), None)
    if o is None or (o.get("tag") or "") != TAG:
        raise ValueError("That isn't an order from this page.")
    if o["status"] not in ("OPEN", "TRIGGER PENDING", "MODIFIED", "OPEN PENDING", "MODIFY PENDING"):
        raise ValueError(f"The order is {o['status']}: nothing to change.")
    return o


def modify(order_id, price, username):
    kite = kite_auth.trading_client()
    o = _own_open_order(kite, order_id)
    price = round(float(price), 2)
    _check_price(kite, o["tradingsymbol"], price)
    kite.modify_order(variety=kite.VARIETY_REGULAR, order_id=order_id, price=price, order_type=kite.ORDER_TYPE_LIMIT)
    _log(username, f"MODIFY {o['transaction_type']}", o["tradingsymbol"], o["quantity"], price, order_id=order_id)
    return {"order_id": order_id, "price": price}


def cancel(order_id, username):
    kite = kite_auth.trading_client()
    o = _own_open_order(kite, order_id)
    kite.cancel_order(variety=kite.VARIETY_REGULAR, order_id=order_id)
    _log(username, f"CANCEL {o['transaction_type']}", o["tradingsymbol"], o["quantity"], o.get("price") or 0, order_id=order_id)
    return {"order_id": order_id, "cancelled": True}


# ---------- Books + gold, traded by hand ----------
MIX_GOLD, MIX_RSI_OPEN, MIX_LV_OPEN = 0.30, 3, 10  # 30% gold, the books half each of the rest
MIX_CAPITAL_KEY = "LIVE_MIX_CAPITAL"


def mix_capital():
    import db
    try:
        return float(db.get_settings([MIX_CAPITAL_KEY]).get(MIX_CAPITAL_KEY) or 1000000)
    except ValueError:
        return 1000000.0


def set_mix_capital(rs):
    import db
    rs = float(rs)
    if not 10000 <= rs <= 1e9:
        raise ValueError("Capital must be at least Rs 10,000.")
    db.set_settings({MIX_CAPITAL_KEY: str(int(rs))})
    return rs


def mix_state():
    """What Books + gold should hold now, against what the Kite account holds (read-only): the gold
    target, the low volatility book's holdings (its backtest on today's F&O list, cash, as of the last
    stored close), and the RSI(2) book (the SR paper book's open positions and today's 15:15 candidates).
    Nothing here places orders: the page lists what to buy or sell by hand."""
    import connorswatch
    import v2ltlv
    capital = mix_capital()
    gold_rs = MIX_GOLD * capital
    book_rs = (1 - MIX_GOLD) * capital / 2
    held, held_err = {}, None
    kite = None
    if kite_auth.status().get("connected"):
        kite = kite_auth.trading_client()
        try:
            for h in kite.holdings():
                held[h["tradingsymbol"]] = int(h.get("quantity") or 0) + int(h.get("t1_quantity") or 0)
        except Exception as error:
            held_err = str(error)
    else:
        held_err = "Kite isn't connected: holdings unknown"

    def ltp(symbols):
        if not kite or not symbols:
            return {}
        try:
            q = kite.ltp([f"NSE:{s}" for s in symbols])
            return {s: float(q[f"NSE:{s}"]["last_price"]) for s in symbols if f"NSE:{s}" in q}
        except Exception:
            return {}

    def row(symbol, per_rs, price, note=None, **extra):
        target = int(per_rs // price) if price else None
        have = held.get(symbol, 0)
        return {"symbol": symbol, "price": round(price, 2) if price else None, "target_qty": target, "held_qty": have,
                "action_qty": (target - have) if target is not None else None, "note": note, **extra}

    # gold
    g_px = ltp(["GOLDBEES"]).get("GOLDBEES")
    gold = row("GOLDBEES", gold_rs, g_px, "held; topped up or trimmed back to 30% at each month-end")
    # low volatility: the model's holdings now
    lv = v2ltlv.results(MIX_LV_OPEN, "20", 0.0002, "cash", "fno")["summary"]
    lv_open = lv.get("open_positions") or []
    lv_px = ltp([o["symbol"] for o in lv_open])
    lv_rows = [row(o["symbol"], book_rs / MIX_LV_OPEN, lv_px.get(o["symbol"]) or o["last"],
                   f"model bought {o['entry_at'][:10]} at {o['entry']} · trailing stop {abs(o['to_stop_pct']):.1f}% below",
                   ret_pct=o["ret_pct"]) for o in lv_open]
    # RSI(2): the SR paper book's open positions and today's buys at 15:15
    sr = connorswatch.paper(book="rsi2")
    sr_rows = [row(t["symbol"], book_rs / MIX_RSI_OPEN, t.get("ltp") or t["buy"], f"bought {t['buy_day']} · day {t['day_of_hold']} of {sr['hold']}")
               for t in sr["open"]]
    try:
        w = connorswatch.watchlist("rsi2")
        free = max(0, MIX_RSI_OPEN - len(sr["open"]))
        held_now = {t["symbol"] for t in sr["open"]}
        cands = [x for x in w.get("stocks", []) if x.get("signal") and x["symbol"] not in held_now][:free]
        sr_buys = [row(x["symbol"], book_rs / MIX_RSI_OPEN, x["price"], f"RSI(2) {x['rsi']:.1f}: buy at 15:15 if it still signals") for x in cands]
    except Exception as error:
        sr_buys, w = [], {"note": str(error)}
    return {"capital": capital, "gold_pct": 100 * MIX_GOLD, "gold_rs": gold_rs, "book_rs": book_rs,
            "rsi_open": MIX_RSI_OPEN, "lv_open": MIX_LV_OPEN, "holdings_error": held_err, "mode": modes().get("books-gold"),
            "gold": gold, "lv": lv_rows, "lv_as_of": lv.get("to"), "rsi2": sr_rows, "rsi2_buys": sr_buys,
            "rsi2_note": w.get("note"), "rsi2_exit": "on strength" if sr.get("exit") == "strength" else "on the 5th trading day"}
