"""Larry Williams' "Oops" gap reversal (Long-Term Secrets to Short-Term Trading), long, on 15-minute
candles (today's F&O stocks, 2015 on), for the v2 backtest page and the paper book's reference.

- A stock opens below yesterday's low; it's bought when a 15-minute candle trades back up to that low
  (at the level, or at the candle's open if it opens above it).
- Stop (optional): just below the day's low so far at the buy (0.1% under it), checked on the later
  candles before 15:15; out at the stop (or the candle's open if it opens through it).
- Out at 15:15 (the 15:15 candle's open).
- Trend (optional): only stocks whose close was above their 200-day average yesterday.
- Max open N: the day's first N fills (by fill time), capital / N each; as per model: 3.

Costs: NSE futures charges + slippage on the buy and the sale. Built once from the stored candles (about
a minute) and cached; warmed at startup.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmr
from db import connect

START = "2015-03-01"
EXIT_AT = "15:15"
STOP_BELOW = 0.999
MAX_OPEN, BOOK_OPEN = 10, 3
CACHE_SECONDS = 6 * 3600
_cache, _lock = {"at": 0, "fills": None, "days": None}, threading.Lock()
_building = threading.Lock()


def _build():
    with connect() as c:
        syms = pd.read_sql("SELECT symbol FROM bt_symbols WHERE dataset = 'fno' ORDER BY symbol", c)["symbol"].tolist()
    fills = []
    for sym in syms:
        with connect() as c:
            d = pd.read_sql("SELECT day, low, close FROM bt_daily WHERE symbol = %s AND day >= '2014-01-01' ORDER BY day", c,
                            params=[sym], parse_dates=["day"]).set_index("day")
            m = pd.read_sql("SELECT (datetime AT TIME ZONE 'Asia/Kolkata') AS t, open, high, low, close FROM bt_15m "
                            "WHERE symbol = %s AND datetime >= %s ORDER BY datetime", c, params=[sym, START])
        if len(d) < 250 or m.empty:
            continue
        prev_low = d["low"].shift(1)
        up = d["close"].shift(1) > d["close"].shift(1).rolling(200, min_periods=180).mean()
        m["t"] = pd.to_datetime(m["t"])
        m["hm"] = m["t"].dt.strftime("%H:%M")
        for day, g in m.groupby(m["t"].dt.normalize()):
            if day not in d.index or len(g) < 10:
                continue
            pl = prev_low[day]
            rows = list(zip(g["hm"], g["open"], g["high"], g["low"]))
            if not (pl > 0) or not (rows[0][1] > 0) or rows[0][1] >= pl:  # must open below yesterday's low
                continue
            low_so_far, fill = np.inf, None
            for j, (hm, o, h, l) in enumerate(rows):
                if hm >= EXIT_AT:
                    break
                if h >= pl:
                    fill = (hm, max(o, pl), min(low_so_far, l) if low_so_far < np.inf else l, j)
                    break
                low_so_far = min(low_so_far, l)
            if fill is None:
                continue
            hm_fill, entry, low_at_fill, j = fill
            exit_px = next((o for (hm, o, h, l) in rows[j + 1:] if hm == EXIT_AT), None)
            if exit_px is None or not (exit_px > 0):
                continue
            stop = low_at_fill * STOP_BELOW
            hit = next((min(o, stop) for (hm, o, h, l) in rows[j + 1:] if hm < EXIT_AT and l <= stop), None)
            if abs(exit_px / entry - 1) > 0.25:  # a bad print
                continue
            fills.append((day, hm_fill, sym, bool(up.get(day, False)), float(pl), float(rows[0][1]), float(entry),
                          float(stop), float(exit_px), float(hit) if hit is not None else None))
    f = pd.DataFrame(fills, columns=["day", "fill_at", "symbol", "up", "prev_low", "open", "entry", "stop", "exit_time", "exit_stop"])
    days = v2common.trading_days("fno", pd.Timestamp(START))
    return f, days


def _fills():
    with _lock:
        if _cache["fills"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
            return _cache["fills"], _cache["days"]
    with _building:  # one build at a time; a second caller waits for it
        with _lock:
            if _cache["fills"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
                return _cache["fills"], _cache["days"]
        f, days = _build()
        with _lock:
            _cache.update(at=time.time(), fills=f, days=days)
        return f, days


def invalidate():
    with _lock:
        _cache.update(at=0)


def warm():
    threading.Thread(target=_fills, daemon=True, name="oops-warm").start()


def _sized(stop="low", trend="any", max_open=3, slippage=0.0002):
    f, days = _fills()
    t = f if trend == "any" else f[f["up"]]
    n = max_open or BOOK_OPEN
    t = t.sort_values(["day", "fill_at", "symbol"]).groupby("day").head(n).copy()
    stopped = t["exit_stop"].notna() if stop == "low" else pd.Series(False, index=t.index)
    t["exit"] = np.where(stopped, t["exit_stop"], t["exit_time"])
    t["reason"] = np.where(stopped, "stop", "15:15")
    t["gap_pct"] = 100 * (t["open"] / t["prev_low"] - 1)
    t["ret"] = t["exit"] / t["entry"] - 1
    t["w"] = 1.0 / n
    t["cost"] = (1 + t["exit"] / t["entry"]) * xsmr.cost_per_side(slippage)
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    t["day"] = pd.to_datetime(t["day"])
    return t.reset_index(drop=True), days


def results(stop="low", trend="any", max_open=3, slippage=0.0002):
    t, days = _sized(stop, trend, max_open, slippage)
    extra = {}
    if len(t):
        extra = {"avg_positions": round(float(t.groupby("day").size().mean()), 1),
                 "stopped_pct": round(float(100 * (t["reason"] == "stop").mean()), 1),
                 "avg_gap_pct": round(float(t["gap_pct"].mean()), 2),
                 "median_fill_at": sorted(t["fill_at"])[len(t) // 2]}
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, stop="low", trend="any", max_open=3, slippage=0.0002):
    t, _ = _sized(stop, trend, max_open, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "symbol": r.symbol, "fill_at": r.fill_at, "gap_pct": round(float(r.gap_pct), 2),
             "prev_low": round(r.prev_low, 2), "open": round(r.open, 2), "entry": round(r.entry, 2),
             "stop": round(r.stop, 2) if stop == "low" else None, "exit": round(float(r.exit), 2), "reason": r.reason,
             "weight_pct": round(100 * float(r.w), 2), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.sort_values(["day", "fill_at"]).itertuples()]
