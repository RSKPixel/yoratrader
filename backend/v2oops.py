"""Larry Williams' "Oops" gap reversal (Long-Term Secrets to Short-Term Trading), long, on 1-minute
candles (today's F&O stocks, 2015 on), for the v2 backtest page and the paper book's reference.

- A stock opens below yesterday's low; it's bought in the first minute whose high trades back up to that
  low (at the level, or at the minute's open if it opens above it), as a resting buy-stop order would fill.
- Out at 15:15: the close of the 15:14 minute (NSE's closing auction from 3 Aug 2026 starts at 15:15).
- Stop (optional, off by default): 0.1% under the lowest price known at the buy. Most buys come in the
  first minute, when that is just the open, so the stop is tight and noise takes it out: about 4% a year
  with it against about 24% without (2015-2026). The old 15-minute build put it under the whole first
  candle's low, a low not yet known at the buy, which flattered it (28.7%).
- Trend (optional): only stocks whose close was above their 200-day average yesterday.
- Max open N: the day's first N fills (by fill minute, then symbol), capital / N each; as per model: 3.

Costs: NSE futures charges + slippage on the buy and the sale. Built once from the stored candles (a
minute or two) and cached; warmed at startup.
"""

import threading
import time

import numpy as np
import pandas as pd

import v2common
import xsmr
from db import connect

START = "2015-03-01"
EXIT_AT = "15:15"
EXIT_MIN = 6 * 60  # minutes since 09:15: 15:15 (the 15:14 minute is the last one before it)
STOP_BELOW = 0.999
EXITS = ("1515", "nextopen")  # out at 15:15 the same day, or at the next trading day's open (the book: "out on the opening tomorrow")
MAX_OPEN, BOOK_OPEN = 10, 3
CACHE_SECONDS = 6 * 3600
_cache, _lock = {"at": 0, "fills": None, "days": None}, threading.Lock()
_building = threading.Lock()


def _hm(minute):
    m = 9 * 60 + 15 + int(minute)
    return f"{m // 60:02d}:{m % 60:02d}"


def _build():
    """Every Oops fill from the 1-minute candles: the first minute whose high reaches yesterday's low is
    the buy (at that low, or the minute's open if it opens above it). The stop is 0.1% under the lowest
    price known at the buy (earlier minutes' lows and the buy minute's open, never a low printed later);
    the buy minute itself counts if its low reaches the stop (the order inside a minute is unknown, so the
    worse case is taken). Out at 15:15: the close of the 15:14 minute."""
    with connect() as c:
        syms = pd.read_sql("SELECT symbol FROM bt_symbols WHERE dataset = 'fno' ORDER BY symbol", c)["symbol"].tolist()
    fills = []
    for sym in syms:
        with connect() as c:
            d = pd.read_sql("SELECT day, low, close FROM bt_daily WHERE symbol = %s AND day >= '2014-01-01' ORDER BY day", c,
                            params=[sym], parse_dates=["day"]).set_index("day")
            cur = c.cursor()
            cur.execute("SELECT day, minute, open, high, low, close FROM bt_1m WHERE symbol = %s AND day >= %s ORDER BY day", [sym, START])
            data = cur.fetchall()
        if len(d) < 250 or not data:
            continue
        prev_low = d["low"].shift(1)
        up = d["close"].shift(1) > d["close"].shift(1).rolling(200, min_periods=180).mean()
        for day, mi, o, h, l, cl in data:
            ts = pd.Timestamp(day)
            if ts not in prev_low.index or not mi or mi[0] != 0:
                continue
            pl = prev_low[ts]
            if not (pl > 0) or not (o[0] > 0) or o[0] >= pl:  # must open below yesterday's low
                continue
            mi, o, h, l, cl = map(np.asarray, (mi, o, h, l, cl))
            before_exit = np.nonzero(mi < EXIT_MIN)[0]
            if not len(before_exit):
                continue
            last = before_exit[-1]
            k = np.nonzero(h[: last + 1] >= pl)[0]
            if not len(k):
                continue
            j = k[0]
            entry = max(o[j], pl)
            known_low = min(l[:j].min(), o[j]) if j else o[j]
            stop = known_low * STOP_BELOW
            exit_px = cl[last]
            if not (exit_px > 0) or abs(exit_px / entry - 1) > 0.25:  # a bad print
                continue
            low_after = float(l[j + 1: last + 1].min()) if last > j else float("nan")  # the lowest price after the buy minute
            hits = np.nonzero(l[j: last + 1] <= stop)[0]
            if len(hits):
                i = j + hits[0]
                hit, hit_at = (stop if i == j else min(o[i], stop)), _hm(mi[i])
            else:
                hit, hit_at = None, None
            fills.append((day, _hm(mi[j]), sym, bool(up.get(ts, False)), float(pl), float(o[0]), float(entry),
                          float(stop), float(exit_px), float(hit) if hit is not None else None, hit_at, low_after))
    f = pd.DataFrame(fills, columns=["day", "fill_at", "symbol", "up", "prev_low", "open", "entry", "stop", "exit_time", "exit_stop", "stop_at",
                                     "low_after"])
    days = v2common.trading_days("fno", pd.Timestamp(START))
    return f, days


