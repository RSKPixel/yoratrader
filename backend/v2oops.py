"""Larry Williams' "Oops" gap reversal (Long-Term Secrets to Short-Term Trading), long, on the F&O
stocks' near-month FUTURES (as the paper book trades them), 2015 on, for the v2 backtest page.

Prices: the signal is the future's own: its open below its own previous day's low, from the stored
continuous futures daily candles (eod, exchange 'NSE', the near month rolled at expiry), the same
numbers the paper book uses. Kite has no minute history for expired futures, so the moves inside the
day come from the share's 1-minute candles shifted to the future's level that day (x future open /
share open). The day after an expiry the continuous series' previous low is the old contract's, so
that day the previous low is the share's, shifted the same way. A future that expires that day is
sold at 15:15 even with the next-open exit (as the paper book does).

- A future opens below yesterday's low; it's bought in the first minute whose high trades back up to that
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
import os
import pickle
import tempfile
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
_cache, _lock = {}, threading.Lock()  # mode -> (at, fills, days)
# Modes: "futures" (the book: today's F&O list, the 1-minute replay) and "pit" (survivorship-free: every stock
# that had futures that day, dropped ones included, from NSE's daily F&O files; see _pit_fills).
MODES = ("futures", "pit")
_building = threading.Lock()


def _hm(minute):
    m = 9 * 60 + 15 + int(minute)
    return f"{m // 60:02d}:{m % 60:02d}"


def _expiries(days):
    """Each month's stock-futures expiry, as trading days: the last Thursday (the last Tuesday from
    September 2025, SEBI), moved to the trading day before when it's a holiday."""
    days = pd.DatetimeIndex(days)
    out = set()
    for p in sorted(set(days.to_period("M"))):
        last = p.to_timestamp(how="end").normalize()
        wd = 1 if last >= pd.Timestamp("2025-09-01") else 3
        while last.dayofweek != wd:
            last -= pd.Timedelta(days=1)
        if last > days[-1]:  # this month's expiry hasn't come yet (the data ends before it)
            continue
        i = days.searchsorted(last, side="right") - 1
        if i >= 0 and days[i].to_period("M") == p:
            out.add(days[i])
    return out


def _build():
    """Every Oops fill from the 1-minute candles: the first minute whose high reaches yesterday's low is
    the buy (at that low, or the minute's open if it opens above it). The stop is 0.1% under the lowest
    price known at the buy (earlier minutes' lows and the buy minute's open, never a low printed later);
    the buy minute itself counts if its low reaches the stop (the order inside a minute is unknown, so the
    worse case is taken). Out at 15:15: the close of the 15:14 minute."""
    with connect() as c:
        syms = pd.read_sql("SELECT symbol FROM bt_symbols WHERE dataset = 'fno' ORDER BY symbol", c)["symbol"].tolist()
    days = v2common.trading_days("fno", pd.Timestamp(START))
    expiry = _expiries(days)
    after_expiry = {days[i + 1] for i in range(len(days) - 1) if days[i] in expiry}
    fills = []
    for sym in syms:
        with connect() as c:
            d = pd.read_sql("SELECT day, low, close FROM bt_daily WHERE symbol = %s AND day >= '2014-01-01' ORDER BY day", c,
                            params=[sym], parse_dates=["day"]).set_index("day")
            fu = pd.read_sql("SELECT datetime AS day, open, low FROM eod WHERE exchange = 'NSE' AND symbol = %s AND datetime >= '2014-01-01' "
                             "ORDER BY datetime", c, params=[sym], parse_dates=["day"]).set_index("day")
            cur = c.cursor()
            cur.execute("SELECT day, minute, open, high, low, close FROM bt_1m WHERE symbol = %s AND day >= %s ORDER BY day", [sym, START])
            data = cur.fetchall()
        if len(d) < 250 or not data:
            continue
        if len(fu) < 2:
            continue
        prev_low = d["low"].shift(1)  # the share's (used the day after an expiry)
        fut_prev_low, fut_open = fu["low"].shift(1), fu["open"]
        up = d["close"].shift(1) > d["close"].shift(1).rolling(200, min_periods=180).mean()
        for day, mi, o, h, l, cl in data:
            ts = pd.Timestamp(day)
            if ts not in prev_low.index or not mi or mi[0] != 0:
                continue
            fo = fut_open.get(ts)
            if not (fo and fo > 0) or not (o[0] and o[0] > 0):
                continue
            k = fo / o[0]  # the share's minutes shifted to the future's level
            if abs(k - 1) > 0.05:  # a bad print or a mismatched contract
                continue
            pl = prev_low[ts] * k if ts in after_expiry else fut_prev_low.get(ts)
            if not (pl and pl > 0) or fo >= pl:  # the future must open below yesterday's low
                continue
            mi = np.asarray(mi)
            o, h, l, cl = (np.asarray(x, dtype=float) * k for x in (o, h, l, cl))
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
                          float(stop), float(exit_px), float(hit) if hit is not None else None, hit_at, low_after, ts in expiry))
    f = pd.DataFrame(fills, columns=["day", "fill_at", "symbol", "up", "prev_low", "open", "entry", "stop", "exit_time", "exit_stop", "stop_at",
                                     "low_after", "expiry"])
    return f, days


