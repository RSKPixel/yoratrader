"""Top 500 NSE stocks in cash (dataset "cash500"): survivorship-free, built only from what was known at
the time.

- bt_c500_daily (symbol, day, open, high, low, close, raw_close, value): NSE's daily equity bhavcopies
  (EQ and BE series), 2007 on, adjusted for splits and bonuses from NSE's previous close (a move over 40%
  counts as none), scaled so the last price is the real one; raw_close is NSE's own close (to spot the
  next corporate action); value is the day's traded value in rupees. History: the stocks ever in the top
  1,000; from the first top-up on, every stock (so a newcomer to the top 500 has its history).
- bt_c500_members (day, symbol): at each month-end, the 500 stocks with the highest average traded value
  over the last 63 trading days (traded on at least 80% of them). Delisted and suspended stocks are in it
  for as long as they qualified.

member_mask(): True on a day for the stocks in the top 500 at the previous month-end. tradable_mask():
False on days a stock was locked at a circuit (high = low), when a buy at the close couldn't be done.
Topped up after the close from NSE's next bhavcopy (the day before, as NSE publishes in the evening).
EXTRA_SLIPPAGE: per side on top of the usual slippage, as smaller stocks have wider spreads.
"""

import io
import threading
import time
import urllib.request
import zipfile
from datetime import date, timedelta

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

from db import connect

DATASET = "cash500"
LABEL = "Top 500, cash"
TOP, WINDOW, MIN_SHARE = 500, 63, 0.8
MAX_MOVE = 0.4
EXTRA_SLIPPAGE = 0.0008  # 0.08% a side more than for F&O stocks
CACHE_SECONDS = 6 * 3600
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
_cache, _lock = {}, threading.Lock()


