"""Survivorship-free F&O data (dataset "fnopit"): every stock that was ever in F&O since 2007, with
the month-by-month F&O list, so a backtest only buys what was actually in F&O at the time.

- bt_pit_daily (symbol, day, open, high, low, close): NSE's daily bhavcopies 2007 on, adjusted for
  splits and bonuses (from NSE's own previous close: each day's move is close / prev_close, a move over
  40% is a bad print and counts as none), scaled so the last price is the real one. Topped up after the
  close from bt_daily (Kite) for today's F&O stocks; when Kite's scale for a stock moves (a split), that
  stock's stored history is rescaled to it.
- bt_pit_members (day, symbol): the stocks with futures at each month-end (NSE's F&O bhavcopy), and from
  now on today's F&O list (bt_symbols) at each new month-end.

member_mask(): for each trading day, True where the stock was in F&O at the previous month-end, the list
a trader would have had. Held positions keep their prices after a stock leaves the list (only buys are
limited to members).

Only daily-close models can use it: there are no 15-minute or 1-minute candles for removed stocks.
"""

import threading
import time

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

from db import connect

DATASET = "fnopit"
LABEL = "F&O, survivorship-free"
MAX_MOVE = 0.4
CACHE_SECONDS = 6 * 3600
_cache, _lock = {}, threading.Lock()


