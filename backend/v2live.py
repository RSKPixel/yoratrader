"""The v2 Live page: the real Kite account, read-only (no order is ever placed from here).

account() makes five Kite calls (margins, positions, orders, trades, holdings), cached LIVE_TTL
seconds so several open tabs don't hit Kite's rate limit. Each section fails on its own: one
error doesn't blank the page.
"""

import threading
import time

import kite_auth

LIVE_TTL = 5
_cache, _lock = {"at": 0, "value": None}, threading.Lock()


def _f(v):
    return float(v) if v is not None else None


def _margins(kite):
    m = kite.margins()
    out = {}
    for seg in ("equity", "commodity"):
        s = m.get(seg) or {}
        if not s.get("enabled", True) and not s.get("net"):
            continue
        a, u = s.get("available") or {}, s.get("utilised") or {}
        out[seg] = {"net": _f(s.get("net")), "cash": _f(a.get("live_balance", a.get("cash"))), "opening": _f(a.get("opening_balance")),
                    "collateral": _f(a.get("collateral")), "intraday_payin": _f(a.get("intraday_payin")),
                    "used": _f(u.get("debits")), "span": _f(u.get("span")), "exposure": _f(u.get("exposure")),
                    "option_premium": _f(u.get("option_premium")), "m2m_realised": _f(u.get("m2m_realised")),
                    "m2m_unrealised": _f(u.get("m2m_unrealised"))}
    return out


def _position(p):
    return {"symbol": p["tradingsymbol"], "exchange": p["exchange"], "product": p["product"], "qty": p["quantity"],
            "avg": _f(p["average_price"]), "ltp": _f(p["last_price"]), "close": _f(p.get("close_price")),
            "pnl": _f(p["pnl"]), "m2m": _f(p.get("m2m")), "realised": _f(p.get("realised")), "unrealised": _f(p.get("unrealised")),
            "value": _f(p.get("value")), "buy_qty": p.get("buy_quantity"), "sell_qty": p.get("sell_quantity"),
            "buy_avg": _f(p.get("buy_price")), "sell_avg": _f(p.get("sell_price")), "multiplier": p.get("multiplier") or 1}


def _positions(kite):
    p = kite.positions()
    return {"net": [_position(x) for x in p.get("net", [])], "day": [_position(x) for x in p.get("day", [])]}


def _ts(v):
    return v.strftime("%H:%M:%S") if hasattr(v, "strftime") else (str(v)[11:19] if v else None)


def _orders(kite):
    return [{"id": o["order_id"], "time": _ts(o.get("order_timestamp")), "symbol": o["tradingsymbol"], "exchange": o["exchange"],
             "side": o["transaction_type"], "type": o["order_type"], "product": o["product"], "qty": o["quantity"],
             "filled": o.get("filled_quantity"), "price": _f(o.get("price")), "trigger": _f(o.get("trigger_price")),
             "avg": _f(o.get("average_price")), "status": o["status"], "message": o.get("status_message"), "tag": o.get("tag")}
            for o in sorted(kite.orders(), key=lambda o: str(o.get("order_timestamp") or ""), reverse=True)]


def _trades(kite):
    return [{"id": t["trade_id"], "order_id": t["order_id"], "time": _ts(t.get("fill_timestamp") or t.get("exchange_timestamp")),
             "symbol": t["tradingsymbol"], "exchange": t["exchange"], "side": t["transaction_type"], "product": t["product"],
             "qty": t["quantity"], "price": _f(t["average_price"])}
            for t in sorted(kite.trades(), key=lambda t: str(t.get("fill_timestamp") or ""), reverse=True)]


def _holdings(kite):
    out = []
    for h in kite.holdings():
        qty = (h.get("quantity") or 0) + (h.get("t1_quantity") or 0)
        avg, ltp, close = _f(h["average_price"]), _f(h["last_price"]), _f(h.get("close_price"))
        out.append({"symbol": h["tradingsymbol"], "exchange": h["exchange"], "qty": qty, "t1": h.get("t1_quantity") or 0,
                    "avg": avg, "ltp": ltp, "invested": avg * qty, "value": ltp * qty, "pnl": _f(h["pnl"]),
                    "day_change": _f(h.get("day_change")), "day_change_pct": _f(h.get("day_change_percentage")),
                    "day_pnl": (ltp - close) * qty if close else None})
    return sorted(out, key=lambda h: -h["value"])


def account(force=False):
    with _lock:
        if not force and _cache["value"] and time.time() - _cache["at"] < LIVE_TTL:
            return _cache["value"]
    kite_status = kite_auth.status()
    out = {"kite": kite_status, "fetched_at": time.strftime("%H:%M:%S"), "errors": {}}
    if kite_status.get("connected"):
        kite = kite_auth.trading_client()
        for name, fn in (("margins", _margins), ("positions", _positions), ("orders", _orders), ("trades", _trades), ("holdings", _holdings)):
            try:
                out[name] = fn(kite)
            except Exception as error:
                out["errors"][name] = f"{type(error).__name__}: {error}"
    with _lock:
        _cache.update(at=time.time(), value=out)
    return out
