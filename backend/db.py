import os
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import execute_values

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)


def connect():
    return psycopg2.connect(
        host=os.environ["POSTGRES_HOST"],
        port=os.environ.get("POSTGRES_PORT", "5432"),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=os.environ["POSTGRES_DB"],
    )


def store_instruments(rows):
    if not rows:
        return

    loaded_at = datetime.now(timezone.utc)
    records = [
        (
            row["instrument_token"],
            row["exchange"],
            row["name"],
            row["tradingsymbol"],
            row["expiry"],
            row.get("previous_expiry"),
            row["lot_size"],
            loaded_at,
        )
        for row in rows
    ]
    tokens = [row["instrument_token"] for row in rows]

    with connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS instruments (
                    instrument_token BIGINT PRIMARY KEY,
                    exchange TEXT NOT NULL,
                    name TEXT NOT NULL,
                    tradingsymbol TEXT NOT NULL,
                    expiry DATE NOT NULL,
                    previous_expiry DATE,
                    lot_size INTEGER NOT NULL,
                    loaded_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            cursor.execute(
                "ALTER TABLE instruments ADD COLUMN IF NOT EXISTS previous_expiry DATE"
            )
            execute_values(
                cursor,
                """
                INSERT INTO instruments (
                    instrument_token,
                    exchange,
                    name,
                    tradingsymbol,
                    expiry,
                    previous_expiry,
                    lot_size,
                    loaded_at
                )
                VALUES %s
                ON CONFLICT (instrument_token) DO UPDATE SET
                    exchange = EXCLUDED.exchange,
                    name = EXCLUDED.name,
                    tradingsymbol = EXCLUDED.tradingsymbol,
                    expiry = EXCLUDED.expiry,
                    previous_expiry = EXCLUDED.previous_expiry,
                    lot_size = EXCLUDED.lot_size,
                    loaded_at = EXCLUDED.loaded_at
                """,
                records,
            )
            cursor.execute(
                """
                DELETE FROM instruments
                WHERE NOT (instrument_token = ANY(%s))
                  AND expiry >= CURRENT_DATE
                """,
                (tokens,),
            )
        conn.commit()


def stored_previous_expiries():
    """Latest expired contract date we have already kept for each script."""
    try:
        with connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT exchange, name, MAX(expiry)
                    FROM instruments
                    WHERE expiry < CURRENT_DATE
                    GROUP BY exchange, name
                    """
                )
                rows = cursor.fetchall()
    except Exception:
        return {}

    return {
        (exchange, name): expiry.isoformat()
        for exchange, name, expiry in rows
        if expiry is not None
    }


def store_eod(exchange, symbol, bars):
    if not bars:
        return 0

    records = [
        (
            exchange,
            symbol,
            bar["date"].date() if hasattr(bar["date"], "date") else bar["date"],
            bar["open"],
            bar["high"],
            bar["low"],
            bar["close"],
            int(bar.get("volume") or 0),
            int(bar.get("oi") or 0),
        )
        for bar in bars
    ]
    with connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS eod (
                    exchange TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    datetime DATE NOT NULL,
                    open DOUBLE PRECISION,
                    high DOUBLE PRECISION,
                    low DOUBLE PRECISION,
                    close DOUBLE PRECISION,
                    volume BIGINT,
                    oi BIGINT,
                    PRIMARY KEY (exchange, symbol, datetime)
                )
                """
            )
            execute_values(
                cursor,
                """
                INSERT INTO eod (
                    exchange, symbol, datetime, open, high, low, close, volume, oi
                )
                VALUES %s
                ON CONFLICT (exchange, symbol, datetime) DO UPDATE SET
                    open = EXCLUDED.open,
                    high = EXCLUDED.high,
                    low = EXCLUDED.low,
                    close = EXCLUDED.close,
                    volume = EXCLUDED.volume,
                    oi = EXCLUDED.oi
                """,
                records,
            )
        conn.commit()
    return len(records)


def fetch_candles(exchange, symbol, enrich=False):
    with connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT datetime, open, high, low, close, volume, oi
                FROM eod
                WHERE exchange = %s AND symbol = %s
                ORDER BY datetime ASC
                """,
                (exchange, symbol),
            )
            rows = cursor.fetchall()

    candles = [
        {
            "time": day.isoformat(),
            "open": float(open_),
            "high": float(high),
            "low": float(low),
            "close": float(close),
            "volume": int(volume or 0),
            "oi": int(oi or 0),
        }
        for day, open_, high, low, close, volume, oi in rows
    ]
    if not enrich:
        return candles

    from enrich import enrich_eod_records

    return enrich_eod_records(candles)


def fetch_eod_frame(exchange, symbol):
    """Load raw EOD bars as a DatetimeIndex OHLC DataFrame for enrichment."""
    import pandas as pd

    with connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT datetime, open, high, low, close, volume, oi
                FROM eod
                WHERE exchange = %s AND symbol = %s
                ORDER BY datetime ASC
                """,
                (exchange, symbol),
            )
            rows = cursor.fetchall()

    frame = pd.DataFrame(
        rows, columns=["datetime", "open", "high", "low", "close", "volume", "oi"]
    )
    if frame.empty:
        return frame
    frame["datetime"] = pd.to_datetime(frame["datetime"])
    frame = frame.set_index("datetime").sort_index()
    frame["symbol"] = symbol
    frame["exchange"] = exchange
    return frame


