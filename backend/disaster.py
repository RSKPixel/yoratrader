"""Disaster stops for the mean-reversion models (Ernest Chan, Algorithmic Trading ch. 8): a stop loss
contradicts a mean-reversion entry and only ever lowers its backtest, but a model can stop reverting
(a regime change, a black swan), so each position gets a stop set WIDER than the worst move against any
position in the backtest: it never fires there (the backtest is unchanged) yet caps a future disaster.

For each model: the worst adverse move of any backtest position on its day (the day's low against a
long's entry, the high against a short's), and the stop = that, rounded up to the next whole percent.
Recomputed from the stored backtests every few hours. Used by the backtest pages (shown), the paper
books (applied: a position whose day low / high, or live price, reaches the level is out there) and the
Live trading cards (the level to place in Kite).
"""

import math
import threading
import time

import numpy as np
import pandas as pd

from db import connect

MODELS = ("gap", "xsmr")
CACHE_SECONDS = 6 * 3600
_cache, _lock = {"at": 0, "data": None}, threading.Lock()


def _daily_range():
    with connect() as conn:
        d = pd.read_sql("SELECT symbol, day, high, low FROM bt_daily WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = 'fno') "
                        "AND close > 0 AND day >= '2015-01-01'", conn, parse_dates=["day"])
    return d


def _worst(t, d):
    x = t[["symbol", "day", "side", "entry"]].merge(d, on=["symbol", "day"], how="left")
    long = x["side"] == "long"
    adv = pd.Series(np.where(long, x["low"] / x["entry"] - 1, 1 - x["high"] / x["entry"]), index=x.index)
    adv = adv[np.isfinite(adv)]
    if adv.empty:
        return None
    i = adv.idxmin()
    return {"worst_pct": round(float(100 * -adv[i]), 2), "worst_symbol": x.at[i, "symbol"], "worst_day": x.at[i, "day"].date().isoformat(),
            "worst_side": x.at[i, "side"], "stop_pct": float(math.floor(100 * -adv[i]) + 1), "positions": int(len(adv))}


def levels():
    """{model: {stop_pct, worst_pct, worst_symbol, worst_day, worst_side, positions}}."""
    with _lock:
        if _cache["data"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
            return _cache["data"]
    import v2gap
    import v2xsmr
    d = _daily_range()
    out = {}
    try:
        g, _ = v2gap._trades("fno", "both", "none")  # every stored gap trade, long and short
        out["gap"] = _worst(g, d)
    except Exception as error:
        print("Disaster stop (gap) failed:", error)
    try:
        x, _ = v2xsmr._sized("fno", "intraday", "0915", "none", 10, 5, 0.0002)  # the 5 + 5 book: every position the page can hold
        out["xsmr"] = _worst(x, d)
    except Exception as error:
        print("Disaster stop (xsmr) failed:", error)
    with _lock:
        _cache.update(at=time.time(), data=out)
    return out


def warm():
    threading.Thread(target=levels, daemon=True, name="disaster-warm").start()


def stop_pct(model):
    lv = levels().get(model) or {}
    return lv.get("stop_pct")


def apply(side, entry, low=None, high=None, last=None, pct=None):
    """(hit, exit price): whether the day's low / high (or the live price) reached the disaster level."""
    if not pct or not entry:
        return False, None
    level = entry * (1 - pct / 100) if side == "long" else entry * (1 + pct / 100)
    if side == "long":
        worst = min(x for x in (low, last) if x is not None) if (low is not None or last is not None) else None
        return (worst is not None and worst <= level), round(level, 2)
    worst = max(x for x in (high, last) if x is not None) if (high is not None or last is not None) else None
    return (worst is not None and worst >= level), round(level, 2)


def day_ranges(pairs):
    """{(symbol, day iso): (low, high)} from the stored daily candles, for the paper books' closed days."""
    if not pairs:
        return {}
    syms = sorted({s for s, _ in pairs})
    days = sorted({d for _, d in pairs})
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT symbol, day, low, high FROM bt_daily WHERE symbol = ANY(%s) AND day = ANY(%s::date[])", (syms, days))
        return {(s, d.isoformat()): (lo, hi) for s, d, lo, hi in cur.fetchall()}
