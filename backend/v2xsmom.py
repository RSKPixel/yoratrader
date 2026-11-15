"""Cross-sectional momentum for the v2 page (Chan ch. 6; xsmom.py has the model): rank the stocks by
their 252-day return, long the strongest and short the weakest, hold 25 trading days.

- Max open N with Pairs k (2k <= N): the k strongest and k weakest, re-ranked every 25 trading days
  (one book at a time instead of the 25 overlapping slices), each position capital / N. A stock that
  stays in the picks is one continuing trade, so it pays only to enter, to leave and the monthly
  futures rolls in between.
- As per model (max_open 0): Chan's book, the 25 overlapping slices of the top and bottom 10%
  (stored by xsmom.run_all; one row a day, its result and costs as stored).

Fill: the signal close (the book) or the next close. Daily moves over 20% earn nothing (xsmom's data
hygiene). A trade's result counts on its exit day; trades still open at the end are left out.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmom
import xsmr

DATASETS = xsmom.DATASETS
HOLD = xsmom.HOLD
MAX_OPEN = 10
CACHE_SECONDS = 1800
_cache, _lock = {}, threading.Lock()


def _cached(key, build):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = build()
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _signals(dataset):
    def build():
        c = xsmom._closes(dataset)
        b = xsmom._book(c, "book")  # momentum (with the data-hygiene filter) and clean daily returns
        return c, b["mom"], b["r"]
    return _cached(("signals", dataset), build)


def _trades(dataset, k, lag):
    """The k + k book re-ranked every HOLD days, as trades (one per stock and side, while it stays in)."""
    def build():
        c, mom, r = _signals(dataset)
        idx = c.index
        n_ranked = mom.notna().sum(axis=1)
        start = int(np.argmax((n_ranked >= max(xsmr.MIN_STOCKS, 2 * k)).to_numpy()))
        rebal = list(range(start, len(idx), HOLD))
        growth = (1 + r).cumprod()  # clean returns: a >20% day earns nothing
        ends = xsmr.month_ends(idx).to_numpy()
        roll_count = np.cumsum(ends)
        open_pos, rows = {}, []
        for j, i in enumerate(rebal):
            m = mom.iloc[i].dropna()
            picks = {}
            if len(m) >= 2 * k:
                ranked = m.sort_values(kind="stable")
                picks.update({s: -1 for s in ranked.index[:k]})
                picks.update({s: 1 for s in ranked.index[-k:]})
            fill = min(i + lag, len(idx) - 1)
            for s, side in list(open_pos.items()):
                if picks.get(s) != side[0]:  # leaves the book (or flips side) at this fill
                    rows.append((s, side[0], side[1], fill, side[2]))
                    del open_pos[s]
            for s, side in picks.items():
                if s not in open_pos:
                    open_pos[s] = (side, fill, float(mom.iat[i, mom.columns.get_loc(s)]))
        out = []
        for s, side, e, x, signal in rows:
            if x <= e:
                continue
            col = c.columns.get_loc(s)
            g = growth.iloc[:, col].to_numpy()
            ret = side * (g[x] / g[e] - 1)
            rolls = int(roll_count[x - 1] - roll_count[e - 1]) if e > 0 else int(roll_count[x - 1])
            px = c.iloc[:, col].ffill().to_numpy()
            out.append({"symbol": s, "side": "long" if side > 0 else "short", "entry_day": idx[e], "exit_day": idx[x],
                        "days": x - e, "signal": signal, "entry": px[e], "exit": px[x], "ret": ret, "rolls": rolls,
                        "growth": g[x] / g[e], "col": col, "e": e, "x": x})
        t = pd.DataFrame(out)
        # Marked daily per unit of weight: each trade's daily move while held, and its trading (in, out,
        # rolls) on the day it happens, so the page can scale both by the position size.
        n = len(idx)
        ret_d, traded_d = np.zeros(n), np.zeros(n)
        rv = r.to_numpy()
        for tr in out:
            e, x, side, col = tr["e"], tr["x"], (1 if tr["side"] == "long" else -1), tr["col"]
            g = growth.iloc[:, col].to_numpy()
            value = g[e:x + 1] / g[e]  # position value relative to the entry
            ret_d[e + 1:x + 1] += side * value[:-1] * rv[e + 1:x + 1, col]
            traded_d[e] += 1.0
            traded_d[x] += value[-1]
            roll_days = np.flatnonzero(ends[e:x]) + e
            traded_d[roll_days] += 2 * value[roll_days - e]
        marked = pd.DataFrame({"ret": ret_d, "traded": traded_d}, index=idx)
        return t, idx[idx >= idx[start]], marked
    return _cached(("trades", dataset, k, lag), build)


def _sized(dataset, fill, max_open, pairs, slippage):
    cps = xsmr.cost_per_side(slippage)
    if not max_open:  # the stored book, one row a day
        f = xsmr._load("book" if fill == "close" else "next", dataset, slippage, model="xsmom")
        if f.empty:
            return f, pd.DatetimeIndex([]), None
        t = pd.DataFrame({"day": pd.to_datetime(f["day"]), "book_ret": f["gross_ret"], "book_cost": f["turnover"] * cps,
                          "long": f["long_ret"], "short": f["short_ret"], "stocks": f["stocks"]})
        t["book_net"] = t["book_ret"] - t["book_cost"]
        t["ret"], t["cost"], t["net"] = t["book_ret"], t["book_cost"], t["book_net"]
        return t, pd.DatetimeIndex(t["day"]), None
    k = max(1, min(int(pairs or 1), max_open // 2 or 1))
    t, days, marked = _trades(dataset, k, 1 if fill == "next" else 0)
    t = t.copy()
    if t.empty:
        return t, days, None
    t["w"] = 1.0 / max_open
    t["cost"] = (1 + t["growth"] + 2 * t["rolls"]) * cps
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    t["day"] = t["exit_day"]
    w = 1.0 / max_open
    daily = pd.DataFrame({"book_ret": w * marked["ret"], "book_cost": w * marked["traded"] * cps}, index=marked.index)
    return t, days, daily


def results(dataset="fno", fill="close", max_open=6, pairs=3, slippage=0.0002):
    t, days, daily = _sized(dataset, fill, max_open, pairs, slippage)
    extra = {}
    if len(t) and max_open:
        extra = {"avg_held_days": round(float(t["days"].mean()), 1),
                 "long_net_pct": round(float(100 * t.loc[t["side"] == "long", "book_net"].sum()), 3),
                 "short_net_pct": round(float(100 * t.loc[t["side"] == "short", "book_net"].sum()), 3)}
    elif len(t):
        extra = {"trades_label": "Days", "avg_stocks": round(float(t["stocks"].mean())),
                 "long_net_pct": round(float(100 * t["long"].sum()), 3), "short_net_pct": round(float(100 * t["short"].sum()), 3)}
    return v2common.build_results(t, days, slippage, extra, daily=daily)


def month_trades(month, dataset="fno", fill="close", max_open=6, pairs=3, slippage=0.0002):
    t, _, _ = _sized(dataset, fill, max_open, pairs, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month] if len(t) else t
    if not max_open:
        return [{"day": r.day.date().isoformat(), "stocks": int(r.stocks), "ret_pct": round(100 * float(r.book_ret), 3),
                 "book_cost_pct": round(100 * float(r.book_cost), 4), "book_net_pct": round(100 * float(r.book_net), 4),
                 "long_pct": round(100 * float(r.long), 3), "short_pct": round(100 * float(r.short), 3)} for r in t.itertuples()]
    return [{"entry_day": r.entry_day.date().isoformat(), "exit_day": r.exit_day.date().isoformat(), "days": int(r.days),
             "symbol": r.symbol, "side": r.side, "signal_pct": round(100 * float(r.signal), 1),
             "entry": round(float(r.entry), 2), "exit": round(float(r.exit), 2), "rolls": int(r.rolls),
             "weight_pct": round(100 * float(r.w), 3), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
