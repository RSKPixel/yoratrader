"""Disaster stop for the mean-reversion models (Buy/Sell on gap, cross-sectional mean reversion), a
switch (on / off) on their backtest and paper pages.

Ernest Chan (Algorithmic Trading ch. 8): a stop loss contradicts a mean-reversion entry and usually
lowers its backtest, but a model can stop reverting (a regime change, a black swan), so a wide stop
caps the damage. Chan sets it beyond the backtest's worst move; here it is a fixed PCT from the entry
(the user's choice: it fired on about 1-2% of backtest trades, costing about 0.5% a year on gap and 6% a
year on cross-sectional, and caps any one position's loss at PCT).

A position is out at the level when its day's low (a long) or high (a short) reaches it, or, while
open, its live price. Backtests use the stored daily candles (the whole day's range, a little
pessimistic for the minutes before the 09:15 entry).
"""

import threading
import time

import numpy as np
import pandas as pd

from db import connect

PCT = 10.0
CACHE_SECONDS = 6 * 3600
_cache, _lock = {"at": 0, "data": None}, threading.Lock()


def _ranges():
    """Every F&O stock's daily low and high since 2015, indexed by (symbol, day)."""
    with _lock:
        if _cache["data"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
            return _cache["data"]
    with connect() as conn:
        d = pd.read_sql("SELECT symbol, day, low, high FROM bt_daily WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = 'fno') "
                        "AND close > 0 AND day >= '2015-01-01'", conn, parse_dates=["day"])
    d = d.set_index(["symbol", "day"])
    with _lock:
        _cache.update(at=time.time(), data=d)
    return d


def frame_hits(t, pct=PCT):
    """For backtest rows (symbol, day, side, entry): (hit mask, exit level) arrays."""
    r = _ranges().reindex(pd.MultiIndex.from_arrays([t["symbol"], pd.to_datetime(t["day"])]))
    long = (t["side"] == "long").to_numpy()
    entry = t["entry"].to_numpy(float)
    level = np.where(long, entry * (1 - pct / 100), entry * (1 + pct / 100))
    hit = np.where(long, r["low"].to_numpy() <= level, r["high"].to_numpy() >= level)
    return np.nan_to_num(hit, nan=0).astype(bool), level


def apply(side, entry, low=None, high=None, last=None, pct=PCT):
    """(hit, exit price): whether the day's low / high (or the live price) reached the level."""
    if not pct or not entry:
        return False, None
    if side == "long":
        level = entry * (1 - pct / 100)
        seen = [x for x in (low, last) if x is not None]
        return (bool(seen) and min(seen) <= level), round(level, 2)
    level = entry * (1 + pct / 100)
    seen = [x for x in (high, last) if x is not None]
    return (bool(seen) and max(seen) >= level), round(level, 2)


def day_ranges(pairs):
    """{(symbol, day iso): (low, high)} from the stored daily candles, for the paper books' closed days."""
    if not pairs:
        return {}
    syms = sorted({s for s, _ in pairs})
    days = sorted({d for _, d in pairs})
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT symbol, day, low, high FROM bt_daily WHERE symbol = ANY(%s) AND day = ANY(%s::date[])", (syms, days))
        return {(s, d.isoformat()): (lo, hi) for s, d, lo, hi in cur.fetchall()}
