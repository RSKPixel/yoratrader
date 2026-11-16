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


def _bars(kite, symbol, day):
    key = (symbol, day)
    today = gapwatch._now().date().isoformat()
    with _lock:
        hit = _cache.get(key)
        if hit and (day != today or time.time() - hit[0] < TODAY_TTL):
            return hit[1]
    token = gapwatch._token(kite, symbol)
    if not token:
        return []
    d = datetime.fromisoformat(day)
    bars = kite.historical_data(token, from_date=d.replace(hour=9, minute=15), to_date=d.replace(hour=15, minute=30), interval="15minute")
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
        bars = _bars(kite, p["symbol"], day)
        if not bars:
            continue
        sized += 1
        sign = 1 if p["side"] == "long" else -1
        lot, entry = p["qty"] * size, p["entry"]
        stopped = str(p.get("reason") or "").startswith("stop")
        out_px = None
        for b in bars:
            if b["t"].time() >= EXIT_AT:  # out at 15:15: the recorded exit (or 15:15 open)
                px = p["exit"] if p.get("closed") and p.get("exit") else b["open"]
                out_px = out_px or px
                t = b["t"]
                series.setdefault(t, []).append((sign * lot * (out_px - entry), cps * lot * (entry + out_px)))
                break
            if out_px is None and stopped and p.get("stop"):
                hit = (sign == 1 and b["low"] <= p["stop"]) or (sign == -1 and b["high"] >= p["stop"])
                if hit:
                    out_px = p["stop"]
            px = out_px if out_px is not None else b["close"]
            exit_cost = cps * lot * px if out_px is not None else 0
            t = b["t"] + timedelta(minutes=15)  # marked at the candle's close
            series.setdefault(t, []).append((sign * lot * (px - entry), cps * lot * entry + exit_cost))
    if not series:
        return {"points": [], "positions": 0}
    start = min(series) - timedelta(minutes=15)
    entry_cost = sum(cps * p["qty"] * size * p["entry"] for p in picks if p.get("qty") and p.get("entry"))
    points = [{"time": _epoch(start), "gross_rs": 0.0, "net_rs": round(-entry_cost, 2)}]
    for t in sorted(series):
        rows = series[t]
        if len(rows) < sized:  # a position without this candle (no trade in it): skip the point
            continue
        g = sum(r[0] for r in rows)
        points.append({"time": _epoch(t), "gross_rs": round(g, 2), "net_rs": round(g - sum(r[1] for r in rows), 2)})
    return {"points": points, "positions": sized}


def _epoch(t):
    t = t.replace(tzinfo=None)
    return int((t - datetime(1970, 1, 1)).total_seconds())  # naive IST clock as if UTC: the chart reads IST