def _fills():
    with _lock:
        if _cache["fills"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
            return _cache["fills"], _cache["days"]
    with _building:  # one build at a time; a second caller waits for it
        with _lock:
            if _cache["fills"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
                return _cache["fills"], _cache["days"]
        f, days = _build()
        with _lock:
            _cache.update(at=time.time(), fills=f, days=days)
        return f, days


def invalidate():
    with _lock:
        _cache.update(at=0)


def warm():
    threading.Thread(target=_fills, daemon=True, name="oops-warm").start()


_next = {"at": 0, "data": None}


def _next_opens():
    """Each F&O stock's next trading day's opening price, by (symbol, day): the book's exit."""
    if _next["data"] is not None and time.time() - _next["at"] < CACHE_SECONDS:
        return _next["data"]
    from db import connect
    with connect() as conn:
        d = pd.read_sql("SELECT symbol, day, open FROM bt_daily WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = 'fno') "
                        "AND close > 0 AND day >= %s ORDER BY symbol, day", conn, params=[START], parse_dates=["day"])
    d["next_open"] = d.groupby("symbol")["open"].shift(-1)
    d["next_day"] = d.groupby("symbol")["day"].shift(-1)
    out = d.dropna(subset=["next_open"]).set_index(["symbol", "day"])[["next_open", "next_day"]]
    _next.update(at=time.time(), data=out)
    return out


def _sized(stop="none", trend="any", max_open=3, slippage=0.0002, exit="1515", disaster="off"):
    f, days = _fills()
    t = f if trend == "any" else f[f["up"]]
    n = max_open or BOOK_OPEN
    t = t.sort_values(["day", "fill_at", "symbol"]).groupby("day").head(n).copy()
    stopped = t["exit_stop"].notna() if stop == "low" else pd.Series(False, index=t.index)
    t["exit"] = np.where(stopped, t["exit_stop"], t["exit_time"])
    t["reason"] = np.where(stopped, "stop", "15:15")
    t["exit_hm"] = np.where(stopped, t["stop_at"].fillna(""), EXIT_AT)
    t["exit_day"] = pd.to_datetime(t["day"])
    if exit == "nextopen":  # held overnight, sold at the next day's open (a stop still works on the buy day)
        nx = _next_opens()
        key = pd.MultiIndex.from_arrays([t["symbol"], pd.to_datetime(t["day"])])
        nxt = nx.reindex(key)
        t = t[nxt["next_open"].notna().to_numpy() | stopped.to_numpy()].copy()
        nxt = nx.reindex(pd.MultiIndex.from_arrays([t["symbol"], pd.to_datetime(t["day"])]))
        stopped = t["exit_stop"].notna() if stop == "low" else pd.Series(False, index=t.index)
        t["exit"] = np.where(stopped, t["exit_stop"], nxt["next_open"].to_numpy())
        t["reason"] = np.where(stopped, "stop", "next open")
        t["exit_hm"] = np.where(stopped, t["stop_at"].fillna(""), "09:15")
        t["exit_day"] = np.where(stopped, pd.to_datetime(t["day"]), nxt["next_day"].to_numpy())
    if disaster == "on":  # the 10% disaster stop (disaster.py): out at the level if, after the buy, the day traded through it
        import disaster as ds
        level = t["entry"] * (1 - ds.PCT / 100)
        hit = (t["low_after"] <= level).fillna(False).to_numpy()
        t.loc[hit, "exit"] = level[hit]
        t.loc[hit, "reason"] = "disaster stop"
        t.loc[hit, "exit_hm"] = ""
        t.loc[hit, "exit_day"] = pd.to_datetime(t.loc[hit, "day"])
    t["gap_pct"] = 100 * (t["open"] / t["prev_low"] - 1)
    t["ret"] = t["exit"] / t["entry"] - 1
    t["w"] = 1.0 / n
    t["cost"] = (1 + t["exit"] / t["entry"]) * xsmr.cost_per_side(slippage)
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    t["day"] = pd.to_datetime(t["day"])
    return t.reset_index(drop=True), days


def results(stop="none", trend="any", max_open=3, slippage=0.0002, exit="1515", disaster="off"):
    t, days = _sized(stop, trend, max_open, slippage, exit, disaster)
    extra = {}
    if len(t):
        extra = {"avg_positions": round(float(t.groupby("day").size().mean()), 1),
                 "stopped_pct": round(float(100 * (t["reason"] == "stop").mean()), 1),
                 "avg_gap_pct": round(float(t["gap_pct"].mean()), 2),
                 "median_fill_at": sorted(t["fill_at"])[len(t) // 2],
                 "disaster_hits": int((t["reason"] == "disaster stop").sum())}
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, stop="none", trend="any", max_open=3, slippage=0.0002, exit="1515", disaster="off"):
    t, _ = _sized(stop, trend, max_open, slippage, exit, disaster)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "entry_at": f"{r.day.date().isoformat()} {r.fill_at}",
             "exit_at": f"{pd.Timestamp(r.exit_day).date().isoformat()} {r.exit_hm}",
             "symbol": r.symbol, "fill_at": r.fill_at, "gap_pct": round(float(r.gap_pct), 2),
             "prev_low": round(r.prev_low, 2), "open": round(r.open, 2), "entry": round(r.entry, 2),
             "stop": round(r.stop, 2) if stop == "low" else None, "exit": round(float(r.exit), 2), "reason": r.reason,
             "weight_pct": round(100 * float(r.w), 2), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.sort_values(["day", "fill_at"]).itertuples()]
