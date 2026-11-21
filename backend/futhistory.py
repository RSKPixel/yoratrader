"""Daily stock-futures candles for every stock that was in F&O, dropped ones included, from NSE's daily F&O
bhavcopy (the same archive as lothistory.py). For survivorship-free futures backtests (Oops): the stored
futures candles (eod) cover only today's F&O stocks.

fut_daily_nse: one row per stock-futures contract per day (every listed expiry: the near month, the next and
the far one, so a contract's previous day is there across a roll): open, high, low, close, contracts traded.
Raw files aren't kept. A day with no trades in a contract has no row.

Run:  venv/bin/python futhistory.py download [since] [until]
"""

import io
import sys
import time
from datetime import date

import pandas as pd
from psycopg2.extras import execute_values

import optdata
from db import connect

START = date(2015, 1, 1)


def ensure_table():
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fut_daily_nse (
                symbol TEXT NOT NULL, day DATE NOT NULL, expiry DATE NOT NULL, open REAL, high REAL, low REAL, close REAL,
                contracts BIGINT, PRIMARY KEY (symbol, day, expiry));
            CREATE INDEX IF NOT EXISTS fut_daily_nse_day ON fut_daily_nse (day);
        """)
        conn.commit()


def _file(d):
    """The day's stock futures (every expiry): symbol, expiry, open, high, low, close, contracts."""
    mon = d.strftime("%b").upper()
    if d < optdata.NEW_FROM:
        raw = optdata._get(f"https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{d.year}/{mon}/fo{d.strftime('%d')}{mon}{d.year}bhav.csv.zip")
        if not raw:
            return None
        f = pd.read_csv(io.BytesIO(raw))
        f.columns = [c.strip() for c in f.columns]
        f = f[f["INSTRUMENT"].str.strip() == "FUTSTK"]
        return pd.DataFrame({
            "symbol": f["SYMBOL"].str.strip(), "expiry": pd.to_datetime(f["EXPIRY_DT"].str.strip(), format="mixed", dayfirst=True).dt.date,
            "open": f["OPEN"].astype(float), "high": f["HIGH"].astype(float), "low": f["LOW"].astype(float),
            "close": f["CLOSE"].astype(float), "contracts": f["CONTRACTS"].astype(float)})
    raw = optdata._get(f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
    if not raw:
        return None
    f = pd.read_csv(io.BytesIO(raw))
    f = f[f["FinInstrmTp"] == "STF"]
    return pd.DataFrame({
        "symbol": f["TckrSymb"], "expiry": pd.to_datetime(f["XpryDt"]).dt.date,
        "open": f["OpnPric"].astype(float), "high": f["HghPric"].astype(float), "low": f["LwPric"].astype(float),
        "close": f["ClsPric"].astype(float), "contracts": f["TtlTradgVol"].astype(float)})


def download(since=START, until=None):
    ensure_table()
    until = until or date.today()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT day FROM fut_daily_nse")
        have = {r[0] for r in cur.fetchall()}
    todo = [d for d in optdata._trading_days(since, until) if d not in have]
    print(f"{len(todo)} days to fetch ({len(have)} already stored)", flush=True)
    t0, done, missing = time.time(), 0, []
    for d in todo:
        try:
            f = _file(d)
        except Exception as error:  # a bad file: note it, carry on
            print(d, "failed:", error, flush=True)
            missing.append(d)
            continue
        if f is None:
            missing.append(d)
            continue
        f = f[(f["contracts"] > 0) & (f["open"] > 0) & (f["high"] > 0) & (f["low"] > 0) & (f["close"] > 0)]
        rows = [(r.symbol, d, r.expiry, r.open, r.high, r.low, r.close, int(r.contracts)) for r in f.itertuples()]
        with connect() as conn, conn.cursor() as cur:
            execute_values(cur, "INSERT INTO fut_daily_nse (symbol, day, expiry, open, high, low, close, contracts) VALUES %s "
                                "ON CONFLICT (symbol, day, expiry) DO NOTHING", rows)
            conn.commit()
        done += 1
        if done % 50 == 0:
            rate = (time.time() - t0) / done
            print(f"{done}/{len(todo)} · {d} · {len(rows)} contracts · ~{rate * (len(todo) - done) / 60:.0f} min left", flush=True)
        time.sleep(0.4)  # gentle on NSE's archive
    print(f"done: {done} days, {len(missing)} without a file: {missing[:20]}", flush=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["download"]:
        a = [date.fromisoformat(x) for x in sys.argv[2:4]]
        download(*a)