def ensure_tables():
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS bt_c500_daily (
                symbol TEXT NOT NULL, day DATE NOT NULL,
                open REAL, high REAL, low REAL, close REAL NOT NULL, raw_close REAL NOT NULL, value DOUBLE PRECISION,
                PRIMARY KEY (symbol, day));
            CREATE INDEX IF NOT EXISTS bt_c500_daily_day ON bt_c500_daily (day);
            CREATE TABLE IF NOT EXISTS bt_c500_members (day DATE NOT NULL, symbol TEXT NOT NULL, PRIMARY KEY (day, symbol));
        """)
        conn.commit()


def _one_per_day(raw):
    """EQ preferred over BE when a stock has both on a day."""
    raw = raw.copy()
    raw["pri"] = (raw["series"] != "EQ").astype(int)
    return raw.sort_values(["symbol", "day", "pri"]).drop_duplicates(["symbol", "day"]).drop(columns="pri")


def membership(raw, top=TOP):
    """Month-end top lists by average traded value over the last WINDOW trading days."""
    v = raw.pivot(index="day", columns="symbol", values="value").sort_index()
    days = v.index
    avg = v.fillna(0.0).rolling(WINDOW, min_periods=WINDOW).mean()
    traded = v.notna().rolling(WINDOW, min_periods=WINDOW).sum() >= MIN_SHARE * WINDOW
    month_end = pd.Series(days, index=days).groupby(days.to_period("M")).max()
    month_end = month_end.iloc[:-1]  # the data's last month may not be over: its list comes from the top-up
    rows = []
    for d in month_end.values:
        a = avg.loc[d].where(traded.loc[d]).dropna()
        rows += [(pd.Timestamp(d), s) for s in a.nlargest(top).index]
    return pd.DataFrame(rows, columns=["day", "symbol"])


def adjust(raw):
    raw = raw.sort_values(["symbol", "day"])
    r = (raw["close"] / raw["prev_close"] - 1).where(lambda x: x.abs() < MAX_MOVE).fillna(0.0)
    raw = raw.assign(r=r)
    out = []
    for _, g in raw.groupby("symbol", sort=False):
        idx = (1 + g["r"]).cumprod()
        adj = idx * (g["close"].iloc[-1] / idx.iloc[-1])
        k = adj / g["close"]
        out.append(pd.DataFrame({"symbol": g["symbol"], "day": g["day"], "open": g["open"] * k, "high": g["high"] * k,
                                 "low": g["low"] * k, "close": adj, "raw_close": g["close"], "value": g["value"]}))
    return pd.concat(out, ignore_index=True)


def load(raw):
    """One-off: raw = every NSE EQ/BE row (day, symbol, series, open, high, low, close, prev_close, value)."""
    ensure_tables()
    raw = _one_per_day(raw[raw["close"] > 0])
    members = membership(raw)
    keep = set(membership(raw, 2 * TOP)["symbol"])  # ever in the top 1,000: the history a later newcomer needs
    rows = adjust(raw[raw["symbol"].isin(keep)])
    with connect() as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE bt_c500_daily")
        execute_values(cur, "INSERT INTO bt_c500_daily (symbol, day, open, high, low, close, raw_close, value) VALUES %s",
                       [(s, d.date(), _f(o), _f(h), _f(lo), float(c), float(rc), _f(v)) for s, d, o, h, lo, c, rc, v in
                        rows[["symbol", "day", "open", "high", "low", "close", "raw_close", "value"]].itertuples(index=False)], page_size=5000)
        cur.execute("TRUNCATE bt_c500_members")
        execute_values(cur, "INSERT INTO bt_c500_members (day, symbol) VALUES %s",
                       [(d.date(), s) for d, s in members.itertuples(index=False)], page_size=5000)
        conn.commit()
    invalidate()
    return {"rows": len(rows), "symbols": len(keep), "months": members["day"].nunique()}


def _f(x):
    return None if x is None or pd.isna(x) else float(x)


def _get(url):
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read()
            z = zipfile.ZipFile(io.BytesIO(data))
            return z.read(z.namelist()[0])
        except Exception as error:
            if "404" in str(error):
                return None
            time.sleep(2 + 4 * attempt)
    return None


def topup():
    """New days from NSE's bhavcopies (to yesterday): every stock that was ever a member, rescaling a stock's
    history at a split or bonus; then the month-end list for any month that has ended since."""
    ensure_tables()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT max(day) FROM bt_c500_daily")
        last = cur.fetchone()[0]
        if last is None:
            return {"days": 0}
        cur.execute("SELECT day FROM bt_daily WHERE symbol = 'NIFTY 50' AND day > %s AND day < %s ORDER BY day", (last, date.today()))
        days = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT DISTINCT ON (symbol) symbol, close, raw_close FROM bt_c500_daily ORDER BY symbol, day DESC")
        prev = {s: (c, rc) for s, c, rc in cur.fetchall()}
    added = 0
    for d in days:
        raw = _get(f"https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
        if not raw:
            continue
        g = pd.read_csv(io.BytesIO(raw))
        g = g[g["SctySrs"].isin(["EQ", "BE"])]
        g = pd.DataFrame({"symbol": g["TckrSymb"], "series": g["SctySrs"], "day": pd.Timestamp(d), "open": g["OpnPric"], "high": g["HghPric"],
                          "low": g["LwPric"], "close": g["ClsPric"], "prev_close": g["PrvsClsgPric"], "value": g["TtlTrfVal"]})
        g = _one_per_day(g[g["close"] > 0])
        rows = []
        with connect() as conn, conn.cursor() as cur:
            for r in g.itertuples(index=False):
                if r.symbol not in prev:  # a stock not stored before (new listing, or a newcomer to the top 1,000)
                    prev[r.symbol] = (float(r.prev_close or r.close), float(r.prev_close or r.close))
                c0, rc0 = prev[r.symbol]
                if rc0 and r.prev_close and abs(r.prev_close / rc0 - 1) > 0.02:  # a split or bonus: NSE's prev close is adjusted
                    ratio = r.prev_close / rc0
                    cur.execute("UPDATE bt_c500_daily SET open = open * %s, high = high * %s, low = low * %s, close = close * %s WHERE symbol = %s",
                                (ratio, ratio, ratio, ratio, r.symbol))
                    c0 = c0 * ratio
                move = r.close / r.prev_close - 1 if r.prev_close else 0.0
                close = c0 * (1 + (move if abs(move) < MAX_MOVE else 0.0))
                k = close / r.close
                rows.append((r.symbol, d, _f(r.open * k), _f(r.high * k), _f(r.low * k), float(close), float(r.close), _f(r.value)))
                prev[r.symbol] = (close, r.close)
            if rows:
                execute_values(cur, "INSERT INTO bt_c500_daily (symbol, day, open, high, low, close, raw_close, value) VALUES %s "
                                    "ON CONFLICT (symbol, day) DO NOTHING", rows, page_size=5000)
            conn.commit()
        added += 1
    _topup_members()
    invalidate()
    return {"days": added}


def _topup_members():
    """Month-end lists for months ended since the last stored one, from the stored traded values."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT max(day) FROM bt_c500_members")
        last_m = cur.fetchone()[0]
        cur.execute("SELECT DISTINCT day FROM bt_c500_daily WHERE day > %s ORDER BY day", (last_m,))
        days = [r[0] for r in cur.fetchall()]
        ends = [d for d, n in zip(days, days[1:]) if n.month != d.month]
        for m in ends:
            cur.execute("""
                WITH w AS (SELECT DISTINCT day FROM bt_c500_daily WHERE day <= %(m)s ORDER BY day DESC LIMIT %(n)s)
                SELECT symbol FROM bt_c500_daily WHERE day IN (SELECT day FROM w)
                GROUP BY symbol HAVING count(*) >= %(need)s ORDER BY sum(value) DESC LIMIT %(top)s""",
                        {"m": m, "n": WINDOW, "need": int(MIN_SHARE * WINDOW), "top": TOP})
            execute_values(cur, "INSERT INTO bt_c500_members (day, symbol) VALUES %s ON CONFLICT DO NOTHING", [(m, s) for (s,) in cur.fetchall()])
        conn.commit()


