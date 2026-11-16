"""Key Breakout Dow Theory for the v2 page: the stored backtest trades (backtest.py: entry at the
key-break level on 15m candles, the model stop or a fixed / capped % stop, out at 15:15 on day 1, 3
or 5; one position per symbol at a time) sized to the page's common parameters.

- Max open N (1-10): at most N positions at once, capital / N each. Trades are taken in order of
  entry time; a slot is free again the day after its position's exit (exit times aren't stored, so
  a slot is never reused on its exit day).
- As per model (max_open 0): KBDT is built around its stop, so each trade risks the same 1% of
  capital (1R = 1%: position value = 1% / stop distance), at most MAX_PER_DAY new trades a day, as
  the classic page did.

Returns are fractions of capital. Costs: NSE futures charges + slippage on the buy and the sale, on
the position's value, plus the futures roll (a sale and a buy) when a trade is held across a month
end. A trade's result counts on its exit day.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmr
from db import connect

DATASETS = ("indices", "stocks", "fno")
HOLDS = ("1d", "3d", "5d")
STOP_MODES = ("model", "fixed", "cap")
STOP_PCTS = (0.5, 0.75, 1.0, 1.5, 2.0)
MAX_OPEN = 10
MAX_PER_DAY = 3
RISK = 0.01  # As per model: 1R = 1% of capital
MAX_TRADE_MOVE = 0.5  # a trade moving more than this within its 1-5 days is a bad print
CACHE_SECONDS = 1800
_cache, _lock = {}, threading.Lock()


def variant(hold, stop_mode, stop_pct):
    return hold if stop_mode == "model" else f"{hold}-{stop_mode}-{stop_pct:g}"


def _trades(dataset, var):
    key = (dataset, var)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    with connect() as conn:
        t = pd.read_sql("SELECT symbol, date AS day, side, entry_time, entry_label, entry, stop, exit, exit_reason, r, exit_date "
                        "FROM bt_trades WHERE model = 'kbdt' AND dataset = %s AND variant = %s AND status = 'closed' "
                        "ORDER BY entry_time, symbol", conn, params=[dataset, var])
    # Data hygiene: a few stored 15m candles have a zero price (a "gap through the stop" at 0 looks like
    # a -100% trade); trades with a zero price or a move over MAX_TRADE_MOVE are bad prints, left out.
    t = t[(t["entry"] > 0) & (t["exit"] > 0) & ((t["exit"] / t["entry"] - 1).abs() <= MAX_TRADE_MOVE)].reset_index(drop=True)
    days = v2common.trading_days(dataset, t["day"].min()) if len(t) else pd.DatetimeIndex([])
    t["entry_day"], t["exit_day"] = pd.to_datetime(t["day"]), pd.to_datetime(t["exit_date"])
    sign = np.where(t["side"] == "long", 1, -1)
    t["ret"] = sign * (t["exit"] / t["entry"] - 1)
    t["risk"] = (t["entry"] - t["stop"]).abs() / t["entry"]  # stop distance, a fraction of the entry
    t["rolls"] = ((t["exit_day"].dt.year * 12 + t["exit_day"].dt.month) - (t["entry_day"].dt.year * 12 + t["entry_day"].dt.month)).clip(lower=0)
    value = (t.reset_index(drop=True), days)
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _sized(dataset, var, max_open, slippage):
    t, days = _trades(dataset, var)
    t = t.copy()
    if max_open:
        take, open_until = [], []
        for e, x in zip(t["entry_day"], t["exit_day"]):
            open_until = [u for u in open_until if u >= e]  # free the day after the exit
            if len(open_until) < max_open:
                take.append(True)
                open_until.append(x)
            else:
                take.append(False)
        t = t[np.array(take, dtype=bool)].copy()
        t["w"] = 1.0 / max_open
    else:
        t = t[t.groupby("entry_day").cumcount() < MAX_PER_DAY].copy()
        t = t[t["risk"] > 0]
        t["w"] = RISK / t["risk"]  # the value that loses 1% of capital at the stop
    cps = xsmr.cost_per_side(slippage)
    t["cost"] = (1 + t["exit"] / t["entry"] + 2 * t["rolls"]) * cps
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    t["day"] = t["exit_day"]
    return t, days


def results(dataset="indices", hold="5d", stop_mode="model", stop_pct=1.0, max_open=5, slippage=0.0002):
    t, days = _sized(dataset, variant(hold, stop_mode, stop_pct), max_open, slippage)
    extra = {}
    if len(t):
        span = pd.date_range(t["entry_day"].min(), t["exit_day"].max(), freq="B")
        held = sum(((span >= e) & (span <= x)).astype(int) for e, x in zip(t["entry_day"], t["exit_day"])) if len(t) < 20000 else None
        extra = {"avg_held_days": round(float(((t["exit_day"] - t["entry_day"]).dt.days + 1).mean()), 1),
                 "long_share": round(float(100 * (t["side"] == "long").mean()), 1),
                 "stopped_pct": round(float(100 * t["exit_reason"].str.startswith("stop").mean()), 1),
                 "avg_open": round(float(held.mean()), 1) if held is not None else None,
                 "avg_r": round(float(t["r"].mean()), 3)}
        if not max_open:
            extra["avg_size_pct"] = round(float(100 * t["w"].mean()), 1)
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, dataset="indices", hold="5d", stop_mode="model", stop_pct=1.0, max_open=5, slippage=0.0002):
    t, _ = _sized(dataset, variant(hold, stop_mode, stop_pct), max_open, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"entry_day": r.entry_day.date().isoformat(), "entry_time": r.entry_label, "exit_day": r.exit_day.date().isoformat(),
             "entry_at": f"{r.entry_day.date().isoformat()} {r.entry_label}",
             "exit_at": f"{r.exit_day.date().isoformat()} "
                        f"{v2common.exit_time(r.exit_reason, v2common.CLOSE if 'close' in str(r.exit_reason) else '15:15')}",
             "symbol": r.symbol, "side": r.side, "entry": round(float(r.entry), 2), "stop": round(float(r.stop), 2),
             "exit": round(float(r.exit), 2), "reason": r.exit_reason, "r": round(float(r.r), 2), "rolls": int(r.rolls),
             "weight_pct": round(100 * float(r.w), 2), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
