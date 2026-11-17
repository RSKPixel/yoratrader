"""Buy on gap for the v2 page: the stored backtest trades (backtest.py, "1sd-top10-*" variants:
Chan's rule, the 10 biggest qualifying gaps a day) re-sized to the page's common parameters.

- Max open N (1-10): each day the N biggest gaps (the same ranking the backtest used: the gap
  from the previous day's low, or high for shorts, to the open), capital / N each; a day with fewer
  than N leaves the rest in cash.
- As per model (max_open 0): the book, every pick (up to 10) with capital split equally among
  that day's buys.

Also serves opening gap momentum (model "gapmom", Chan ch. 7: the mirror image, follow the gap: buy
an open above the previous high by 0.1σ, short one below the previous low; no average filter, no
ranking: as per model every qualifying stock or index trades, capital split across the day's trades).

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


GAPMOM_DATASETS = ("indices", "fno")


def _stored_variant(model, side, stop):
    return f"1sd-top10-{side}-{stop}-1d" if model == "gap" else f"0.1sd-all-{side}-{stop}-1d"


def _trades(dataset, side, stop, model="gap"):
    """The stored trades with each one's gap size (the ranking key)."""
    key = (model, dataset, side, stop)
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
            WHERE t.model = %s AND t.dataset = %s AND t.variant = %s AND t.status = 'closed'
            """,
            conn, params=[model, dataset, _stored_variant(model, side, stop)])
        days = pd.read_sql("SELECT DISTINCT d.day FROM bt_daily d JOIN bt_symbols s ON s.symbol = d.symbol "
                           "WHERE s.dataset = %s AND d.day >= (SELECT min(date) FROM bt_trades WHERE model = %s "
                           "AND dataset = %s) ORDER BY d.day", conn, params=[dataset, model, dataset])
    t["day"] = pd.to_datetime(t["day"])
    long = t["side"] == "long"
    if model == "gap":  # fade: a long opened below the previous low, a short above the previous high
        t["gap"] = np.where(long, 1 - t["entry"] / t["prev_low"], t["entry"] / t["prev_high"] - 1)
    else:  # follow: a long opened above the previous high, a short below the previous low
        t["gap"] = np.where(long, t["entry"] / t["prev_high"] - 1, 1 - t["entry"] / t["prev_low"])
    t["ret"] = np.where(long, 1, -1) * (t["exit"] / t["entry"] - 1)
    t = t.sort_values(["day", "gap"], ascending=[True, False]).reset_index(drop=True)
    t["rank"] = t.groupby("day").cumcount() + 1
    value = (t, pd.DatetimeIndex(pd.to_datetime(days["day"])))
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _sized(dataset, side, stop, max_open, slippage, model="gap", disaster="off"):
    t, days = _trades(dataset, side, stop, model)
    cap = max_open or (MAX_OPEN if model == "gap" else None)  # gapmom's book takes every qualifier
    t = (t[t["rank"] <= cap] if cap else t).copy()
    if disaster == "on" and len(t):  # the 10% disaster stop (disaster.py): out at the level if the day reached it
        import disaster as ds
        hit, level = ds.frame_hits(t)
        t.loc[hit, "exit"] = level[hit]
        t.loc[hit, "exit_reason"] = "disaster stop"
        t["ret"] = np.where(t["side"] == "long", 1, -1) * (t["exit"] / t["entry"] - 1)
    t["w"] = 1.0 / max_open if max_open else 1.0 / t.groupby("day")["day"].transform("size")
    t["cost"] = (1 + t["exit"] / t["entry"]) * xsmr.cost_per_side(slippage)
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]  # the trade's share of capital
    days = days[(days >= t["day"].min())] if len(t) else days
    return t, days


def results(dataset="fno", side="long", stop="none", max_open=5, slippage=0.0002, model="gap", disaster="off"):
    t, days = _sized(dataset, side, stop, max_open, slippage, model, disaster)
    extra = {"avg_positions": round(float(t.groupby("day").size().mean()), 1)} if len(t) else {}
    if disaster == "on":
        import disaster as ds
        extra.update(disaster_pct=ds.PCT, disaster_hits=int((t["exit_reason"] == "disaster stop").sum()))
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, dataset="fno", side="long", stop="none", max_open=5, slippage=0.0002, model="gap", disaster="off"):
    t, _ = _sized(dataset, side, stop, max_open, slippage, model, disaster)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "entry_at": f"{r.day.date().isoformat()} 09:15",
             "exit_at": f"{r.day.date().isoformat()} {v2common.exit_time(r.exit_reason, '15:15')}",
             "symbol": r.symbol, "side": r.side, "rank": int(r.rank),
             "gap_pct": round(100 * float(r.gap), 2), "entry": round(float(r.entry), 2), "stop": round(float(r.stop), 2),
             "exit": round(float(r.exit), 2), "reason": r.exit_reason, "weight_pct": round(100 * float(r.w), 2),
             "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3), "net_pct": round(100 * float(r.net), 3),
             "book_net_pct": round(100 * float(r.book_net), 4), "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
