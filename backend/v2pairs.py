"""Pairs trading for the v2 page (Chan ch. 2-4; pairs.py has the model): the stored walk-forward
trades (pairs picked on the year before by a cointegration test, traded on the Bollinger z-score or a
Kalman filter) sized to the page's common parameters. F&O stocks only.

- Max open N with Pairs k (k + k: 2k <= N): at most k pairs open at once, each pair 2 x capital / N
  (its two legs), split between the legs by the hedge. Trades are taken in order of entry; on the same
  day the stronger cointegration test (the pair's rank from its formation year) goes first. A pair
  exiting at a close frees its slot for entries at that close.
- As per model (max_open 0): the book, every selected pair, capital split equally across the year's
  pairs.

A trade's result is its return on the pair's gross value (stored), less charges + slippage on what it
traded (in, out, any futures roll and, for the Kalman filter, its daily re-hedging). It counts on the
exit day.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmr
from db import connect

DATASETS = ("fno",)
METHODS = ("bollinger", "kalman")
MAX_OPEN = 10
CACHE_SECONDS = 1800
_cache, _lock = {}, threading.Lock()


def _variant(method, fill):
    return method + ("-next" if fill == "next" else "")


def _trades(var):
    with _lock:
        hit = _cache.get(var)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    with connect() as conn:
        t = pd.read_sql(
            """
            SELECT t.year, t.rank, t.y, t.x, t.side, t.entry_day, t.exit_day, t.days, t.gross_ret, t.turnover, p.hedge, p.industry,
                   (SELECT count(*) FROM bt_pairs q WHERE q.variant = t.variant AND q.year = t.year) AS pairs,
                   cy.close AS y_entry, cx.close AS x_entry, ey.close AS y_exit, ex.close AS x_exit
            FROM bt_pair_trades t
            JOIN bt_pairs p ON p.variant = t.variant AND p.year = t.year AND p.y = t.y AND p.x = t.x
            LEFT JOIN bt_daily cy ON cy.symbol = t.y AND cy.day = t.entry_day
            LEFT JOIN bt_daily cx ON cx.symbol = t.x AND cx.day = t.entry_day
            LEFT JOIN bt_daily ey ON ey.symbol = t.y AND ey.day = t.exit_day
            LEFT JOIN bt_daily ex ON ex.symbol = t.x AND ex.day = t.exit_day
            WHERE t.variant = %s
            ORDER BY t.entry_day, t.rank
            """, conn, params=[var])
    days = v2common.trading_days("fno", t["entry_day"].min()) if len(t) else pd.DatetimeIndex([])
    t["entry_day"], t["exit_day"] = pd.to_datetime(t["entry_day"]), pd.to_datetime(t["exit_day"])
    value = (t, days)
    with _lock:
        _cache[var] = (time.time(), value)
    return value


def _sized(method, fill, max_open, pairs, slippage):
    t, days = _trades(_variant(method, fill))
    t = t.copy()
    if max_open:
        k = max(1, min(int(pairs or 1), max_open // 2 or 1))
        take, open_until = [], []
        for e, x in zip(t["entry_day"], t["exit_day"]):
            open_until = [u for u in open_until if u > e]  # exited at or before this close: free
            if len(open_until) < k:
                take.append(True)
                open_until.append(x)
            else:
                take.append(False)
        t = t[np.array(take, dtype=bool)].copy()
        t["w"] = 2.0 / max_open  # both legs of the pair
    else:
        t["w"] = 1.0 / t["pairs"]
    cps = xsmr.cost_per_side(slippage)
    t["ret"] = t["gross_ret"]
    t["cost"] = t["turnover"] * cps
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    t["day"] = t["exit_day"]
    return t, days


def results(method="bollinger", fill="close", max_open=6, pairs=3, slippage=0.0002):
    t, days = _sized(method, fill, max_open, pairs, slippage)
    extra = {}
    if len(t):
        extra = {"avg_held_days": round(float(t["days"].mean()), 1),
                 "pairs_per_year": round(float(t.groupby("year")["pairs"].first().mean())),
                 "long_share": round(float(100 * (t["side"] == "long").mean()), 1),
                 "trades_label": "Pair trades"}
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, method="bollinger", fill="close", max_open=6, pairs=3, slippage=0.0002):
    t, _ = _sized(method, fill, max_open, pairs, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month]

    def num(v, d=2):
        return round(float(v), d) if pd.notna(v) else None

    return [{"entry_day": r.entry_day.date().isoformat(), "exit_day": r.exit_day.date().isoformat(),
             "entry_at": f"{r.entry_day.date().isoformat()} {v2common.CLOSE}", "exit_at": f"{r.exit_day.date().isoformat()} {v2common.CLOSE}", "days": int(r.days),
             "y": r.y, "x": r.x, "industry": r.industry, "rank": int(r.rank), "side": r.side, "hedge": num(r.hedge, 3),
             "y_entry": num(r.y_entry), "x_entry": num(r.x_entry), "y_exit": num(r.y_exit), "x_exit": num(r.x_exit),
             "weight_pct": round(100 * float(r.w), 3), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
