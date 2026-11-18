"""A paper day's P&L through the session, every 15 minutes: each position (one lot) marked at the
close of every 15-minute candle from Kite, from its entry at the 09:15 open to its exit (15:15, or
the stop when it was touched). Entry-side costs count from the start, the exit side at the exit, so
the last point is the day's recorded net (to within the 15:15 price).

Candles are cached: a finished day's for good, today's for a minute (the page polls every 20 s).
"""

import threading
import time
from datetime import datetime, timedelta
from datetime import time as clock

import gapwatch
import kite_auth

EXIT_AT = clock(15, 15)
TODAY_TTL = 60
_cache, _lock = {}, threading.Lock()


def _bars(kite, symbol, day, exchange="NSE"):
    """A day's 15-minute candles of an NSE stock or (exchange NFO) a futures contract, cached."""
    key = (exchange, symbol, day)
    today = gapwatch._now().date().isoformat()
    with _lock:
        hit = _cache.get(key)
        if hit and (day != today or time.time() - hit[0] < TODAY_TTL):
            return hit[1]
    if exchange == "NFO":
        import v2dashboard
        token = v2dashboard._instrument_token(kite, f"NFO:{symbol}")
    else:
        token = gapwatch._token(kite, symbol)
    if not token:
        return []
    d = datetime.fromisoformat(day)
    bars = kite.historical_data(token, from_date=d.replace(hour=9, minute=15), to_date=d.replace(hour=15, minute=31), interval="15minute")  # 15:31: Kite leaves out the 15:15 candle at 15:30
    time.sleep(0.35)  # Kite allows ~3 historical calls a second
    out = [{"t": b["date"].replace(tzinfo=None), "high": float(b["high"]), "low": float(b["low"]), "close": float(b["close"]),
            "open": float(b["open"])} for b in bars]
    with _lock:
        _cache[key] = (time.time(), out)
    return out


def curve(day, picks, cps, size=1):
    """picks: the day's rows as the page shows them (symbol, side, entry, stop, exit, reason, qty).
    Returns [{"time", "net_rs", "gross_rs"}] at 09:15 and each 15-minute close to 15:15, and how
    many positions had candles."""
    kite = kite_auth.trading_client()
    series, sized = {}, 0
    for p in picks:
        if not p.get("qty") or not p.get("entry"):
            continue
        bars = _bars(kite, p["fut"], day, "NFO") if p.get("fut") else _bars(kite, p["symbol"], day)  # Oops: the future it trades
        if not bars:
            continue
        sized += 1
        sign = 1 if p["side"] == "long" else -1
        lot, entry = p["qty"] * size, p["entry"]
        stopped = str(p.get("reason") or "").startswith("stop")
        out_px = None
        filled = datetime.fromisoformat(f"{day}T{p['filled_at']}") if p.get("filled_at") else None  # bought during the day
        for b in bars:
            if filled is not None and b["t"] + timedelta(minutes=15) <= filled:
                continue  # before the buy
            if b["t"].time() >= EXIT_AT:  # out at 15:15: the recorded exit (or 15:15 open)
                px = p["exit"] if p.get("closed") and p.get("exit") else b["open"]
                out_px = out_px or px
                t = b["t"]
                series.setdefault(t, []).append((sign * lot * (out_px - entry), cps * lot * (entry + out_px), p["side"], p["symbol"]))
                break
            if out_px is None and stopped and p.get("stop"):
                hit = (sign == 1 and b["low"] <= p["stop"]) or (sign == -1 and b["high"] >= p["stop"])
                if hit:
                    out_px = p["stop"]
            px = out_px if out_px is not None else b["close"]
            exit_cost = cps * lot * px if out_px is not None else 0
            t = b["t"] + timedelta(minutes=15)  # marked at the candle's close
            series.setdefault(t, []).append((sign * lot * (px - entry), cps * lot * entry + exit_cost, p["side"], p["symbol"]))
    if not series:
        return {"points": [], "positions": 0}
    start = min(series) - timedelta(minutes=15)
    entry_cost = sum(cps * p["qty"] * size * p["entry"] for p in picks if p.get("qty") and p.get("entry"))
    side_cost = {s_: -sum(cps * p["qty"] * size * p["entry"] for p in picks if p.get("qty") and p.get("entry") and p["side"] == s_)
                 for s_ in ("long", "short")}
    points = [{"time": _epoch(start), "gross_rs": 0.0, "net_rs": round(-entry_cost, 2),
               "long_rs": round(side_cost["long"], 2), "short_rs": round(side_cost["short"], 2)}]
    latest = {}
    for t in sorted(series):
        rows = series[t]
        if len(rows) < sized:  # a position without this candle (no trade in it): skip the point
            continue
        g = sum(r[0] for r in rows)
        net_by = lambda side: round(sum(r[0] - r[1] for r in rows if r[2] == side), 2)
        points.append({"time": _epoch(t), "gross_rs": round(g, 2), "net_rs": round(g - sum(r[1] for r in rows), 2),
                       "long_rs": net_by("long"), "short_rs": net_by("short")})
        latest = {(r[3], r[2]): round(r[0] - r[1], 2) for r in rows}
    by_position = sorted(({"symbol": s_, "side": side, "net_rs": v} for (s_, side), v in latest.items()), key=lambda x: -x["net_rs"])
    return {"points": points, "positions": sized, "by_position": by_position,
            "sides": [s_ for s_ in ("long", "short") if any(p["side"] == s_ for p in picks)]}


