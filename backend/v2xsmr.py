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

# fnopit: survivorship-free (each month's F&O list, every stock since dropped included), from NSE's daily
# files 2007 on (pit.py). There are no 15-minute candles for dropped stocks, so this version is daily: the
# signal and the entry at the official open (the 09:15 auction price, as in the book), out at the official
# close (a 30-minute average, in place of 15:15); the shares (spot) only. From 2015, as the 15-minute version:
# before NSE's pre-open auction (Oct 2010) the open was just the first trade, and the old files' opens are
# often stale or stray (2007-2013 showed hundreds of % a year, impossible), so they aren't used.
PIT_FROM = pd.Timestamp("2015-01-01")
DATASETS = (*xsmr.DATASETS, "fnopit")
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


INSTRUMENTS = ("futures", "spot")
# Spot: the share itself, bought and shorted intraday (MIS: a cash short can't be carried overnight, so the
# same-day 15:15 exit only). Zerodha's intraday equity charges (checked 2026-11-21): brokerage 0.03% (or
# ₹20, whichever is lower; at these position sizes 0.03%), STT 0.025% on sells, NSE transaction 0.00297%,
# SEBI ₹10/crore, stamp 0.003% on buys, GST 18% on brokerage + exchange + SEBI.
SPOT_BROKERAGE, SPOT_STT_SELL, SPOT_EXCHANGE, SPOT_SEBI, SPOT_STAMP_BUY, SPOT_GST = 0.0003, 0.00025, 0.0000297, 0.000001, 0.00003, 0.18


def spot_cost_per_side(slippage=0.0002):
    """Cost of trading one rupee of shares intraday once, averaged over buys and sells."""
    return (SPOT_BROKERAGE + SPOT_EXCHANGE + SPOT_SEBI) * (1 + SPOT_GST) + (SPOT_STT_SELL + SPOT_STAMP_BUY) / 2 + slippage


def on_futures(dataset, version, instrument="futures"):
    """The F&O stocks' intraday book trades the near-month future: its signal, fill and exit are the
    future's (futsig), unless Spot is chosen (the share's own prices). The daily version (not paper traded)
    stays on the share's 15:15 prices."""
    return dataset == "fno" and version == "intraday" and instrument == "futures"


def _pit_prices():
    """The survivorship-free daily prices in _prices' shape: open = the 09:15 entry, close = the exit; a stock
    has no signal (so isn't picked) on a day it wasn't in the previous month-end's F&O list."""
    import pit

    def build():
        f = pit.frame()
        piv = {c: f.pivot(index="day", columns="symbol", values=c).sort_index() for c in ("open", "high", "low", "close")}
        idx, cols = piv["close"].index, piv["close"].columns
        member = pit.member_mask(idx, cols)
        op = piv["open"].where((piv["open"] >= piv["low"] * 0.995) & (piv["open"] <= piv["high"] * 1.005))  # bad prints
        nan = pd.DataFrame(np.nan, index=idx, columns=cols)
        sigma = (piv["close"] / piv["close"].shift(1) - 1).rolling(90).std().shift(1)
        op = op.where(member)
        op.loc[op.index < PIT_FROM] = np.nan  # no signal (no trades) before PIT_FROM
        return {"open915": op, "open916": nan, "open930": nan, "open945": nan, "px1515": piv["close"],
                "day_close": piv["close"], "low1515": piv["low"], "high1515": piv["high"], "day_low": piv["low"],
                "day_high": piv["high"], "sigma": sigma}
    return _cached(("prices", "fnopit"), build)


def _pit_hits(t, pct):
    """The disaster stop on the survivorship-free daily lows / highs: (hit mask, exit level)."""
    p = _pit_prices()
    key = pd.MultiIndex.from_arrays([pd.to_datetime(t["day"]), t["symbol"]])  # stack(): (day, symbol)
    low = p["day_low"].stack().reindex(key).to_numpy()
    high = p["day_high"].stack().reindex(key).to_numpy()
    long = (t["side"] == "long").to_numpy()
    entry = t["entry"].to_numpy(float)
    level = np.where(long, entry * (1 - pct / 100), entry * (1 + pct / 100))
    hit = np.where(long, low <= level, high >= level)
    return np.nan_to_num(hit, nan=0).astype(bool), level


def futures_prices(dataset, version, instrument="futures"):
    if dataset == "fnopit":
        return _pit_prices()
    if on_futures(dataset, version, instrument):
        import futsig
        return futsig.prices(dataset)
    return _cached(("prices", dataset), lambda: xsmr._prices(dataset))


EXITS = ("1515", "nextopen")


def _next_open_exit(p, b):
    """Held overnight: out at the next trading day's open. The overnight move is the next day's open against its own
    previous close (for the futures, the new contract's after an expiry), applied to today's close, so a switch of
    contract overnight isn't counted as a move."""
    prev = p["prev_close"] if "prev_close" in p else p["day_close"].shift(1)
    exit_ = p["day_close"] * (p["open915"].shift(-1) / prev.shift(-1))
    pos = exit_ / b["entry"] - 1
    pos = pos.where(pos.abs() <= xsmr.MAX_MOVE)
    # a position whose next open isn't known yet (the latest day) or has no price isn't a trade yet
    return {**b, "exit": exit_, "pos": pos, "w": b["w"].where(pos.notna(), 0.0)}


