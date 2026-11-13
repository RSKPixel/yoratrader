"""1-minute candles for the F&O stocks, one row per symbol and day.

Plain Postgres, no TimescaleDB: each row holds that day's minute candles as arrays (minute of the
session, open/high/low/close as float4, volume). About 630k rows for 218 stocks since 2015 instead
of ~237M one-row-per-candle rows; Postgres compresses the arrays (TOAST), and every analysis here
reads whole stock-days anyway.

Kite serves at most 60 days of minute candles per request; the download is resumable (each symbol
continues from its last stored day) and stops on an expired login.
"""

import time
from datetime import date, datetime, timedelta
from datetime import time as clock

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

import backtest
import kite_auth
from db import connect

FROM = date(2015, 1, 1)
CHUNK_DAYS = 60
SESSION_START = 9 * 60 + 15  # minute index 0 = 09:15


def ensure_table(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bt_1m (
            symbol TEXT NOT NULL,
            day DATE NOT NULL,
            minute SMALLINT[] NOT NULL,  -- minutes since 09:15 (0 = the 09:15 candle)
            open REAL[] NOT NULL, high REAL[] NOT NULL, low REAL[] NOT NULL, close REAL[] NOT NULL,
            volume BIGINT[] NOT NULL,
            PRIMARY KEY (symbol, day)
        );
        """
    )
    # Some minutes' volume overflows int4: the first version used INTEGER[].
    cursor.execute(
        """
        DO $$ BEGIN
          IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'bt_1m' AND column_name = 'volume')
             = 'ARRAY' AND (SELECT udt_name FROM information_schema.columns WHERE table_name = 'bt_1m'
                            AND column_name = 'volume') = '_int4' THEN
            ALTER TABLE bt_1m ALTER COLUMN volume TYPE BIGINT[];
          END IF;
        END $$;
        """
    )


def _rows(symbol, bars):
    """Group Kite minute candles into one (symbol, day, arrays...) row per day."""
    by_day = {}
    for b in bars:
        ts = b["date"]
        by_day.setdefault(ts.date(), {})[ts.hour * 60 + ts.minute - SESSION_START] = b  # last one wins on duplicates
    rows = []
    for day, mins in sorted(by_day.items()):
        keys = sorted(mins)
        rows.append((symbol, day, keys, [mins[k]["open"] for k in keys], [mins[k]["high"] for k in keys],
                     [mins[k]["low"] for k in keys], [mins[k]["close"] for k in keys],
                     [int(mins[k].get("volume") or 0) for k in keys]))
    return rows


def _store(cursor, rows):
    execute_values(
        cursor,
        "INSERT INTO bt_1m (symbol, day, minute, open, high, low, close, volume) VALUES %s "
        "ON CONFLICT (symbol, day) DO UPDATE SET minute = EXCLUDED.minute, open = EXCLUDED.open, "
        "high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume",
        rows, template="(%s, %s, %s::smallint[], %s::real[], %s::real[], %s::real[], %s::real[], %s::bigint[])",
        page_size=200,
    )


def download(symbols=None, start=FROM, on_progress=None):
    """Fetch or top up minute candles for the F&O stocks (all of them by default)."""
    kite = kite_auth.trading_client()
    tokens = {r["tradingsymbol"]: r["instrument_token"] for r in kite.instruments("NSE") if r["segment"] == "NSE"}
    with connect() as conn, conn.cursor() as cursor:
        ensure_table(cursor)
        conn.commit()
        if symbols is None:
            cursor.execute("SELECT symbol FROM bt_symbols WHERE dataset = 'fno' ORDER BY symbol")
            symbols = [r[0] for r in cursor.fetchall()]
    today = date.today()
    errors, total_days = [], 0
    for i, symbol in enumerate(symbols):
        token = tokens.get(symbol)
        if token is None:
            errors.append(f"{symbol}: not in Kite instruments")
            continue
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("SELECT max(day) FROM bt_1m WHERE symbol = %s", (symbol,))
            last = cursor.fetchone()[0]
        cursor_day = last if last else start  # re-fetch the last stored day: it may have been partial
        while cursor_day <= today:
            stop = min(today, cursor_day + timedelta(days=CHUNK_DAYS - 1))
            if on_progress:
                on_progress({"done": i, "total": len(symbols), "symbol": symbol, "chunk": cursor_day.isoformat(),
                             "days": total_days, "errors": len(errors)})
            bars = []
            for attempt in range(5):  # "Too many requests" and network blips: back off and retry
                try:
                    bars = kite.historical_data(token, datetime.combine(cursor_day, clock(9, 0)),
                                                datetime.combine(stop, clock(15, 30)), "minute")
                    break
                except Exception as error:
                    if "access_token" in str(error) or "api_key" in str(error):
                        raise
                    if attempt == 4:
                        errors.append(f"{symbol} {cursor_day}: {error}")
                    time.sleep(2 * (attempt + 1))
            time.sleep(backtest.PAUSE)
            if bars:
                rows = _rows(symbol, bars)
                with connect() as conn, conn.cursor() as cursor:
                    _store(cursor, rows)
                    conn.commit()
                total_days += len(rows)
            cursor_day = stop + timedelta(days=1)
    return {"symbols": len(symbols), "days": total_days, "errors": errors}


def load_day(symbol, day):
    """One stock-day as a DataFrame indexed by IST time (09:15, 09:16, ...), or None."""
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT minute, open, high, low, close, volume FROM bt_1m WHERE symbol = %s AND day = %s",
                       (symbol, day))
        row = cursor.fetchone()
    if row is None:
        return None
    mins = np.array(row[0], dtype=int) + SESSION_START
    index = [datetime.combine(day, clock(m // 60, m % 60)) for m in mins]
    return pd.DataFrame({"open": row[1], "high": row[2], "low": row[3], "close": row[4], "volume": row[5]}, index=index)