# The fills take ~100 s to build from the 1-minute candles, so they're also kept on disk: a restart or a
# deploy loads them in a second; the 16:00 top-up (invalidate) deletes the file so the next use rebuilds.
DISK = os.path.join(tempfile.gettempdir(), "yoratrader-oops-fills-v3.pkl")  # v3: futures prices


def _pit_fills(symbols=None):
    """Survivorship-free Oops on the futures' own daily prices (fut_daily_nse, futhistory.py: every stock
    future NSE listed, dropped stocks included), from START. Each day the near-month contract (the nearest
    expiry not yet passed); it opens below its own previous day's low and the day's high gets back to it:
    the buy-stop fills at that low. Out at the next day's open of the same contract, or at the close (in place
    of 15:15) on its expiry day. There are no minutes for dropped stocks, so the fill time is unknown: a day's
    fills are ranked by the smallest gap (the nearest to yesterday's low usually fills first), and the
    disaster stop can't be checked (the day's low may come before the buy). symbols: only these (a check
    of the method on today's list)."""
    with connect() as conn:
        f = pd.read_sql("SELECT symbol, day, expiry, open, high, low, close FROM fut_daily_nse WHERE day >= %s - 10",
                        conn, params=[pd.Timestamp(START).date()], parse_dates=["day", "expiry"])
    if symbols is not None:
        f = f[f["symbol"].isin(symbols)]
    f = f.sort_values(["symbol", "expiry", "day"])
    g = f.groupby(["symbol", "expiry"])
    f["prev_low"], f["prev_day"] = g["low"].shift(1), g["day"].shift(1)
    f["next_open"], f["next_day"] = g["open"].shift(-1), g["day"].shift(-1)
    near = f[f["expiry"] >= f["day"]].sort_values(["symbol", "day", "expiry"]).groupby(["symbol", "day"]).head(1)
    days = pd.DatetimeIndex(sorted(near["day"].unique()))
    prev_trading = pd.Series(days[:-1], index=days[1:])
    t = near[(near["day"] >= pd.Timestamp(START)) & near["prev_low"].notna()
             & (near["prev_day"] == prev_trading.reindex(near["day"]).to_numpy())]  # yesterday's low, not an older one
    t = t[(t["open"] < t["prev_low"]) & (t["high"] >= t["prev_low"])]
    t = t[(t["open"] >= t["low"] * 0.995) & (t["open"] <= t["high"] * 1.005)]  # bad prints
    t = t[(t["close"] / t["prev_low"] - 1).abs() <= 0.25]
    expiry = (t["expiry"] == t["day"]).to_numpy()
    gap = 100 * (t["open"] / t["prev_low"] - 1)
    out = pd.DataFrame({"day": t["day"].dt.date, "fill_at": gap.map(lambda x: f"g{-x:09.4f}").to_numpy(), "symbol": t["symbol"].to_numpy(),
                        "up": True, "prev_low": t["prev_low"].to_numpy(), "open": t["open"].to_numpy(), "entry": t["prev_low"].to_numpy(),
                        "stop": np.nan, "exit_time": t["close"].to_numpy(), "exit_stop": None, "stop_at": None, "low_after": np.nan,
                        "expiry": expiry, "next_open": t["next_open"].to_numpy(), "next_day": t["next_day"].to_numpy()})
    return out.reset_index(drop=True), days[days >= pd.Timestamp(START)]


def _load_disk():
    try:
        if time.time() - os.path.getmtime(DISK) < CACHE_SECONDS:
            with open(DISK, "rb") as fh:
                f, days = pickle.load(fh)
            if "expiry" in f.columns:
                return f, days
    except Exception:
        pass
    return None


def _fills(mode="futures"):
    def fresh():
        hit = _cache.get(mode)
        return hit if hit and time.time() - hit[0] < CACHE_SECONDS else None
    with _lock:
        hit = fresh()
    if hit:
        return hit[1], hit[2]
    with _building:  # one build at a time; a second caller waits for it
        with _lock:
            hit = fresh()
        if hit:
            return hit[1], hit[2]
        disk = _load_disk() if mode == "futures" else None
        if mode == "pit":
            f, days = _pit_fills()
            at = time.time()
        elif disk:
            f, days = disk
            at = os.path.getmtime(DISK)
        else:
            f, days = _build()
            at = time.time()
            try:
                tmp = DISK + ".tmp"
                with open(tmp, "wb") as fh:
                    pickle.dump((f, days), fh)
                os.replace(tmp, DISK)
            except Exception as error:
                print("Oops fills: could not save to disk:", error)
        with _lock:
            _cache[mode] = (at, f, days)
        return f, days


def invalidate():
    with _lock:
        _cache.clear()
    try:
        os.remove(DISK)
    except FileNotFoundError:
        pass


def warm():
    threading.Thread(target=_fills, daemon=True, name="oops-warm").start()


_next = {"at": 0, "data": None}