def ensure_tables():
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS bt_pit_daily (
                symbol TEXT NOT NULL, day DATE NOT NULL,
                open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION, close DOUBLE PRECISION NOT NULL,
                PRIMARY KEY (symbol, day));
            CREATE INDEX IF NOT EXISTS bt_pit_daily_day ON bt_pit_daily (day);
            CREATE TABLE IF NOT EXISTS bt_pit_members (day DATE NOT NULL, symbol TEXT NOT NULL, PRIMARY KEY (day, symbol));
        """)
        conn.commit()


def adjust(raw):
    """raw: day, symbol, open, high, low, close, prev_close (NSE). Returns split-adjusted OHLC rows."""
    raw = raw.sort_values(["symbol", "day"]).drop_duplicates(["symbol", "day"])
    r = (raw["close"] / raw["prev_close"] - 1).where(lambda x: x.abs() < MAX_MOVE).fillna(0.0)
    raw = raw.assign(r=r)
    out = []
    for _, g in raw.groupby("symbol", sort=False):
        idx = (1 + g["r"]).cumprod()
        adj_close = idx * (g["close"].iloc[-1] / idx.iloc[-1])
        k = adj_close / g["close"]
        out.append(pd.DataFrame({"symbol": g["symbol"], "day": g["day"], "open": g["open"] * k, "high": g["high"] * k,
                                 "low": g["low"] * k, "close": adj_close}))
    return pd.concat(out, ignore_index=True)


def load(daily_rows, members):
    """One-off: store adjusted NSE daily rows and the month-end F&O lists (replaces what's there)."""
    ensure_tables()
    rows = adjust(daily_rows)
    with connect() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE bt_pit_daily")
        execute_values(cur, "INSERT INTO bt_pit_daily (symbol, day, open, high, low, close) VALUES %s",
                       [(s, d.date(), _f(o), _f(h), _f(lo), float(c)) for s, d, o, h, lo, c in
                        rows[["symbol", "day", "open", "high", "low", "close"]].itertuples(index=False)], page_size=5000)
        cur.execute("TRUNCATE bt_pit_members")
        execute_values(cur, "INSERT INTO bt_pit_members (day, symbol) VALUES %s ON CONFLICT DO NOTHING",
                       [(d.date(), s) for d, s in members[["day", "symbol"]].itertuples(index=False)], page_size=5000)
        conn.commit()
    invalidate()
    return len(rows)


def _f(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else float(x)


def topup():
    """After the close: new days for today's F&O stocks from bt_daily (Kite), rescaling a stock's stored
    history when Kite's scale moved; and today's F&O list at each month-end not yet stored."""
    ensure_tables()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT max(day) FROM bt_pit_daily")
        last = cur.fetchone()[0]
        if last is None:
            return {"days": 0, "rescaled": 0, "months": 0}
        cur.execute("SELECT symbol FROM bt_symbols WHERE dataset = 'fno'")
        fno = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT DISTINCT ON (symbol) symbol, day, close FROM bt_pit_daily WHERE symbol = ANY(%s) ORDER BY symbol, day DESC", (fno,))
        stored = {s: (d, c) for s, d, c in cur.fetchall()}
        cur.execute("SELECT symbol, day, open, high, low, close FROM bt_daily WHERE symbol = ANY(%s) AND close > 0 AND day >= %s",
                    (fno, min([d for d, _ in stored.values()] + [last])))
        kite = pd.DataFrame(cur.fetchall(), columns=["symbol", "day", "open", "high", "low", "close"])
        rescaled, new = 0, []
        for s, g in kite.groupby("symbol"):
            g = g.set_index("day")
            if s in stored:
                d0, c0 = stored[s]
                if d0 in g.index and c0:
                    ratio = float(g.at[d0, "close"]) / c0
                    if abs(ratio - 1) > 0.02:
                        cur.execute("UPDATE bt_pit_daily SET open = open * %s, high = high * %s, low = low * %s, close = close * %s "
                                    "WHERE symbol = %s", (ratio, ratio, ratio, ratio, s))
                        rescaled += 1
                g = g[g.index > d0]
            else:  # a new F&O stock: its whole Kite history
                cur.execute("SELECT day, open, high, low, close FROM bt_daily WHERE symbol = %s AND close > 0", (s,))
                g = pd.DataFrame(cur.fetchall(), columns=["day", "open", "high", "low", "close"]).set_index("day")
            new += [(s, d, _f(r.open), _f(r.high), _f(r.low), float(r.close)) for d, r in g.iterrows()]
        if new:
            execute_values(cur, "INSERT INTO bt_pit_daily (symbol, day, open, high, low, close) VALUES %s "
                                "ON CONFLICT (symbol, day) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, "
                                "low = EXCLUDED.low, close = EXCLUDED.close", new, page_size=5000)
        # month-ends since the last stored list: today's F&O list (the list changes rarely, mid-month at most)
        cur.execute("SELECT max(day) FROM bt_pit_members")
        last_m = cur.fetchone()[0]
        cur.execute("SELECT DISTINCT day FROM bt_daily WHERE symbol = 'NIFTY 50' AND day > %s ORDER BY day", (last_m,))
        days = pd.to_datetime(pd.Series([r[0] for r in cur.fetchall()], dtype="object"))
        month_ends = [d.date() for d, n in zip(days, list(days[1:]) + [None]) if n is not None and n.month != d.month]
        for m in month_ends:
            execute_values(cur, "INSERT INTO bt_pit_members (day, symbol) VALUES %s ON CONFLICT DO NOTHING", [(m, s) for s in fno])
        conn.commit()
    invalidate()
    return {"days": len(new), "rescaled": rescaled, "months": len(month_ends)}


def invalidate():
    with _lock:
        _cache.clear()


def _get(key, build):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = build()
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def frame():
    """Every stored row (symbol, day, open, high, low, close)."""
    def build():
        with connect() as conn:
            f = pd.read_sql("SELECT symbol, day, open, high, low, close FROM bt_pit_daily WHERE close > 0", conn)
        f["day"] = pd.to_datetime(f["day"])
        return f
    return _get("frame", build)


def closes():
    def build():
        # NSE's bhavcopies have no holes, so no thin-day filter (and after the last NSE file only today's F&O
        # stocks are topped up, so the count of priced stocks drops: that's expected)
        return frame().pivot(index="day", columns="symbol", values="close").sort_index()
    return _get("closes", build).copy()


def members():
    def build():
        with connect() as conn:
            m = pd.read_sql("SELECT day, symbol FROM bt_pit_members", conn)
        m["day"] = pd.to_datetime(m["day"])
        return m.groupby(m["day"].dt.to_period("M"))["symbol"].apply(frozenset).to_dict()
    return _get("members", build)


def member_mask(index, columns):
    """True where the stock was in F&O at the month-end before the day (what was tradable then)."""
    by_month = members()
    cols = list(columns)
    pos = {s: j for j, s in enumerate(cols)}
    out = np.zeros((len(index), len(cols)), dtype=bool)
    periods = pd.DatetimeIndex(index).to_period("M")
    for i, p in enumerate(periods):
        for s in by_month.get(p - 1, ()):
            j = pos.get(s)
            if j is not None:
                out[i, j] = True
    return pd.DataFrame(out, index=index, columns=columns)
