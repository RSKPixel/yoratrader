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

DATASETS = ("fno", "stocks", "indices", "fnopit")  # fnopit: survivorship-free futures (Buy/Sell on gap only, _pit_trades)
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


def on_futures(dataset, model="gap"):
    """Buy/Sell on gap on the F&O stocks trades the near-month future: signal, fill and exit at the future's level (futsig)."""
    return model == "gap" and dataset == "fno"


ENTRIES = ("0915", "0916")  # the open (the book), or a minute later: the 09:16 minute's open (1-minute candles, from 2015)


def _fut_trades(side, stop, entry="0915"):
    """Chan's buy-on-gap on the futures (futsig prices): a long when the future opens below its previous low
    by more than 1σ (its own 90-day σ) and above its 20-day average; a short, the mirror image (side "both").
    In at the open, out at 15:15 (the future's late-day level), or at the 1σ stop if the day's range to
    15:15 reached it. Each day's qualifying stocks ranked by gap size (the top 10 kept, as the book)."""
    key = ("fut", side, stop, entry)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    import futsig
    p = futsig.prices("fno")
    o, sd, ma = p["open915"], p["sigma"], p["ma20"]
    ok = o.notna() & p["px1515"].notna() & sd.notna() & (sd > 0) & ma.notna()
    down = 1 - o / p["prev_low"]   # > 0: opened below the previous low
    up = o / p["prev_high"] - 1    # > 0: opened above the previous high
    frames = []
    for s_, gap, filt in (("long", down, o > ma), ("short", up, o < ma)):
        if s_ == "short" and side == "long":
            continue
        q = ok & filt & (gap > backtest_threshold() * sd)
        g = gap.where(q).stack().dropna()  # this pandas keeps NaN when stacking
        if g.empty:
            continue
        f = g.rename("gap").reset_index()
        f.columns = ["day", "symbol", "gap"]
        f["side"] = s_
        frames.append(f)
    t = pd.concat(frames, ignore_index=True)
    ix = pd.MultiIndex.from_arrays([t["day"], t["symbol"]])
    look = lambda name: p[name].stack().reindex(ix).to_numpy(float)
    t["entry"], t["exit"], sig = look("open916" if entry == "0916" else "open915"), look("px1515"), look("sigma")
    t = t[np.isfinite(t["entry"]) & (t["entry"] > 0)]  # 09:16: a stock without that minute isn't traded
    ix = pd.MultiIndex.from_arrays([t["day"], t["symbol"]])
    sig = look("sigma")
    t["prev_low"], t["prev_high"] = look("prev_low"), look("prev_high")
    lo, hi = look("low1515"), look("high1515")
    long = (t["side"] == "long").to_numpy()
    t["stop"] = np.where(long, t["entry"] * (1 - sig), t["entry"] * (1 + sig))
    t["exit_reason"] = "time"
    if stop == "1sd":
        stopped = np.where(long, lo <= t["stop"], hi >= t["stop"])
        t.loc[stopped, "exit"] = t.loc[stopped, "stop"]
        t.loc[stopped, "exit_reason"] = "stop"
    t["ret"] = np.where(long, 1, -1) * (t["exit"] / t["entry"] - 1)
    t = t[t["ret"].abs() <= xsmr.MAX_MOVE]
    t = t.sort_values(["day", "gap"], ascending=[True, False]).reset_index(drop=True)
    t["rank"] = t.groupby("day").cumcount() + 1
    t = t[t["rank"] <= MAX_OPEN].reset_index(drop=True)
    days = o.index[o.notna().any(axis=1)]
    value = (t, pd.DatetimeIndex(days))
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _pit_pivots_spot():
    """The shares' survivorship-free daily prices (pit.py) as pivots, a stock only on days it was in the previous
    month-end's F&O list: open, high, low, close, previous low / high / close."""
    import pit
    f = pit.frame()
    piv = {c: f.pivot(index="day", columns="symbol", values=c).sort_index() for c in ("open", "high", "low", "close")}
    days = piv["close"].index
    member = pit.member_mask(days, piv["close"].columns)
    out = {c: v for c, v in piv.items()}
    out["open"] = out["open"].where(member)
    for c in ("low", "high", "close"):
        out[f"prev_{c}"] = piv[c].shift(1)
    return out, days


