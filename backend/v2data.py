"""The v2 Data page: every symbol stored, with how much data it has, and its candles for a chart.

Two sources:
- "backtest": the bt_* tables the backtests read (daily from 2000, 15m and 1m candles from 2015)
  for the F&O stocks, the Nifty 50 stocks and the F&O indices (bt_symbols says which universes).
- "live": the eod / intraday_15m tables the classic model pages scan (continuous futures, NSE and
  MCX).

Coverage, per symbol, between its first and last candle, against a calendar of the days at least half
the usual number of symbols traded (so a special session a few traded isn't a day the rest missed):
- gaps: runs of GAP_DAYS or more trading days with no candle (out of F&O for a while, or not in Kite's
  history), each with its dates;
- missing: the short holes left, the real data-quality problems.
"""

import threading
import time

import numpy as np
import pandas as pd

from db import connect, stored_lot_sizes

CACHE_SECONDS = 600
INDEX_FUTURES = {"NIFTY 50": "NIFTY", "NIFTY BANK": "BANKNIFTY", "NIFTY FIN SERVICE": "FINNIFTY",
                 "NIFTY MID SELECT": "MIDCPNIFTY", "NIFTY NEXT 50": "NIFTYNXT50"}
IST = "Asia/Kolkata"
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


GAP_DAYS = 20  # a run of this many trading days with no candle is a gap (not listed / no data), not a hole


def _coverage(days, calendar):
    """Missing days and gaps for one symbol: calendar days between its first and last candle that it
    has no candle for, split into short holes ("missing") and runs of GAP_DAYS or more ("gaps")."""
    if not len(days):
        return {"missing": 0, "gaps": [], "gap_days": 0}
    span = calendar[(calendar >= days[0]) & (calendar <= days[-1])]
    absent = np.setdiff1d(span, days, assume_unique=True)
    if not len(absent):
        return {"missing": 0, "gaps": [], "gap_days": 0}
    pos = np.searchsorted(calendar, absent)
    runs = np.split(absent, np.flatnonzero(np.diff(pos) != 1) + 1)
    gaps = [{"from": str(r[0]), "to": str(r[-1]), "days": int(len(r))} for r in runs if len(r) >= GAP_DAYS]
    gap_days = sum(g["days"] for g in gaps)
    return {"missing": int(len(absent) - gap_days), "gaps": gaps, "gap_days": int(gap_days)}


def _calendar(day_symbol, min_share=0.5):
    """Trading days: days at least min_share of the usual number of symbols traded (a Saturday
    session a few commodities held, or a sparse special session, isn't a day the rest missed)."""
    counts = day_symbol.groupby("day")["symbol"].nunique().sort_index()
    usual = counts.rolling(41, center=True, min_periods=1).median()
    return np.sort(counts.index[counts >= min_share * usual].to_numpy(dtype="datetime64[D]"))


def _per_symbol(frame, keys):
    """{key: sorted array of days} from a (keys..., day) frame."""
    out = {}
    for k, g in frame.groupby(keys):
        out[k if isinstance(k, tuple) and len(keys) > 1 else (k[0] if isinstance(k, tuple) else k)] = np.sort(
            g["day"].to_numpy(dtype="datetime64[D]"))
    return out


def _last_candle(lr):
    """The latest daily candle: OHLC, volume and (live futures) open interest."""
    if lr is None:
        return {"last_day": None, "last_close": None, "last": None}
    num = lambda k: round(float(lr[k]), 2) if k in lr and pd.notna(lr[k]) else None
    whole = lambda k: int(lr[k]) if k in lr and pd.notna(lr[k]) else None
    return {"last_day": _iso(lr["last_day"]), "last_close": num("last_close"),
            "last": {"open": num("open"), "high": num("high"), "low": num("low"), "close": num("last_close"),
                     "volume": whole("volume"), "oi": whole("oi")}}