def _ensure_eod_ut(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS eod_ut (
            exchange TEXT NOT NULL,
            symbol TEXT NOT NULL,
            datetime DATE NOT NULL,
            open DOUBLE PRECISION,
            high DOUBLE PRECISION,
            low DOUBLE PRECISION,
            close DOUBLE PRECISION,
            volume BIGINT,
            oi BIGINT,
            bar_type TEXT,
            swing_high DOUBLE PRECISION,
            swing_low DOUBLE PRECISION,
            swing_point DOUBLE PRECISION,
            direction DOUBLE PRECISION,
            intersection DOUBLE PRECISION,
            dow_cross DOUBLE PRECISION,
            dow_point DOUBLE PRECISION,
            mvf DOUBLE PRECISION,
            ldv DOUBLE PRECISION,
            lwv DOUBLE PRECISION,
            atr DOUBLE PRECISION,
            sma200 DOUBLE PRECISION,
            PRIMARY KEY (exchange, symbol, datetime)
        )
        """
    )


def _ut_num(value):
    if value is None:
        return None
    try:
        import math

        import pandas as pd

        if pd.isna(value):
            return None
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    except (TypeError, ValueError):
        return None


def store_ut_eod(exchange, symbol, enriched):
    """Replace stored UT enrichment for one symbol from an enriched DataFrame."""
    import pandas as pd

    if enriched is None or len(enriched) == 0:
        return 0

    records = []
    for _, row in enriched.iterrows():
        day = row["datetime"]
        if hasattr(day, "date"):
            day = day.date()
        elif isinstance(day, str):
            day = pd.to_datetime(day).date()
        records.append(
            (
                exchange,
                symbol,
                day,
                _ut_num(row.get("open")),
                _ut_num(row.get("high")),
                _ut_num(row.get("low")),
                _ut_num(row.get("close")),
                int(row.get("volume") or 0),
                int(row.get("oi") or 0),
                None if pd.isna(row.get("bar_type")) else str(row.get("bar_type") or ""),
                _ut_num(row.get("swing_high")),
                _ut_num(row.get("swing_low")),
                _ut_num(row.get("swing_point")),
                _ut_num(row.get("direction")),
                _ut_num(row.get("intersection")),
                _ut_num(row.get("dow_cross")),
                _ut_num(row.get("dow_point")),
                _ut_num(row.get("mvf")),
                _ut_num(row.get("ldv")),
                _ut_num(row.get("lwv")),
                _ut_num(row.get("atr")),
                _ut_num(row.get("sma200")),
            )
        )

    with connect() as conn:
        with conn.cursor() as cursor:
            _ensure_eod_ut(cursor)
            cursor.execute(
                "DELETE FROM eod_ut WHERE exchange = %s AND symbol = %s",
                (exchange, symbol),
            )
            execute_values(
                cursor,
                """
                INSERT INTO eod_ut (
                    exchange, symbol, datetime,
                    open, high, low, close, volume, oi,
                    bar_type, swing_high, swing_low, swing_point,
                    direction, intersection, dow_cross, dow_point,
                    mvf, ldv, lwv, atr, sma200
                )
                VALUES %s
                """,
                records,
            )
        conn.commit()
    return len(records)


def fetch_ut_rows(exchange, symbol):
    with connect() as conn:
        with conn.cursor() as cursor:
            _ensure_eod_ut(cursor)
            cursor.execute(
                """
                SELECT
                    datetime, open, high, low, close, volume, oi,
                    bar_type, swing_high, swing_low, swing_point,
                    direction, intersection, dow_cross, dow_point,
                    mvf, ldv, lwv, atr, sma200
                FROM eod_ut
                WHERE exchange = %s AND symbol = %s
                ORDER BY datetime ASC
                """,
                (exchange, symbol),
            )
            rows = cursor.fetchall()

    def cell(value):
        if value is None:
            return None
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return float(value) if isinstance(value, (int, float)) else value

    return [
        {
            "time": day.isoformat(),
            "open": cell(open_),
            "high": cell(high),
            "low": cell(low),
            "close": cell(close),
            "volume": int(volume or 0),
            "oi": int(oi or 0),
            "bar_type": bar_type or None,
            "swing_high": cell(swing_high),
            "swing_low": cell(swing_low),
            "swing_point": cell(swing_point),
            "direction": cell(direction),
            "intersection": cell(intersection),
            "dow_cross": cell(dow_cross),
            "dow_point": cell(dow_point),
            "mvf": cell(mvf),
            "ldv": cell(ldv),
            "lwv": cell(lwv),
            "atr": cell(atr),
            "sma200": cell(sma200),
        }
        for (
            day,
            open_,
            high,
            low,
            close,
            volume,
            oi,
            bar_type,
            swing_high,
            swing_low,
            swing_point,
            direction,
            intersection,
            dow_cross,
            dow_point,
            mvf,
            ldv,
            lwv,
            atr,
            sma200,
        ) in rows
    ]


def ut_bar_counts():
    """Map (exchange, symbol) -> number of stored UT rows."""
    try:
        with connect() as conn:
            with conn.cursor() as cursor:
                _ensure_eod_ut(cursor)
                cursor.execute(
                    """
                    SELECT exchange, symbol, COUNT(*)
                    FROM eod_ut
                    GROUP BY exchange, symbol
                    """
                )
                rows = cursor.fetchall()
    except Exception:
        return {}

    return {(exchange, symbol): int(count) for exchange, symbol, count in rows}


def fetch_ut_frame(exchange, symbol):
    """Load stored UT enrichment as a DatetimeIndex frame for signals2."""
    import pandas as pd

    rows = fetch_ut_rows(exchange, symbol)
    if not rows:
        return pd.DataFrame()

    frame = pd.DataFrame(rows)
    frame["datetime"] = pd.to_datetime(frame["time"])
    frame = frame.drop(columns=["time"])
    frame = frame.set_index("datetime").sort_index()
    frame["datetime"] = frame.index
    frame["symbol"] = symbol
    frame["exchange"] = exchange
    return frame


def _ensure_kbdt_signals(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS kbdt_signals (
            exchange TEXT NOT NULL,
            symbol TEXT NOT NULL,
            datetime DATE NOT NULL,
            signal TEXT NOT NULL,
            signal_price DOUBLE PRECISION,
            stop_loss DOUBLE PRECISION,
            close DOUBLE PRECISION,
            direction DOUBLE PRECISION,
            lwv DOUBLE PRECISION,
            lot_size INTEGER,
            scanned_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (exchange, symbol, datetime, signal)
        )
        """
    )
    cursor.execute(
        "ALTER TABLE kbdt_signals ADD COLUMN IF NOT EXISTS lot_size INTEGER"
    )


