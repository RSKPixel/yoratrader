"""1-minute candles of the continuous NEAR-MONTH futures from Angel One SmartAPI, into fut_1m (one row per
future per day, like bt_1m). Angel One's historical API, asked for the current near-month contract's token,
returns the near-month series joined across expiries (checked: its daily closes equal our Kite continuous
futures, and its first minute equals the future's official open, not the share's). Stock futures from
about mid-2022, Nifty / Bank Nifty from 2016. Prices are as traded: NOT adjusted for splits or bonuses.

Run: venv/bin/python angel_fut.py   (resumes: months already stored are skipped). Read-only; no orders.
"""

import json
import sys
import time
from datetime import date, datetime, timedelta

import requests
from psycopg2.extras import execute_values

import angel_auth
from db import connect, schema_once

MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
HIST = "/rest/secure/angelbroking/historical/v1/getCandleData"
STOCKS_FROM, INDICES_FROM = date(2021, 6, 1), date(2016, 1, 1)
INDICES = ("NIFTY", "BANKNIFTY")
PAUSE = 1.0  # about one call a second: Angel One also caps calls per hour (a faster run was cut off after ~50 minutes)


@schema_once
def _ensure(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS fut_1m (
            symbol TEXT NOT NULL, day DATE NOT NULL,
            minute SMALLINT[] NOT NULL,  -- minutes since 09:15 (0 = the 09:15 candle)
            open REAL[] NOT NULL, high REAL[] NOT NULL, low REAL[] NOT NULL, close REAL[] NOT NULL,
            volume BIGINT[] NOT NULL,
            PRIMARY KEY (symbol, day)
        );
        CREATE TABLE IF NOT EXISTS fut_1m_done (symbol TEXT NOT NULL, month DATE NOT NULL, candles INTEGER, PRIMARY KEY (symbol, month));
        """
    )


def _tokens():
    """{name: near-month futures token} for today's F&O stocks and the two index futures."""
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol FROM bt_symbols WHERE dataset = 'fno'")
        stocks = {r[0] for r in cursor.fetchall()}
    master = requests.get(MASTER_URL, timeout=120).json()
    best = {}
    today = date.today()
    for r in master:
        if r.get("exch_seg") != "NFO" or r.get("instrumenttype") not in ("FUTSTK", "FUTIDX"):
            continue
        name = r["name"]
        if name not in stocks and name not in INDICES:
            continue
        exp = datetime.strptime(r["expiry"], "%d%b%Y").date()
        if exp >= today and (name not in best or exp < best[name][1]):
            best[name] = (r["token"], exp)
    return {k: v[0] for k, v in best.items()}


def _months(start, end):
    m = date(start.year, start.month, 1)
    while m <= end:
        yield m
        m = date(m.year + (m.month == 12), m.month % 12 + 1, 1)


def _fetch(token, a, b, tries=10):
    for i in range(tries):
        try:
            r = angel_auth.get(HIST, {"exchange": "NFO", "symboltoken": token, "interval": "ONE_MINUTE",
                                      "fromdate": a.strftime("%Y-%m-%d 09:15"), "todate": b.strftime("%Y-%m-%d 15:30")})
            if r.get("status") is False and "rate" in str(r.get("message", "")).lower():
                raise ValueError("rate limited")
            if r.get("errorcode") in ("AG8001", "AG8002"):  # an expired session: log in again
                angel_auth._session["jwt"] = None
                raise ValueError("session")
            return r.get("data") or []
        except Exception as error:
            time.sleep(min(600, 5 * 2 ** i))  # an hourly cap clears within the hour: wait up to 10 minutes a try
            if i >= 3:
                angel_auth._session["jwt"] = None  # and log in afresh
            last = error
    raise RuntimeError(f"failed after {tries} tries: {last}")


def _rows(name, candles):
    by_day = {}
    for ts, o, h, l, c, v in candles:
        t = datetime.fromisoformat(ts)
        m = (t.hour * 60 + t.minute) - (9 * 60 + 15)
        if 0 <= m <= 375:
            by_day.setdefault(t.date(), []).append((m, o, h, l, c, int(v or 0)))
    out = []
    for d, rows in by_day.items():
        rows.sort()
        out.append((name, d, [r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows],
                    [r[4] for r in rows], [r[5] for r in rows]))
    return out


def download(only=None):
    angel_auth.login()
    tokens = _tokens()
    names = sorted(tokens) if not only else [n for n in only if n in tokens]
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT symbol, month FROM fut_1m_done")
        done = {(s, m) for s, m in cursor.fetchall()}
    today = date.today()
    total = 0
    started = time.time()
    for k, name in enumerate(names, 1):
        start = INDICES_FROM if name in INDICES else STOCKS_FROM
        got = 0
        for m in _months(start, today):
            if (name, m) in done:
                continue
            end = min(date(m.year + (m.month == 12), m.month % 12 + 1, 1) - timedelta(days=1), today)
            mid = m + timedelta(days=15)  # two calls a month: Angel One returns at most 8000 candles a call (a full month is ~8600)
            candles = _fetch(tokens[name], m, min(mid - timedelta(days=1), end))
            time.sleep(PAUSE)
            if mid <= end:
                candles += _fetch(tokens[name], mid, end)
                time.sleep(PAUSE)
            if not candles and got:  # data stopped mid-series (seen after midnight: empty answers): log in again and retry once
                angel_auth._session["jwt"] = None
                time.sleep(30)
                candles = _fetch(tokens[name], m, min(mid - timedelta(days=1), end)) + (_fetch(tokens[name], mid, end) if mid <= end else [])
                if not candles:  # a real gap (e.g. out of F&O for a while) or a bad answer: leave the month open for a later run
                    print(f"  {name} {m:%Y-%m}: empty after earlier data, left open", flush=True)
                    continue
            rows = _rows(name, candles)
            with connect() as conn, conn.cursor() as cursor:
                if rows:
                    execute_values(cursor, "INSERT INTO fut_1m (symbol, day, minute, open, high, low, close, volume) VALUES %s "
                                           "ON CONFLICT (symbol, day) DO NOTHING", rows)
                if (m.year, m.month) != (today.year, today.month):  # the current month stays open for a later top-up
                    cursor.execute("INSERT INTO fut_1m_done (symbol, month, candles) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                                   (name, m, len(candles)))
                conn.commit()
            got += len(candles)
        total += got
        print(f"{datetime.now():%H:%M:%S} {k}/{len(names)} {name}: {got} candles · {total} total · {int(time.time() - started)}s", flush=True)
    return total


if __name__ == "__main__":
    print("fut_1m download:", download(sys.argv[1:] or None), "candles")