def _contracts():
    """{(exchange, name): (tradingsymbol, expiry)}: the current futures contract per underlying."""
    try:
        from contracts import list_contracts
        return {(r["exchange"], r["name"]): (r["tradingsymbol"], r.get("expiry")) for r in list_contracts("ALL")}
    except Exception as error:  # the contract list needs the instruments table; the page works without it
        print("Data page contracts failed:", error)
        return {}


def _contract(contracts, exchange, name):
    c = contracts.get((exchange, name))
    return {"contract": c[0], "expiry": str(c[1]) if c and c[1] else None} if c else {"contract": None, "expiry": None}


def _iso(v):
    return v.isoformat() if v is not None and not pd.isna(v) else None


def _block(days, calendar, bars=None):
    if not len(days):
        return {"bars": 0, "days": 0, "first": None, "last": None, "missing": 0, "gaps": [], "gap_days": 0, "per_day": None}
    cov = _coverage(days, calendar)
    return {"bars": int(bars if bars is not None else len(days)), "days": int(len(days)), "first": str(days[0]), "last": str(days[-1]),
            "per_day": round(float(bars) / len(days), 1) if bars else None, **cov}


def _backtest():
    with connect() as conn:
        syms = pd.read_sql("SELECT symbol, array_agg(DISTINCT dataset ORDER BY dataset) AS universes, max(name) AS name "
                           "FROM bt_symbols GROUP BY symbol", conn)
        daily = pd.read_sql("SELECT symbol, day FROM bt_daily", conn)
        last = pd.read_sql("SELECT DISTINCT ON (symbol) symbol, day AS last_day, open, high, low, close AS last_close, volume "
                           "FROM bt_daily ORDER BY symbol, day DESC", conn)
        m15 = pd.read_sql(f"SELECT symbol, (datetime AT TIME ZONE '{IST}')::date AS day, count(*) AS n FROM bt_15m GROUP BY 1, 2", conn)
        m1 = pd.read_sql("SELECT symbol, count(*) AS o_days, min(day) AS o_first, max(day) AS o_last FROM bt_1m GROUP BY symbol", conn)
    # calendars: days at least half the usual number of symbols traded (special sessions drop out)
    cal_d, cal_m = _calendar(daily), _calendar(m15)
    d_days, m_days = _per_symbol(daily, ["symbol"]), _per_symbol(m15, ["symbol"])
    m_bars = m15.groupby("symbol")["n"].sum()
    last = last.set_index("symbol")
    m1 = m1.set_index("symbol")
    lots = stored_lot_sizes()
    contracts = _contracts()
    rows = []
    for r in syms.itertuples():
        sym = r.symbol
        lr = last.loc[sym] if sym in last.index else None
        o = m1.loc[sym] if sym in m1.index else None
        rows.append({
            "symbol": sym, "name": r.name, "universes": list(r.universes), "lot_size": lots.get(("NSE", INDEX_FUTURES.get(sym, sym))),
            **_last_candle(lr), **_contract(contracts, "NSE", INDEX_FUTURES.get(sym, sym)),
            "daily": _block(d_days.get(sym, np.array([], dtype="datetime64[D]")), cal_d),
            "m15": _block(m_days.get(sym, np.array([], dtype="datetime64[D]")), cal_m, int(m_bars.get(sym, 0))),
            "m1": {"days": int(o["o_days"]) if o is not None else 0, "first": _iso(o["o_first"]) if o is not None else None,
                   "last": _iso(o["o_last"]) if o is not None else None},
        })
    return sorted(rows, key=lambda x: x["symbol"])