def _pit_trades(side, stop, symbols=None, spot=False):
    """Survivorship-free Buy/Sell on gap on the futures' own daily prices (fut_daily_nse, futhistory.py: every
    stock future NSE listed that day, dropped stocks included), from 2015: the rule of _fut_trades on the
    near-month contract (the nearest expiry not yet passed). The previous low / high / close are the same
    contract's previous day; σ: its last 90 daily returns (same contract each day, so a roll adds no jump);
    the 20-day average of the near-month closes. In at the open, out at the close (NSE's daily files have no
    15:15 price), the 1σ stop and the disaster stop on the day's low / high (all after the 09:15 buy).
    symbols: only these (a check of the method on today's list)."""
    key = ("pit", side, stop, tuple(sorted(symbols)) if symbols else None, spot)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    import backtest
    if spot:  # the shares (bt_pit_daily), each month's F&O list
        P, days = _pit_pivots_spot()
        o, hi, lo, cl, pl, ph, pc = (P[c] for c in ("open", "high", "low", "close", "prev_low", "prev_high", "prev_close"))
        if symbols is not None:
            keep = [c for c in o.columns if c in symbols]
            o, hi, lo, cl, pl, ph, pc = (x[keep] for x in (o, hi, lo, cl, pl, ph, pc))
    else:
        with connect() as conn:
            f = pd.read_sql("SELECT symbol, day, expiry, open, high, low, close FROM fut_daily_nse", conn, parse_dates=["day", "expiry"])
        if symbols is not None:
            f = f[f["symbol"].isin(symbols)]
        f = f.sort_values(["symbol", "expiry", "day"])
        g = f.groupby(["symbol", "expiry"])
        for c in ("low", "high", "close"):
            f[f"prev_{c}"] = g[c].shift(1)
        f["prev_day"] = g["day"].shift(1)
        near = f[f["expiry"] >= f["day"]].sort_values(["symbol", "day", "expiry"]).groupby(["symbol", "day"]).head(1)
        days = pd.DatetimeIndex(sorted(near["day"].unique()))
        yday = pd.Series(days[:-1], index=days[1:])
        near = near[near["prev_day"].to_numpy() == yday.reindex(near["day"]).to_numpy()]  # yesterday's, not an older print
        piv = lambda c: near.pivot(index="day", columns="symbol", values=c).reindex(days)
        o, hi, lo, cl = piv("open"), piv("high"), piv("low"), piv("close")
        pl, ph, pc = piv("prev_low"), piv("prev_high"), piv("prev_close")
    ret = cl / pc - 1
    sd = ret.rolling(backtest.GAP_SD_DAYS, min_periods=backtest.GAP_SD_DAYS).std().shift(1)
    ma = cl.rolling(backtest.GAP_MA_DAYS, min_periods=backtest.GAP_MA_DAYS).mean().shift(1)
    o = o.where((o >= lo * 0.995) & (o <= hi * 1.005))  # bad prints
    ok = o.notna() & cl.notna() & sd.notna() & (sd > 0) & ma.notna()
    down, up = 1 - o / pl, o / ph - 1
    frames = []
    for s_, gap, filt in (("long", down, o > ma), ("short", up, o < ma)):
        if s_ == "short" and side == "long":
            continue
        q = ok & filt & (gap > backtest_threshold() * sd)
        gg = gap.where(q).stack().dropna()
        if gg.empty:
            continue
        x = gg.rename("gap").reset_index()
        x.columns = ["day", "symbol", "gap"]
        x["side"] = s_
        frames.append(x)
    t = pd.concat(frames, ignore_index=True)
    ix = pd.MultiIndex.from_arrays([t["day"], t["symbol"]])
    look = lambda fr: fr.stack().reindex(ix).to_numpy(float)
    t["entry"], t["exit"], sig = look(o), look(cl), look(sd)
    t["prev_low"], t["prev_high"], t["day_low"], t["day_high"] = look(pl), look(ph), look(lo), look(hi)
    long = (t["side"] == "long").to_numpy()
    t["stop"] = np.where(long, t["entry"] * (1 - sig), t["entry"] * (1 + sig))
    t["exit_reason"] = "time"
    if stop == "1sd":
        stopped = np.where(long, t["day_low"] <= t["stop"], t["day_high"] >= t["stop"])
        t.loc[stopped, "exit"] = t.loc[stopped, "stop"]
        t.loc[stopped, "exit_reason"] = "stop"
    t["ret"] = np.where(long, 1, -1) * (t["exit"] / t["entry"] - 1)
    t = t[t["ret"].abs() <= xsmr.MAX_MOVE]
    t = t[t["day"] >= pd.Timestamp("2015-01-01")]
    t = t.sort_values(["day", "gap"], ascending=[True, False]).reset_index(drop=True)
    t["rank"] = t.groupby("day").cumcount() + 1
    t = t[t["rank"] <= MAX_OPEN].reset_index(drop=True)
    value = (t, days[days >= max(pd.Timestamp("2015-01-01"), t["day"].min())])
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def backtest_threshold():
    import backtest
    return backtest.GAP_THRESHOLDS[0]


