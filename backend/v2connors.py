"""Short-term mean reversion for the v2 page (Connors & Sen; connors.py has the model and simulates
it trade by trade): long only, F&O stocks above their 200-day average that are short-term oversold,
held 5 (or 2) trading days.

- Max open N: connors' "-max<N>" books: at most N trades open, capital / N each; a new trade only
  when a slot is free (the most oversold qualifying stock not already held).
- As per model (max_open 0): the book: each day's picks share a fifth of capital (Take: all the
  day's signals, or only the 3 / 5 lowest RSIs).

A trade's result is its return, less charges + slippage on the buy, the sale and any futures roll
(a hold across a month end); it counts on the sale day.
"""

import pandas as pd

import connors
import v2common
import xsmr

DATASETS = connors.DATASETS
SETUPS = ("rsi2", "low10", "down3", "every")
HOLDS = ("5d", "2d")
STOPS = {"none": "", "1sd": "-1sd", "2sd": "-2sd", "3pc": "-3pc", "5pc": "-5pc", "7pc": "-7pc", "10pc": "-10pc"}
TIMINGS = {"1515": "", "close": "-close"}
TAKES = ("all", "top5", "top3")
MAX_OPEN = 10


def variant(setup, hold, max_open, stop, timing, take):
    base = f"{setup}-{hold}{f'-max{max_open}' if max_open else ''}{STOPS[stop]}{TIMINGS[timing]}"
    return base if max_open or take == "all" else f"{base}-{take}"


def _sized(dataset, setup, hold, max_open, stop, timing, take, slippage):
    f, trades, d = connors._run(variant(setup, hold, max_open, stop, timing, take), dataset)
    cps = xsmr.cost_per_side(slippage)
    # connors' own daily book (open trades marked at each close, trades charged on their day)
    daily = pd.DataFrame({"book_ret": f["gross_ret"].to_numpy(), "book_cost": f["turnover"].to_numpy() * cps},
                         index=pd.to_datetime(f["day"]))
    idx, cols = d["px"].index, d["px"].columns
    closed = [x for x in trades if x["sell"] is not None]
    t = pd.DataFrame({
        "symbol": [cols[x["s"]] for x in closed], "entry_day": [idx[x["buy_i"]] for x in closed],
        "day": [idx[x["sell_i"]] for x in closed], "w": [x["w"] for x in closed], "buy": [x["buy"] for x in closed],
        "sell": [x["sell"] for x in closed], "rsi": [x["rsi"] for x in closed], "reason": [x["reason"] for x in closed],
        "stop": [x.get("stop") for x in closed], "roll": [x.get("roll", 0.0) for x in closed],
        "held": [x["sell_i"] - x["buy_i"] for x in closed]})
    if t.empty:
        return t, pd.DatetimeIndex(idx), daily
    t["ret"] = t["sell"] / t["buy"] - 1
    t["cost"] = (1 + t["sell"] / t["buy"] + t["roll"]) * cps
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    t["day"], t["entry_day"] = pd.to_datetime(t["day"]), pd.to_datetime(t["entry_day"])
    return t, pd.DatetimeIndex(idx), daily


def results(dataset="fno", setup="rsi2", hold="5d", max_open=3, stop="none", timing="close", take="all", slippage=0.0002):
    t, days, daily = _sized(dataset, setup, hold, max_open, stop, timing, take, slippage)
    extra = {}
    if len(t):
        extra = {"avg_held_days": round(float(t["held"].mean()), 1),
                 "stopped_pct": round(float(100 * t["reason"].str.startswith("stop").mean()), 1),
                 "avg_rsi": round(float(t["rsi"].mean()), 1)}
    return v2common.build_results(t, days, slippage, extra, daily=daily)


def month_trades(month, dataset="fno", setup="rsi2", hold="5d", max_open=3, stop="none", timing="close", take="all", slippage=0.0002):
    t, _, _ = _sized(dataset, setup, hold, max_open, stop, timing, take, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month] if len(t) else t
    return [{"entry_day": r.entry_day.date().isoformat(), "exit_day": r.day.date().isoformat(), "days": int(r.held),
             "symbol": r.symbol, "rsi": round(float(r.rsi), 1), "entry": round(float(r.buy), 2),
             "stop": round(float(r.stop), 2) if r.stop is not None and pd.notna(r.stop) else None,
             "exit": round(float(r.sell), 2), "reason": r.reason, "rolls": round(float(r.roll) / 2),
             "weight_pct": round(100 * float(r.w), 3), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.sort_values(["day", "symbol"]).itertuples()]
