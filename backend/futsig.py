"""Futures prices for the intraday stock books that trade the near-month future (Buy/Sell on gap,
cross-sectional mean reversion; Oops has its own, v2oops): the signal, the fill and the exit all at
the future's level, in the backtest and on paper alike.

Backtest (prices()): the signal comes from the stored continuous futures daily candles (eod, exchange
'NSE', the near month rolled at expiry): the future's open, its previous low / high / close, its 20-day
average and the 90-day standard deviation of its daily returns. Kite has no intraday history for expired
futures, so the moves inside the day (the 15:15 price, the lows and highs for a stop, the later entries)
come from the share's candles shifted to the future's level that day (x future open / share open). The
day after an expiry the continuous series' previous candle is the old contract's, so that day the
previous low / high / close are the share's shifted the same way, and the day's return in the standard
deviation is the share's (not the jump from the old contract to the new one).

Paper (paper_stats(), prev_candles()): the same 20-day average and standard deviation from the same
stored candles up to yesterday; yesterday's low / high / close from the current contract's own daily
candle (oopswatch.prepare stores it at 09:10), else the stored continuous candle.
"""

import threading
import time

import numpy as np
import pandas as pd

from db import connect

MAX_BASIS = 0.05  # a future more than 5% from the share at the open: a bad print or a corporate action, left out
_cache, _lock = {}, threading.Lock()
CACHE_SECONDS = 1800


def expiries(days):
    """Each month's stock-futures expiry among `days` (v2oops' rule: last Thursday, last Tuesday from Sep 2025)."""
    import v2oops
    return v2oops._expiries(days)


def roll_days(days):
    """The first trading day after each expiry: the continuous series' first day on the new contract."""
    days = pd.DatetimeIndex(days)
    out = set()
    for e in expiries(days):
        i = days.searchsorted(e, side="right")
        if i < len(days):
            out.add(days[i])
    return pd.Series(days.isin(sorted(out)), index=days)


def _eod(symbols=None, since=None):
    with connect() as conn:
        f = pd.read_sql("SELECT symbol, datetime AS day, open, high, low, close FROM eod WHERE exchange = 'NSE' "
                        "AND open > 0 AND close > 0" + (" AND symbol = ANY(%(s)s)" if symbols else "")
                        + (" AND datetime >= %(d)s" if since else ""),
                        conn, params={"s": list(symbols or []), "d": since})
    f["day"] = pd.to_datetime(f["day"])
    return {c: f.pivot_table(index="day", columns="symbol", values=c, aggfunc="last").sort_index()
            for c in ("open", "high", "low", "close")}


def sigma_ma(fut_close, share_close, roll, sd_days, ma_days):
    """Per day (known at the open: up to the previous close): the standard deviation of the future's last
    sd_days daily returns, the share's return standing in on roll days; and the future's ma_days average close."""
    ret = fut_close.pct_change(fill_method=None)
    sret = share_close.reindex_like(fut_close).pct_change(fill_method=None)
    ret = ret.where(~roll.reindex(ret.index, fill_value=False), sret, axis=0)
    sd = ret.rolling(sd_days, min_periods=sd_days).std().shift(1)
    ma = fut_close.rolling(ma_days, min_periods=ma_days).mean().shift(1)
    return sd, ma


def prices(dataset="fno"):
    """xsmr._prices(dataset) at the future's level (pivots: day x symbol), plus prev_low / prev_high /
    prev_close, sigma (the future's) and ma20, for the futures versions of gap and cross-sectional."""
    key = ("prices", dataset)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    import backtest
    import v2xsmr
    import xsmr
    p = v2xsmr._cached(("prices", dataset), lambda: xsmr._prices(dataset))
    idx, cols = p["open915"].index, p["open915"].columns
    f = {c: v.reindex(index=idx, columns=cols) for c, v in _eod(list(cols)).items()}
    k = f["open"] / p["open915"]
    k = k.where((k - 1).abs() <= MAX_BASIS)
    roll = roll_days(idx)
    # The basis at the close (future close / share close): the 15:15 exit is valued with it, so the exit
    # is the future's own late-day level, not the share's 15:15 shifted by the opening basis (which would
    # carry the share's opening-auction print into the result).
    kc = f["close"] / p["day_close"]
    kc = kc.where((kc - 1).abs() <= MAX_BASIS)
    out = {"k": k, "k_close": kc, "open915": p["open915"] * k}  # = the future's open where k is known
    for c in ("open916", "open930", "open945", "low1515", "high1515"):
        out[c] = p[c] * k
    out["px1515"] = p["px1515"] * kc
    notroll = pd.DataFrame(np.repeat(~roll.to_numpy()[:, None], len(cols), axis=1), index=idx, columns=cols)
    for c, share in (("low", "day_low"), ("high", "day_high"), ("close", "day_close")):
        prev = f[c].shift(1)
        out[f"prev_{c}"] = prev.where(notroll, p[share].shift(1) * k)
    out["day_close"] = f["close"]
    out["day_low"], out["day_high"] = f["low"], f["high"]
    out["sigma"], out["ma20"] = sigma_ma(f["close"], p["day_close"], roll, backtest.GAP_SD_DAYS, backtest.GAP_MA_DAYS)
    with _lock:
        _cache[key] = (time.time(), out)
    return out


