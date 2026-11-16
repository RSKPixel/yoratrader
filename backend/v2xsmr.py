"""Cross-sectional mean reversion for the v2 page (Chan ch. 4; xsmr.py has the model): each day long
the stocks that lagged the cross-section at the open and short the ones that led, sized to the page's
common parameters. Capital is the gross exposure: half long, half short.

- Pairs k (k + k) within Max open N (2k <= N): the k furthest below the day's average move are bought
  and the k furthest above shorted. Each position is capital / N, as on every v2 page (slots not
  used stay in cash), so 3 + 3 at max open 10 puts 60% of capital to work.
- As per model (max_open 0): the book, linear weights on every priced stock, fully invested.

Versions as on the classic page: intraday (in at the entry, out at 15:15; entry 09:15 is the book,
09:16 / 09:30 / 09:45 enter later; 09:15 can take Buy on gap's 1σ stop) or daily (15:15 to the next
15:15, rebalanced daily, with the monthly futures roll on what's kept through a month end). Every
row is one stock on one day; its cost is charges + slippage on what was traded for it.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmr

DATASETS = xsmr.DATASETS
ENTRIES = ("0915", "0916", "0930", "0945")
MAX_OPEN = 10
CACHE_SECONDS = 1800
_cache, _lock, _building = {}, threading.Lock(), {}


def _cached(key, build):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
        gate = _building.setdefault(key, threading.Lock())
    with gate:  # one build per key; concurrent requests wait for it
        with _lock:
            hit = _cache.get(key)
            if hit and time.time() - hit[0] < CACHE_SECONDS:
                return hit[1]
        value = build()
        with _lock:
            _cache[key] = (time.time(), value)
            books = sorted((t, k) for k, (t, _) in _cache.items() if k[0] == "rows")
            for _, k in books[: max(0, len(books) - 40)]:
                _cache.pop(k, None)
        return value


def per_side(max_open, pairs):
    """Stocks per side: the chosen k (at most max_open // 2), or None for the book (every stock)."""
    if not max_open:
        return None
    return max(1, min(int(pairs or 1), max_open // 2 or 1))


def _variant(version, entry, stop):
    if version == "daily":
        return "daily"
    return f"intraday-{entry}" + ("-1sd" if stop == "1sd" and entry == "0915" else "")


def _rows(dataset, version, entry, stop, top):
    """One row per stock and day held: weight, the position's return, and the share of capital traded."""
    def build():
        p = _cached(("prices", dataset), lambda: xsmr._prices(dataset))
        b = xsmr._book(p, _variant(version, entry, stop), top=top)
        live = b["n"] >= xsmr.MIN_STOCKS
        w = b["w"].mul(live.astype(float), axis=0)
        if version == "daily":
            prev = w.shift(1).fillna(0.0)
            ends = xsmr.month_ends(w.index).astype(float)
            kept = np.minimum(prev.abs(), w.abs()).where(np.sign(prev) == np.sign(w), 0.0)
            traded = (w - prev).abs() + 2 * kept.mul(ends, axis=0)
        else:
            traded = 2 * w.abs()
        held = w != 0
        frame = pd.DataFrame({
            "w": w.where(held).stack(), "ret_w": (w * b["pos"].fillna(0.0)).where(held).stack(),
            "traded": traded.where(held).stack(), "sig": b["sig"].where(held).stack(),
            "entry": b["entry"].where(held).stack(), "exit": b["exit"].where(held).stack(),
            "stopped": b["stopped"].where(held).stack(),
        }).reset_index()
        frame.columns = ["day", "symbol", *frame.columns[2:]]
        frame = frame[frame["w"].notna() & (frame["w"] != 0)].reset_index(drop=True)  # held positions only
        days = w.index[live.to_numpy()]
        return frame, pd.DatetimeIndex(days)
    return _cached(("rows", dataset, version, entry, stop, top), build)


def _sized(dataset, version, entry, stop, max_open, pairs, slippage):
    k = per_side(max_open, pairs)
    t, days = _rows(dataset, version, entry, stop, k)
    t = t.copy()
    if k:  # the stored book is fully invested (0.5 / k a position): scale to capital / max_open each
        scale = 2 * k / max(max_open, 2 * k)
        for col in ("w", "ret_w", "traded"):
            t[col] = t[col] * scale
    cps = xsmr.cost_per_side(slippage)
    size = t["w"].abs()
    t["side"] = np.where(t["w"] > 0, "long", "short")
    t["book_ret"] = t["ret_w"]
    t["book_cost"] = t["traded"] * cps
    t["book_net"] = t["book_ret"] - t["book_cost"]
    t["ret"], t["cost"] = t["book_ret"] / size, t["book_cost"] / size
    t["net"] = t["ret"] - t["cost"]
    t["day"] = pd.to_datetime(t["day"])
    return t, days


def results(dataset="fno", version="intraday", entry="0915", stop="none", max_open=6, pairs=3, slippage=0.0002):
    t, days = _sized(dataset, version, entry, stop, max_open, pairs, slippage)
    extra = {}
    if len(t):
        g = t.groupby("day")
        extra = {"avg_positions": round(float(g.size().mean()), 1),
                 "long_net_pct": round(float(100 * t.loc[t["side"] == "long", "book_net"].sum()), 3),
                 "short_net_pct": round(float(100 * t.loc[t["side"] == "short", "book_net"].sum()), 3),
                 "per_side": per_side(max_open, pairs),
                 "stopped_pct": round(float(100 * t["stopped"].astype(bool).mean()), 1)}
    out = v2common.build_results(t, days, slippage, extra)
    if out.get("summary"):  # "trades" here are stock-days; the book trades every day it's live
        out["summary"]["trades_label"] = "Positions"
    return out


def month_trades(month, dataset="fno", version="intraday", entry="0915", stop="none", max_open=6, pairs=3, slippage=0.0002):
    t, days = _sized(dataset, version, entry, stop, max_open, pairs, slippage)
    prev_day = dict(zip(days[1:], days[:-1]))  # daily version: bought at the previous day's 15:15

    def at(r):
        d = r.day.date().isoformat()
        if version == "daily":
            p = prev_day.get(r.day)
            return f"{p.date().isoformat() if p is not None else d} 15:15", f"{d} 15:15"
        return f"{d} {entry[:2]}:{entry[2:]}", f"{d} {v2common.STOP_INTRADAY if r.stopped else '15:15'}"
    t = t[t["day"].dt.strftime("%Y-%m") == month].sort_values(["day", "book_net"], ascending=[True, False])
    return [{"day": r.day.date().isoformat(), "entry_at": at(r)[0], "exit_at": at(r)[1],
             "symbol": r.symbol, "side": r.side, "signal_pct": round(100 * float(r.sig), 2),
             "entry": round(float(r.entry), 2), "exit": round(float(r.exit), 2), "stopped": bool(r.stopped),
             "weight_pct": round(100 * abs(float(r.w)), 3), "ret_pct": round(100 * float(r.ret), 3),
             "cost_pct": round(100 * float(r.cost), 3), "net_pct": round(100 * float(r.net), 3),
             "book_net_pct": round(100 * float(r.book_net), 4), "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]


def warm():
    """Load the F&O prices (~40 s) and the default book in the background, so the first visit is quick."""
    def go():
        try:
            results("fno", "intraday", "0915", "none", 6, 3)
        except Exception as error:
            print("v2 xsmr warm-up failed:", error)
    threading.Thread(target=go, daemon=True, name="v2xsmr-warm").start()
