"""Quantitative momentum for the v2 page (Gray & Vogel; qmom.py has the model): long only, the
smoothest of the top 10% by 12-to-1-month momentum, rebalanced at the end of Feb / May / Aug / Nov.

- Max open N: the N picks (the book's order: lowest FIP first; "Momentum only": strongest), capital /
  N each at the rebalance; a slot with no pick stays in cash. The All-stocks benchmark has no max.
- As per model (max_open 0): the book's own picks, capital split equally.

Each stock in each rebalance period is one row: bought (or resized / kept) at a rebalance close and
held to the next. Its result is its day-by-day contribution (weights drift with prices), its cost
the charges + slippage on what was traded for it (the rebalance trade, the monthly futures rolls in
between, and the sale if it drops out). With the Nifty hedge, the short Nifty future is a row of its
own each period. A row counts on the rebalance that ends it; the period still open is left out.
"""

import threading
import time

import numpy as np
import pandas as pd

import qmom
import v2common
import xsmr

DATASETS = qmom.DATASETS + ("fnopit",)  # fnopit: survivorship-free (pit.py)
VERSIONS = ("book", "generic", "monthly", "universe")
MAX_OPEN = 10
CACHE_SECONDS = 1800
_cache, _lock = {}, threading.Lock()


def _rows(dataset, version, hedged, cap):
    key = (dataset, version, hedged, cap)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    c = qmom._closes_cached(dataset)
    member = None
    if dataset == "fnopit":
        import pit
        member = pit.member_mask(c.index, c.columns)
    b = qmom._book(c, version, cap if version != "universe" else None, member)
    idx, cols = c.index, list(c.columns)
    w, r, traded = b["w"].to_numpy(), b["r"].to_numpy(), b["traded"].to_numpy()
    contrib = np.vstack([np.zeros((1, len(cols))), w[:-1] * r[1:]])  # held into each day x that day's move
    rebal = [i for i, d in enumerate(idx) if d in b["rebal"]]
    px = c.ffill().to_numpy()
    mom, fip = b["mom"].to_numpy(), b["fip"].to_numpy()
    if hedged:
        _, nifty_r = qmom._nifty(idx)
        size = b["w"].sum(axis=1)
        hedge_ret = (-size.shift(1).fillna(0.0) * nifty_r).to_numpy()
        hedge_trade = ((size - size.shift(1).fillna(0.0)).abs() + qmom._hedge_roll(idx, size)).to_numpy()
    out = []
    for j in range(len(rebal) - 1):
        a, z = rebal[j], rebal[j + 1]
        held = np.flatnonzero(w[a] > 0)
        nxt = set(np.flatnonzero(w[z] > 0))
        for s in held:
            cost_share = traded[a, s] + traded[a + 1:z, s].sum() + (traded[z, s] if s not in nxt else 0.0)
            out.append({"symbol": cols[s], "entry_day": idx[a], "exit_day": idx[z], "w": w[a, s],
                        "book_ret": contrib[a + 1:z + 1, s].sum(), "traded": cost_share,
                        "entry": px[a, s], "exit": px[z, s], "kept": s in nxt,
                        "mom": mom[a, s], "fip": fip[a, s], "hedge": False})
        if hedged and len(held):
            out.append({"symbol": "NIFTY 50 (hedge)", "entry_day": idx[a], "exit_day": idx[z], "w": float(size.iloc[a]),
                        "book_ret": hedge_ret[a + 1:z + 1].sum(), "traded": hedge_trade[a:z].sum(),
                        "entry": np.nan, "exit": np.nan, "kept": True, "mom": np.nan, "fip": np.nan, "hedge": True})
    t = pd.DataFrame(out)
    days = idx[idx >= idx[rebal[0]]] if rebal else idx[:0]
    # The book marked to market every day: holdings' moves when they happen, trades on their day.
    marked = pd.DataFrame({"ret": contrib.sum(axis=1), "traded": traded.sum(axis=1)}, index=idx)
    if hedged:
        marked["ret"] += hedge_ret
        marked["traded"] += hedge_trade
    if rebal:  # up to the last rebalance: the period still open is left out, as in the rows
        marked = marked[(marked.index >= idx[rebal[0]]) & (marked.index <= idx[rebal[-1]])]
    value = (t, pd.DatetimeIndex(days), marked)
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _sized(dataset, version, hedge, max_open, slippage):
    t, days, marked = _rows(dataset, version, hedge == "nifty", max_open or None)
    t = t.copy()
    if t.empty:
        return t, days, None
    cps = xsmr.cost_per_side(slippage)
    daily = pd.DataFrame({"book_ret": marked["ret"], "book_cost": marked["traded"] * cps})
    t["book_cost"] = t["traded"] * cps
    t["book_net"] = t["book_ret"] - t["book_cost"]
    size = t["w"].where(t["w"] > 0, 1.0)
    t["ret"], t["cost"] = t["book_ret"] / size, t["book_cost"] / size
    t["net"] = t["ret"] - t["cost"]
    t["side"] = np.where(t["hedge"], "short", "long")
    t["day"] = t["exit_day"]
    return t, days, daily


def results(dataset="fno", version="book", hedge="none", max_open=5, slippage=0.0002):
    t, days, daily = _sized(dataset, version, hedge, max_open, slippage)
    extra = {}
    if len(t):
        stocks = t[~t["hedge"]]
        extra = {"trades_label": "Holdings", "avg_held": round(float(stocks.groupby("entry_day").size().mean()), 1),
                 "kept_pct": round(float(100 * stocks["kept"].mean()), 1),
                 "hedge_net_pct": round(float(100 * t.loc[t["hedge"], "book_net"].sum()), 3) if hedge == "nifty" else None}
    return v2common.build_results(t, days, slippage, extra, daily=daily)


def month_trades(month, dataset="fno", version="book", hedge="none", max_open=5, slippage=0.0002):
    t, _, _ = _sized(dataset, version, hedge, max_open, slippage)
    t = t[t["day"].dt.strftime("%Y-%m") == month] if len(t) else t

    def num(v, d=2):
        return round(float(v), d) if pd.notna(v) else None

    return [{"entry_day": r.entry_day.date().isoformat(), "exit_day": r.exit_day.date().isoformat(),
             "entry_at": f"{r.entry_day.date().isoformat()} {v2common.CLOSE}", "exit_at": f"{r.exit_day.date().isoformat()} {v2common.CLOSE}", "symbol": r.symbol,
             "side": r.side, "hedge": bool(r.hedge), "kept": bool(r.kept), "mom_pct": num(100 * r.mom if pd.notna(r.mom) else None, 1),
             "fip": num(r.fip, 3), "entry": num(r.entry), "exit": num(r.exit), "weight_pct": round(100 * float(r.w), 3),
             "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3), "net_pct": round(100 * float(r.net), 3),
             "book_net_pct": round(100 * float(r.book_net), 4), "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