def frame_hits(t, pct):
    """The disaster stop on futures rows (symbol, day, side, entry at the future's level): hit where the
    future's day low (long) / high (short) reached pct% from the entry; (hit mask, level)."""
    p = prices()
    days, syms = pd.to_datetime(t["day"]), t["symbol"]
    low = p["day_low"].stack().reindex(pd.MultiIndex.from_arrays([days, syms])).to_numpy()
    high = p["day_high"].stack().reindex(pd.MultiIndex.from_arrays([days, syms])).to_numpy()
    long = (t["side"] == "long").to_numpy()
    entry = t["entry"].to_numpy(float)
    level = np.where(long, entry * (1 - pct / 100), entry * (1 + pct / 100))
    hit = np.where(long, low <= level, high >= level)
    return np.nan_to_num(hit, nan=0).astype(bool), level


# ---- paper ----------------------------------------------------------------------------------------

def paper_stats(symbols, today):
    """{stock: (sigma, ma20)} for today's open, from the stored continuous futures candles up to yesterday
    (the share's return on roll days, as in the backtest)."""
    import backtest
    since = (pd.Timestamp(today) - pd.Timedelta(days=260)).date()
    f = _eod(symbols, since)
    if f["close"].empty:
        return {}
    close = f["close"][f["close"].index < pd.Timestamp(today)]
    with connect() as conn:
        s = pd.read_sql("SELECT symbol, day, close FROM bt_daily WHERE symbol = ANY(%(s)s) AND day >= %(d)s AND day < %(t)s AND close > 0",
                        conn, params={"s": list(symbols), "d": since, "t": today})
    s["day"] = pd.to_datetime(s["day"])
    share = s.pivot_table(index="day", columns="symbol", values="close").reindex(index=close.index, columns=close.columns)
    days = close.index.append(pd.DatetimeIndex([pd.Timestamp(today)]))
    roll = roll_days(days)
    full = close.reindex(days)
    sd, ma = sigma_ma(full, share.reindex(days), roll, backtest.GAP_SD_DAYS, backtest.GAP_MA_DAYS)
    last_sd, last_ma = sd.iloc[-1], ma.iloc[-1]
    return {sym: (float(last_sd[sym]), float(last_ma[sym])) for sym in close.columns
            if pd.notna(last_sd.get(sym)) and pd.notna(last_ma.get(sym)) and last_sd[sym] > 0}


def prev_candles(today, futs):
    """{stock: (future, prev low, prev high, prev close)} for today: the current contract's own previous
    daily candle (oopswatch.prepare, 09:10), else the stored continuous candle. futs: {stock: (future, token)}
    (None: Kite not at hand, the future's name unknown for the stored candles)."""
    out = {}
    with connect() as conn, conn.cursor() as cursor:
        try:
            cursor.execute("SELECT symbol, fut, prev_low, prev_high, prev_close FROM oops_paper_prev WHERE day = %s", (today,))
            for s, fut, lo, hi, cl in cursor.fetchall():
                if hi and cl:
                    out[s] = (fut, lo, hi, cl)
        except Exception:
            conn.rollback()
        cursor.execute("SELECT DISTINCT ON (symbol) symbol, low, high, close FROM eod WHERE exchange = 'NSE' AND datetime < %s "
                       "AND datetime >= %s::date - 10 AND low > 0 ORDER BY symbol, datetime DESC", (today, today))
        for s, lo, hi, cl in cursor.fetchall():
            if s not in out and (futs is None or s in futs):
                out[s] = ((futs or {}).get(s, (None,))[0], lo, hi, cl)
    return out


def fut_ranges(pairs):
    """{(symbol, day iso): (low, high)} of the continuous future's daily candle (the paper books' disaster stop)."""
    if not pairs:
        return {}
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol, datetime, low, high FROM eod WHERE exchange = 'NSE' AND (symbol, datetime) IN "
                       "(SELECT * FROM unnest(%s::text[], %s::date[]))", ([s for s, _ in pairs], [d for _, d in pairs]))
        return {(s, d.isoformat()): (lo, hi) for s, d, lo, hi in cursor.fetchall()}