def replace_kbdt_signals(rows, scope_keys=None):
    """Replace KBDT signals.

    scope_keys: optional list of (exchange, symbol) that were scanned.
    When set, only those symbols are cleared before insert (partial scan).
    When None, the full table is replaced.
    """
    from datetime import datetime, timezone

    scanned_at = datetime.now(timezone.utc)
    records = [
        (
            row["exchange"],
            row["symbol"],
            row["datetime"],
            row["signal"],
            row.get("signal_price"),
            row.get("stop_loss"),
            row.get("close"),
            row.get("direction"),
            row.get("lwv"),
            row.get("lot_size"),
            scanned_at,
        )
        for row in rows
    ]

    with connect() as conn:
        with conn.cursor() as cursor:
            _ensure_kbdt_signals(cursor)
            if scope_keys is None:
                cursor.execute("DELETE FROM kbdt_signals")
            elif scope_keys:
                for exchange, symbol in scope_keys:
                    cursor.execute(
                        "DELETE FROM kbdt_signals WHERE exchange = %s AND symbol = %s",
                        (exchange, symbol),
                    )
            if records:
                execute_values(
                    cursor,
                    """
                    INSERT INTO kbdt_signals (
                        exchange, symbol, datetime, signal,
                        signal_price, stop_loss, close, direction, lwv, lot_size, scanned_at
                    )
                    VALUES %s
                    ON CONFLICT (exchange, symbol, datetime, signal) DO UPDATE SET
                        signal_price = EXCLUDED.signal_price,
                        stop_loss = EXCLUDED.stop_loss,
                        close = EXCLUDED.close,
                        direction = EXCLUDED.direction,
                        lwv = EXCLUDED.lwv,
                        lot_size = EXCLUDED.lot_size,
                        scanned_at = EXCLUDED.scanned_at
                    """,
                    records,
                )
        conn.commit()
    return len(records)


def fetch_kbdt_signals():
    with connect() as conn:
        with conn.cursor() as cursor:
            _ensure_kbdt_signals(cursor)
            cursor.execute(
                """
                SELECT
                    exchange, symbol, datetime, signal,
                    signal_price, stop_loss, close, direction, lwv, lot_size, scanned_at
                FROM kbdt_signals
                ORDER BY datetime DESC, symbol ASC
                """
            )
            rows = cursor.fetchall()

    return [
        {
            "exchange": exchange,
            "symbol": symbol,
            "datetime": day.isoformat(),
            "signal": signal,
            "signal_price": float(signal_price) if signal_price is not None else None,
            "stop_loss": float(stop_loss) if stop_loss is not None else None,
            "close": float(close) if close is not None else None,
            "direction": float(direction) if direction is not None else None,
            "lwv": float(lwv) if lwv is not None else None,
            "lot_size": int(lot_size) if lot_size is not None else None,
            "scanned_at": scanned_at.isoformat() if scanned_at is not None else None,
        }
        for (
            exchange,
            symbol,
            day,
            signal,
            signal_price,
            stop_loss,
            close,
            direction,
            lwv,
            lot_size,
            scanned_at,
        ) in rows
    ]