def _live():
    with connect() as conn:
        eod = pd.read_sql("SELECT exchange, symbol, datetime AS day FROM eod", conn)
        last = pd.read_sql("SELECT DISTINCT ON (exchange, symbol) exchange, symbol, datetime AS last_day, open, high, low, "
                           "close AS last_close, volume, oi FROM eod ORDER BY exchange, symbol, datetime DESC", conn)
        m15 = pd.read_sql(f"SELECT exchange, symbol, (datetime AT TIME ZONE '{IST}')::date AS day, count(*) AS n FROM intraday_15m GROUP BY 1, 2, 3", conn)
    cals = {}
    for kind, frame in (("d", eod), ("m", m15)):
        for ex, g in frame.groupby("exchange"):
            cals[(kind, ex)] = _calendar(g)
    d_days, m_days = _per_symbol(eod, ["exchange", "symbol"]), _per_symbol(m15, ["exchange", "symbol"])
    m_bars = m15.groupby(["exchange", "symbol"])["n"].sum()
    last = last.set_index(["exchange", "symbol"])
    lots = stored_lot_sizes()
    contracts = _contracts()
    empty = np.array([], dtype="datetime64[D]")
    rows = []
    for ex, sym in sorted(set(d_days) | set(m_days)):
        lr = last.loc[(ex, sym)] if (ex, sym) in last.index else None
        rows.append({
            "symbol": sym, "exchange": ex, "universes": [ex.lower()], "lot_size": lots.get((ex, sym)),
            **_last_candle(lr), **_contract(contracts, ex, sym),
            "daily": _block(d_days.get((ex, sym), empty), cals.get(("d", ex), empty)),
            "m15": _block(m_days.get((ex, sym), empty), cals.get(("m", ex), empty), int(m_bars.get((ex, sym), 0))),
            "m1": None,
        })
    return rows


def symbols(source="backtest", refresh=False):
    if refresh:  # after a download: count again now
        with _lock:
            _cache.pop(("symbols", source), None)
    rows = _cached(("symbols", source), _backtest if source == "backtest" else _live)
    tot = lambda key, field: sum((r[key] or {}).get(field, 0) or 0 for r in rows)
    return {"source": source, "symbols": rows,
            "totals": {"symbols": len(rows), "daily_bars": tot("daily", "bars"), "m15_bars": tot("m15", "bars"),
                       "m1_days": tot("m1", "days") if source == "backtest" else None,
                       "first": min((r["daily"]["first"] for r in rows if r["daily"]["first"]), default=None),
                       "last": max((r["daily"]["last"] for r in rows if r["daily"]["last"]), default=None)}}


def candles(symbol, interval="day", source="backtest", exchange="NSE", days=365):
    """OHLCV for one symbol: daily (last `days` calendar days, 0 = all) or 15m (last `days`, at most 365)."""
    with connect() as conn:
        if interval == "day":
            table, col, extra = ("bt_daily", "day", "") if source == "backtest" else ("eod", "datetime", "AND exchange = %(ex)s")
            q = (f"SELECT {col} AS t, open, high, low, close, volume FROM {table} WHERE symbol = %(s)s {extra} "
                 + (f"AND {col} >= (SELECT max({col}) FROM {table} WHERE symbol = %(s)s {extra}) - %(n)s::int " if days else "")
                 + f"ORDER BY {col}")
        else:
            table, extra = ("bt_15m", "") if source == "backtest" else ("intraday_15m", "AND exchange = %(ex)s")
            q = (f"SELECT datetime AS t, open, high, low, close, volume FROM {table} WHERE symbol = %(s)s {extra} "
                 f"AND datetime >= (SELECT max(datetime) FROM {table} WHERE symbol = %(s)s {extra}) - make_interval(days => %(n)s::int) "
                 "ORDER BY datetime")
            days = min(days or 365, 365)
        f = pd.read_sql(q, conn, params={"s": symbol, "ex": exchange, "n": days})
    if f.empty:
        return []
    if interval == "day":
        times = pd.to_datetime(f["t"]).dt.strftime("%Y-%m-%d")
    else:  # epoch seconds shifted to IST so the chart's clock reads Indian time
        ts = pd.to_datetime(f["t"], utc=True)
        times = ((ts - pd.Timestamp("1970-01-01", tz="UTC")).dt.total_seconds() + 19800).astype(int)
    return [{"time": t, "open": float(o), "high": float(h), "low": float(l), "close": float(c), "volume": int(v or 0)}
            for t, o, h, l, c, v in zip(times, f["open"], f["high"], f["low"], f["close"], f["volume"])]
