"""The v2 Data page: every symbol stored, with how much data it has, and its candles for a chart.

Two sources:
- "backtest": the bt_* tables the backtests read (daily from 2000, 15m and 1m candles from 2015)
  for the F&O stocks, the Nifty 50 stocks and the F&O indices (bt_symbols says which universes).
- "live": the eod / intraday_15m tables the classic model pages scan (continuous futures, NSE and
  MCX).

"Missing days" = trading days between a symbol's first and last candle that it has no candle for,
against the Nifty 50's calendar (backtest) or the exchange's busiest symbol (live): a data-quality
check (a stock added to F&O mid-way isn't missing anything before its first candle).
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


def _missing(first, last, calendar):
    """Calendar days in [first, last] (calendar: a sorted array of days)."""
    if first is None or last is None:
        return 0
    return int(np.searchsorted(calendar, np.datetime64(last), side="right") - np.searchsorted(calendar, np.datetime64(first), side="left"))


def _iso(v):
    return v.isoformat() if v is not None and not pd.isna(v) else None


def _backtest():
    with connect() as conn:
        syms = pd.read_sql("SELECT symbol, array_agg(DISTINCT dataset ORDER BY dataset) AS universes, max(name) AS name "
                           "FROM bt_symbols GROUP BY symbol", conn)
        daily = pd.read_sql("SELECT symbol, count(*) AS d_bars, min(day) AS d_first, max(day) AS d_last FROM bt_daily GROUP BY symbol", conn)
        last = pd.read_sql("SELECT DISTINCT ON (symbol) symbol, day AS last_day, close AS last_close FROM bt_daily "
                           "ORDER BY symbol, day DESC", conn)
        m15 = pd.read_sql(f"SELECT symbol, count(*) AS m_bars, count(DISTINCT (datetime AT TIME ZONE '{IST}')::date) AS m_days, "
                          f"min((datetime AT TIME ZONE '{IST}')::date) AS m_first, max((datetime AT TIME ZONE '{IST}')::date) AS m_last "
                          "FROM bt_15m GROUP BY symbol", conn)
        m1 = pd.read_sql("SELECT symbol, count(*) AS o_days, min(day) AS o_first, max(day) AS o_last FROM bt_1m GROUP BY symbol", conn)
        cal_d = pd.read_sql("SELECT day FROM bt_daily WHERE symbol = 'NIFTY 50' ORDER BY day", conn)["day"]
        cal_m = pd.read_sql(f"SELECT DISTINCT (datetime AT TIME ZONE '{IST}')::date AS day FROM bt_15m WHERE symbol = 'NIFTY 50' ORDER BY 1", conn)["day"]
    f = syms.merge(daily, on="symbol", how="left").merge(last, on="symbol", how="left").merge(m15, on="symbol", how="left").merge(m1, on="symbol", how="left")
    cd, cm = cal_d.to_numpy(dtype="datetime64[D]"), cal_m.to_numpy(dtype="datetime64[D]")
    lots = stored_lot_sizes()
    rows = []
    for r in f.itertuples():
        d_bars, m_days = int(r.d_bars or 0) if pd.notna(r.d_bars) else 0, int(r.m_days) if pd.notna(r.m_days) else 0
        d_first, d_last = (r.d_first if pd.notna(r.d_first) else None), (r.d_last if pd.notna(r.d_last) else None)
        m_first, m_last = (r.m_first if pd.notna(r.m_first) else None), (r.m_last if pd.notna(r.m_last) else None)
        lot = lots.get(("NSE", INDEX_FUTURES.get(r.symbol, r.symbol)))
        rows.append({
            "symbol": r.symbol, "name": r.name, "universes": list(r.universes), "lot_size": lot,
            "last_day": _iso(r.last_day), "last_close": round(float(r.last_close), 2) if pd.notna(r.last_close) else None,
            "daily": {"bars": d_bars, "first": _iso(d_first), "last": _iso(d_last),
                      "missing": max(0, _missing(d_first, d_last, cd) - d_bars) if d_first else 0},
            "m15": {"bars": int(r.m_bars) if pd.notna(r.m_bars) else 0, "days": m_days, "first": _iso(m_first), "last": _iso(m_last),
                    "per_day": round(float(r.m_bars) / m_days, 1) if m_days else None,
                    "missing": max(0, _missing(m_first, m_last, cm) - m_days) if m_first else 0},
            "m1": {"days": int(r.o_days) if pd.notna(r.o_days) else 0, "first": _iso(r.o_first if pd.notna(r.o_first) else None),
                   "last": _iso(r.o_last if pd.notna(r.o_last) else None)},
        })
    return sorted(rows, key=lambda x: x["symbol"])


def _live():
    with connect() as conn:
        eod = pd.read_sql("SELECT exchange, symbol, count(*) AS d_bars, min(datetime) AS d_first, max(datetime) AS d_last FROM eod "
                          "GROUP BY 1, 2", conn)
        last = pd.read_sql("SELECT DISTINCT ON (exchange, symbol) exchange, symbol, datetime AS last_day, close AS last_close FROM eod "
                           "ORDER BY exchange, symbol, datetime DESC", conn)
        m15 = pd.read_sql(f"SELECT exchange, symbol, count(*) AS m_bars, count(DISTINCT (datetime AT TIME ZONE '{IST}')::date) AS m_days, "
                          f"min((datetime AT TIME ZONE '{IST}')::date) AS m_first, max((datetime AT TIME ZONE '{IST}')::date) AS m_last "
                          "FROM intraday_15m GROUP BY 1, 2", conn)
        cal_d = pd.read_sql("SELECT exchange, datetime AS day FROM eod GROUP BY 1, 2", conn)
        cal_m = pd.read_sql(f"SELECT exchange, (datetime AT TIME ZONE '{IST}')::date AS day FROM intraday_15m GROUP BY 1, 2", conn)
    f = eod.merge(last, on=["exchange", "symbol"], how="outer").merge(m15, on=["exchange", "symbol"], how="outer")
    # an exchange's calendar: days at least half its symbols traded (sparse special sessions drop out)
    cals = {}
    for name, cal, counts in (("d", cal_d, eod.groupby("exchange").size()), ("m", cal_m, m15.groupby("exchange").size())):
        for ex, g in cal.groupby("exchange"):
            cals[(name, ex)] = np.sort(g["day"].to_numpy(dtype="datetime64[D]"))
    lots = stored_lot_sizes()
    rows = []
    for r in f.itertuples():
        d_bars = int(r.d_bars) if pd.notna(r.d_bars) else 0
        m_days = int(r.m_days) if pd.notna(r.m_days) else 0
        d_first, d_last = (r.d_first if pd.notna(r.d_first) else None), (r.d_last if pd.notna(r.d_last) else None)
        m_first, m_last = (r.m_first if pd.notna(r.m_first) else None), (r.m_last if pd.notna(r.m_last) else None)
        rows.append({
            "symbol": r.symbol, "exchange": r.exchange, "universes": [r.exchange.lower()], "lot_size": lots.get((r.exchange, r.symbol)),
            "last_day": _iso(r.last_day), "last_close": round(float(r.last_close), 2) if pd.notna(r.last_close) else None,
            "daily": {"bars": d_bars, "first": _iso(d_first), "last": _iso(d_last),
                      "missing": max(0, _missing(d_first, d_last, cals.get(("d", r.exchange), np.array([], dtype="datetime64[D]"))) - d_bars) if d_first else 0},
            "m15": {"bars": int(r.m_bars) if pd.notna(r.m_bars) else 0, "days": m_days, "first": _iso(m_first), "last": _iso(m_last),
                    "per_day": round(float(r.m_bars) / m_days, 1) if m_days else None,
                    "missing": max(0, _missing(m_first, m_last, cals.get(("m", r.exchange), np.array([], dtype="datetime64[D]"))) - m_days) if m_first else 0},
            "m1": None,
        })
    return sorted(rows, key=lambda x: (x["exchange"], x["symbol"]))


def symbols(source="backtest"):
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