def _epoch(t):
    t = t.replace(tzinfo=None)
    return int((t - datetime(1970, 1, 1)).total_seconds())  # naive IST clock as if UTC: the chart reads IST


def held_curve(positions, cps):
    """Open positions held over several days (short-term mean reversion): the book marked every
    15 minutes from the earliest buy to now. positions: symbol, buy_day (ISO), buy_at (HH:MM:SS),
    buy (price), qty (the lot). Each position counts from its own buy, with its entry-side cost;
    returns points with the net, gross and each position's net, and each position's net now."""
    kite = kite_auth.trading_client()
    pos = [p for p in positions if p.get("qty") and p.get("buy")]
    if not pos:
        return {"points": [], "positions": 0, "by_position": [], "symbols": []}
    today = gapwatch._now().date()
    first = min(datetime.fromisoformat(p["buy_day"]).date() for p in pos)
    days = [first + timedelta(days=i) for i in range((today - first).days + 1)]
    days = [d.isoformat() for d in days if d.weekday() < 5]
    marks = {}  # time -> {symbol: (gross, cost)}
    for p in pos:
        bought = datetime.fromisoformat(f"{p['buy_day']}T{p['buy_at']}")
        lot, entry = p["qty"], p["buy"]
        for day in days:
            if day < p["buy_day"]:
                continue
            for b in (_bars(kite, p["fut"], day, "NFO") if p.get("fut") else _bars(kite, p["symbol"], day)):
                t = b["t"] + timedelta(minutes=15)  # the candle's close
                if t <= bought:
                    continue
                marks.setdefault(t, {})[p["symbol"]] = (lot * (b["close"] - entry), cps * lot * entry)
    first_buy = min(datetime.fromisoformat(f"{p['buy_day']}T{p['buy_at']}") for p in pos).replace(second=0)
    start_cost = sum(cps * p["qty"] * p["buy"] for p in pos if datetime.fromisoformat(f"{p['buy_day']}T{p['buy_at']}").replace(second=0) == first_buy)
    points, last = [{"time": _epoch(first_buy), "gross_rs": 0.0, "net_rs": round(-start_cost, 2), "by": {}}], {}
    for t in sorted(marks):
        last.update(marks[t])  # a position without this candle keeps its last mark
        held = {s: v for s, v in last.items()}
        g = sum(v[0] for v in held.values())
        points.append({"time": _epoch(t), "gross_rs": round(g, 2), "net_rs": round(g - sum(v[1] for v in held.values()), 2),
                       "by": {s: round(v[0] - v[1], 2) for s, v in held.items()}})
    # the live price as the last point (Kite only serves finished candles)
    now = gapwatch._now().replace(tzinfo=None, second=0, microsecond=0)
    live = {p["symbol"]: (p["qty"] * (p["ltp"] - p["buy"]), cps * p["qty"] * p["buy"]) for p in pos if p.get("ltp")}
    if live and (not marks or now > max(marks)):
        last.update(live)
        g = sum(v[0] for v in last.values())
        points.append({"time": _epoch(now), "gross_rs": round(g, 2), "net_rs": round(g - sum(v[1] for v in last.values()), 2),
                       "by": {s: round(v[0] - v[1], 2) for s, v in last.items()}, "live": True})
    by_position = sorted(({"symbol": s, "side": "long", "net_rs": round(v[0] - v[1], 2)} for s, v in last.items()), key=lambda x: -x["net_rs"])
    return {"points": points, "positions": len(pos), "by_position": by_position, "symbols": [p["symbol"] for p in pos], "sides": ["long"]}
