"""Buy on gap for the v2 page: the stored backtest trades (backtest.py, "1sd-top10-*" variants:
Chan's rule, the 10 biggest qualifying gaps a day) re-sized to the page's common parameters.

- Max open N (1-10): each day the N biggest gaps (the same ranking the backtest used: the gap
  from the previous day's low, or high for shorts, to the open), capital / N each; a day with fewer
  than N leaves the rest in cash.
- As per model (max_open 0): the book, every pick (up to 10) with capital split equally among
  that day's buys.

All returns are fractions of capital (the page turns them into rupees). A trade's cost is NSE futures
charges + slippage on the buy and the sale (xsmr.cost_per_side), on its own value. Intraday: every
trade is in at the 09:15 open and out by 15:15, so there is no overnight carry or futures roll.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmr
from db import connect

DATASETS = ("fno", "stocks", "indices")
SIDES = ("long", "both")
STOPS = ("none", "1sd")
MAX_OPEN = 10
TRADING_DAYS = xsmr.TRADING_DAYS
CACHE_SECONDS = 1800
_cache, _lock = {}, threading.Lock()


def _trades(dataset, side, stop):
    """The stored top-10 trades with each one's gap size (the ranking key)."""
    key = (dataset, side, stop)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    with connect() as conn:
        t = pd.read_sql(
            """
            SELECT t.symbol, t.date AS day, t.side, t.entry, t.stop, t.exit, t.exit_reason, p.low AS prev_low, p.high AS prev_high
            FROM bt_trades t
            LEFT JOIN LATERAL (SELECT low, high FROM bt_daily d WHERE d.symbol = t.symbol AND d.day < t.date
                               ORDER BY d.day DESC LIMIT 1) p ON true
            WHERE t.model = 'gap' AND t.dataset = %s AND t.variant = %s AND t.status = 'closed'
            """,
            conn, params=[dataset, f"1sd-top10-{side}-{stop}-1d"])
        days = pd.read_sql("SELECT DISTINCT d.day FROM bt_daily d JOIN bt_symbols s ON s.symbol = d.symbol "
                           "WHERE s.dataset = %s AND d.day >= (SELECT min(date) FROM bt_trades WHERE model = 'gap' "
                           "AND dataset = %s) ORDER BY d.day", conn, params=[dataset, dataset])
    t["day"] = pd.to_datetime(t["day"])
    long = t["side"] == "long"
    t["gap"] = np.where(long, 1 - t["entry"] / t["prev_low"], t["entry"] / t["prev_high"] - 1)
    t["ret"] = np.where(long, 1, -1) * (t["exit"] / t["entry"] - 1)
    t = t.sort_values(["day", "gap"], ascending=[True, False]).reset_index(drop=True)
    t["rank"] = t.groupby("day").cumcount() + 1
    value = (t, pd.DatetimeIndex(pd.to_datetime(days["day"])))
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _sized(dataset, side, stop, max_open, slippage):
    t, days = _trades(dataset, side, stop)
    t = t[t["rank"] <= (max_open or MAX_OPEN)].copy()
    t["w"] = 1.0 / max_open if max_open else 1.0 / t.groupby("day")["day"].transform("size")
    t["cost"] = (1 + t["exit"] / t["entry"]) * xsmr.cost_per_side(slippage)
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]  # the trade's share of capital
    days = days[(days >= t["day"].min())] if len(t) else days
    return t, days


def results(dataset="fno", side="long", stop="none", max_open=5, slippage=0.0002):
    t, days = _sized(dataset, side, stop, max_open, slippage)
    extra = {"avg_positions": round(float(t.groupby("day").size().mean()), 1)} if len(t) else {}
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, dataset="fno", side="long", stop="none", max_open=5, slippage=0.0002):
    t, _ = _sized(dataset, side, stop, max_open, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "symbol": r.symbol, "side": r.side, "rank": int(r.rank),
             "gap_pct": round(100 * float(r.gap), 2), "entry": round(float(r.entry), 2), "stop": round(float(r.stop), 2),
             "exit": round(float(r.exit), 2), "reason": r.exit_reason, "weight_pct": round(100 * float(r.w), 2),
             "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3), "net_pct": round(100 * float(r.net), 3),
             "book_net_pct": round(100 * float(r.book_net), 4), "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