def _next_opens():
    """Each F&O future's next trading day's opening price, by (symbol, day): the book's exit (the near-month
    future; a position bought on an expiry day is sold at 15:15 instead, see _sized)."""
    if _next["data"] is not None and time.time() - _next["at"] < CACHE_SECONDS:
        return _next["data"]
    from db import connect
    with connect() as conn:
        d = pd.read_sql("SELECT symbol, datetime AS day, open FROM eod WHERE exchange = 'NSE' AND open > 0 AND datetime >= %s "
                        "ORDER BY symbol, datetime", conn, params=[START], parse_dates=["day"])
    d["next_open"] = d.groupby("symbol")["open"].shift(-1)
    d["next_day"] = d.groupby("symbol")["day"].shift(-1)
    out = d.dropna(subset=["next_open"]).set_index(["symbol", "day"])[["next_open", "next_day"]]
    _next.update(at=time.time(), data=out)
    return out


def _sized(stop="none", trend="any", max_open=3, slippage=0.0002, exit="1515", disaster="off", dataset="fno"):
    mode = "pit" if dataset == "fnopit" else "futures"
    if mode == "pit":  # no minutes for dropped stocks: neither stop can be checked
        stop, disaster = "none", "off"
    f, days = _fills(mode)
    t = f if trend == "any" else f[f["up"]]
    n = max_open or BOOK_OPEN
    t = t.sort_values(["day", "fill_at", "symbol"]).groupby("day").head(n).copy()
    stopped = t["exit_stop"].notna() if stop == "low" else pd.Series(False, index=t.index)
    t["exit"] = np.where(stopped, t["exit_stop"], t["exit_time"])
    t["reason"] = np.where(stopped, "stop", "15:15")
    t["exit_hm"] = np.where(stopped, t["stop_at"].fillna(""), EXIT_AT)
    t["exit_day"] = pd.to_datetime(t["day"])
    if exit == "nextopen":  # held overnight, sold at the next day's open (a stop still works on the buy day)
        nx = (f.set_index([f["symbol"], pd.to_datetime(f["day"])])[["next_open", "next_day"]].dropna(subset=["next_open"])
              if mode == "pit" else _next_opens())
        key = pd.MultiIndex.from_arrays([t["symbol"], pd.to_datetime(t["day"])])
        nxt = nx.reindex(key)
        same_day = t["expiry"].to_numpy(bool)  # the future expires today: sold at 15:15
        t = t[nxt["next_open"].notna().to_numpy() | stopped.to_numpy() | same_day].copy()
        nxt = nx.reindex(pd.MultiIndex.from_arrays([t["symbol"], pd.to_datetime(t["day"])]))
        stopped = t["exit_stop"].notna() if stop == "low" else pd.Series(False, index=t.index)
        today = stopped.to_numpy() | t["expiry"].to_numpy(bool)
        t["exit"] = np.where(stopped, t["exit_stop"], np.where(today, t["exit_time"], nxt["next_open"].to_numpy()))
        t["reason"] = np.where(stopped, "stop", np.where(today, "15:15 (expiry)", "next open"))
        t["exit_hm"] = np.where(stopped, t["stop_at"].fillna(""), np.where(today, EXIT_AT, "09:15"))
        t["exit_day"] = np.where(today, pd.to_datetime(t["day"]), nxt["next_day"].to_numpy())
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


def results(stop="none", trend="any", max_open=3, slippage=0.0002, exit="1515", disaster="off", dataset="fno"):
    t, days = _sized(stop, trend, max_open, slippage, exit, disaster, dataset)
    pit = dataset == "fnopit"
    extra = {}
    if len(t):
        extra = {"avg_positions": round(float(t.groupby("day").size().mean()), 1),
                 "stopped_pct": round(float(100 * (t["reason"] == "stop").mean()), 1),
                 "avg_gap_pct": round(float(t["gap_pct"].mean()), 2),
                 "median_fill_at": None if pit else sorted(t["fill_at"])[len(t) // 2],
                 "disaster_hits": int((t["reason"] == "disaster stop").sum())}
    return v2common.build_results(t, days, slippage, extra)


def month_trades(month, stop="none", trend="any", max_open=3, slippage=0.0002, exit="1515", disaster="off", dataset="fno"):
    t, _ = _sized(stop, trend, max_open, slippage, exit, disaster, dataset)
    pit = dataset == "fnopit"
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "entry_at": f"{r.day.date().isoformat()} {'at the low' if pit else r.fill_at}",
             "exit_at": f"{pd.Timestamp(r.exit_day).date().isoformat()} {'close' if pit and r.exit_hm == EXIT_AT else r.exit_hm}",
             "symbol": r.symbol, "fill_at": "—" if pit else r.fill_at, "gap_pct": round(float(r.gap_pct), 2),
             "prev_low": round(r.prev_low, 2), "open": round(r.open, 2), "entry": round(r.entry, 2),
             "stop": round(r.stop, 2) if stop == "low" else None, "exit": round(float(r.exit), 2), "reason": r.reason,
             "weight_pct": round(100 * float(r.w), 2), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.sort_values(["day", "fill_at"]).itertuples()]