def _sized(dataset, side, stop, max_open, slippage, model="gap", disaster="off", instrument="futures", entry="0915"):
    if dataset == "fnopit" and model != "gap":
        raise ValueError("survivorship-free data: Buy/Sell on gap only")
    spot = dataset == "fnopit" and instrument == "spot"
    t, days = (_pit_trades(side, stop, spot=spot) if dataset == "fnopit" else _fut_trades(side, stop, entry) if on_futures(dataset, model)
               else _trades(dataset, side, stop, model))
    cap = max_open or (MAX_OPEN if model == "gap" else None)  # gapmom's book takes every qualifier
    t = (t[t["rank"] <= cap] if cap else t).copy()
    if disaster == "on" and len(t):  # the 10% disaster stop (disaster.py): out at the level if the day reached it
        import disaster as ds
        if dataset == "fnopit":  # the day's low / high, all after the 09:15 buy
            long = (t["side"] == "long").to_numpy()
            level = np.where(long, t["entry"] * (1 - ds.PCT / 100), t["entry"] * (1 + ds.PCT / 100))
            hit = np.nan_to_num(np.where(long, t["day_low"] <= level, t["day_high"] >= level), nan=0).astype(bool)
        elif on_futures(dataset, model):
            import futsig
            hit, level = futsig.frame_hits(t, ds.PCT)
        else:
            hit, level = ds.frame_hits(t)
        t.loc[hit, "exit"] = level[hit]
        t.loc[hit, "exit_reason"] = "disaster stop"
        t["ret"] = np.where(t["side"] == "long", 1, -1) * (t["exit"] / t["entry"] - 1)
    t["w"] = 1.0 / max_open if max_open else 1.0 / t.groupby("day")["day"].transform("size")
    import v2xsmr
    t["cost"] = (1 + t["exit"] / t["entry"]) * (v2xsmr.spot_cost_per_side(slippage) if spot else xsmr.cost_per_side(slippage))
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]  # the trade's share of capital
    days = days[(days >= t["day"].min())] if len(t) else days
    return t, days


def results(dataset="fno", side="long", stop="none", max_open=5, slippage=0.0002, model="gap", disaster="off", instrument="futures", entry="0915"):
    t, days = _sized(dataset, side, stop, max_open, slippage, model, disaster, instrument, entry)
    spot = dataset == "fnopit" and instrument == "spot"
    extra = {"avg_positions": round(float(t.groupby("day").size().mean()), 1)} if len(t) else {}
    extra["priced_on"] = "share" if spot else "futures" if on_futures(dataset, model) or dataset == "fnopit" else "share"
    if disaster == "on":
        import disaster as ds
        extra.update(disaster_pct=ds.PCT, disaster_hits=int((t["exit_reason"] == "disaster stop").sum()))
    import v2xsmr
    return v2common.build_results(t, days, slippage, extra, cps=v2xsmr.spot_cost_per_side(slippage) if spot else None)


def month_trades(month, dataset="fno", side="long", stop="none", max_open=5, slippage=0.0002, model="gap", disaster="off", instrument="futures",
                 entry="0915"):
    t, _ = _sized(dataset, side, stop, max_open, slippage, model, disaster, instrument, entry)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "entry_at": f"{r.day.date().isoformat()} {'09:16' if entry == '0916' and on_futures(dataset, model) else '09:15'}",
             "exit_at": f"{r.day.date().isoformat()} {v2common.exit_time(r.exit_reason, 'close' if dataset == 'fnopit' else '15:15')}",
             "symbol": r.symbol, "side": r.side, "rank": int(r.rank),
             "gap_pct": round(100 * float(r.gap), 2), "entry": round(float(r.entry), 2), "stop": round(float(r.stop), 2),
             "exit": round(float(r.exit), 2), "reason": r.exit_reason, "weight_pct": round(100 * float(r.w), 2),
             "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3), "net_pct": round(100 * float(r.net), 3),
             "book_net_pct": round(100 * float(r.book_net), 4), "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]