def _rows(dataset, version, entry, stop, top, exit="1515", instrument="futures"):
    """One row per stock and day held: weight, the position's return, and the share of capital traded."""
    def build():
        p = futures_prices(dataset, version, instrument)
        b = xsmr._book(p, _variant(version, entry, stop), top=top)
        if exit == "nextopen" and version == "intraday":
            b = _next_open_exit(p, b)
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
    return _cached(("rows", dataset, version, entry, stop, top, exit, on_futures(dataset, version, instrument)), build)


def _sized(dataset, version, entry, stop, max_open, pairs, slippage, disaster="off", exit="1515", instrument="futures"):
    k = per_side(max_open, pairs)
    t, days = _rows(dataset, version, entry, stop, k, exit, instrument)
    t = t.copy()
    if k:  # the stored book is fully invested (0.5 / k a position): scale to capital / max_open each
        scale = 2 * k / max(max_open, 2 * k)
        for col in ("w", "ret_w", "traded"):
            t[col] = t[col] * scale
    cps = spot_cost_per_side(slippage) if instrument == "spot" else xsmr.cost_per_side(slippage)
    size = t["w"].abs()
    t["side"] = np.where(t["w"] > 0, "long", "short")
    t["disaster"] = False
    if disaster == "on" and version == "intraday" and len(t):  # the 10% disaster stop (disaster.py)
        import disaster as ds
        if on_futures(dataset, version, instrument):
            import futsig
            hit, level = futsig.frame_hits(t, ds.PCT)
        elif dataset == "fnopit":
            hit, level = _pit_hits(t, ds.PCT)
        else:
            hit, level = ds.frame_hits(t)
        t.loc[hit, "exit"] = level[hit]
        t.loc[hit, "ret_w"] = -size[hit] * ds.PCT / 100
        t.loc[hit, "stopped"] = True
        t.loc[hit, "disaster"] = True
    t["book_ret"] = t["ret_w"]
    t["book_cost"] = t["traded"] * cps
    t["book_net"] = t["book_ret"] - t["book_cost"]
    t["ret"], t["cost"] = t["book_ret"] / size, t["book_cost"] / size
    t["net"] = t["ret"] - t["cost"]
    t["day"] = pd.to_datetime(t["day"])
    return t, days


def results(dataset="fno", version="intraday", entry="0915", stop="none", max_open=6, pairs=3, slippage=0.0002, disaster="off", exit="1515",
            instrument="futures"):
    t, days = _sized(dataset, version, entry, stop, max_open, pairs, slippage, disaster, exit, instrument)
    extra = {}
    if len(t):
        g = t.groupby("day")
        extra = {"avg_positions": round(float(g.size().mean()), 1),
                 "long_net_pct": round(float(100 * t.loc[t["side"] == "long", "book_net"].sum()), 3),
                 "short_net_pct": round(float(100 * t.loc[t["side"] == "short", "book_net"].sum()), 3),
                 "per_side": per_side(max_open, pairs),
                 "stopped_pct": round(float(100 * t["stopped"].astype(bool).mean()), 1)}
    if disaster == "on" and len(t):
        import disaster as ds
        extra.update(disaster_pct=ds.PCT, disaster_hits=int(t["disaster"].sum()))
    out = v2common.build_results(t, days, slippage, extra, cps=spot_cost_per_side(slippage) if instrument == "spot" else None)
    if out.get("summary"):  # "trades" here are stock-days; the book trades every day it's live
        out["summary"]["trades_label"] = "Positions"
        out["summary"]["priced_on"] = "futures" if on_futures(dataset, version, instrument) else "share"
        out["summary"]["instrument"] = "spot" if instrument == "spot" else "futures"
    return out


def month_trades(month, dataset="fno", version="intraday", entry="0915", stop="none", max_open=6, pairs=3, slippage=0.0002, disaster="off",
                 exit="1515", instrument="futures"):
    t, days = _sized(dataset, version, entry, stop, max_open, pairs, slippage, disaster, exit, instrument)
    next_day = dict(zip(days[:-1], days[1:]))  # next-open exit: sold the next trading day
    prev_day = dict(zip(days[1:], days[:-1]))  # daily version: bought at the previous day's 15:15

    def at(r):
        d = r.day.date().isoformat()
        if version == "daily":
            p = prev_day.get(r.day)
            return f"{p.date().isoformat() if p is not None else d} 15:15", f"{d} 15:15"
        if exit == "nextopen" and not r.stopped:
            n = next_day.get(r.day)
            return f"{d} {entry[:2]}:{entry[2:]}", f"{n.date().isoformat() if n is not None else d} 09:15 (open)"
        return f"{d} {entry[:2]}:{entry[2:]}", f"{d} {v2common.STOP_INTRADAY if r.stopped else 'close' if dataset == 'fnopit' else '15:15'}"
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