def invalidate():
    with _lock:
        _cache.clear()


def _get_cached(key, build):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = build()
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def frame():
    def build():
        with connect() as conn:
            f = pd.read_sql("SELECT symbol, day, open, high, low, close FROM bt_c500_daily WHERE close > 0", conn)
        f["day"] = pd.to_datetime(f["day"])
        return f
    return _get_cached("frame", build)


def closes():
    return _get_cached("closes", lambda: frame().pivot(index="day", columns="symbol", values="close").sort_index()).copy()


def members():
    def build():
        with connect() as conn:
            m = pd.read_sql("SELECT day, symbol FROM bt_c500_members", conn)
        m["day"] = pd.to_datetime(m["day"])
        return m.groupby(m["day"].dt.to_period("M"))["symbol"].apply(frozenset).to_dict()
    return _get_cached("members", build)


def member_mask(index, columns):
    by_month = members()
    pos = {s: j for j, s in enumerate(columns)}
    out = np.zeros((len(index), len(columns)), dtype=bool)
    for i, p in enumerate(pd.DatetimeIndex(index).to_period("M")):
        for s in by_month.get(p - 1, ()):
            j = pos.get(s)
            if j is not None:
                out[i, j] = True
    return pd.DataFrame(out, index=index, columns=columns)


def tradable_mask(index, columns):
    """False where the stock was locked at a circuit that day (high = low): no buy at the close."""
    f = frame()
    hi = f.pivot(index="day", columns="symbol", values="high").reindex(index=index, columns=columns)
    lo = f.pivot(index="day", columns="symbol", values="low").reindex(index=index, columns=columns)
    return ~(hi.notna() & (hi <= lo))
