import time
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv

import kite_auth
from contracts import list_contracts
from db import store_eod

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)


RECENT_DAYS = 30  # the regular download: the last 30 days, continuous
FULL_FROM = date(2010, 1, 1)  # full history: Kite's continuous daily futures start around Oct 2010
CHUNK_DAYS = 1900  # Kite allows at most 2000 days per historical request


def download_eod(symbols, on_progress=None, full=False):
    """Continuous daily candles (with OI) for the futures named: the last RECENT_DAYS, or with
    full=True everything from FULL_FROM in CHUNK_DAYS pieces. Stored rows are upserted, so a full
    download fills any gaps and a regular one tops up the latest days."""
    wanted = {symbol.upper() for symbol in symbols}
    rows = [row for row in list_contracts("ALL") if row["name"].upper() in wanted]

    def report(**state):
        if on_progress:
            on_progress(state)

    if not rows:
        report(status="completed", done=0, total=0, symbol="", candles=0, errors=[])
        return {"symbols": 0, "candles": 0, "errors": []}

    kite = kite_auth.trading_client()
    today = date.today()
    candles = 0
    errors = []
    total = len(rows)

    for index, row in enumerate(rows):
        report(
            status="running",
            done=index,
            total=total,
            symbol=row["name"],
            candles=candles,
            errors=list(errors),
        )
        start = FULL_FROM if full else today - timedelta(days=RECENT_DAYS)
        windows = []
        while start <= today:
            end = min(today, start + timedelta(days=CHUNK_DAYS - 1))
            windows.append((start, end))
            start = end + timedelta(days=1)
        try:
            for i, (a, b) in enumerate(windows):
                bars = kite.historical_data(
                    row["instrument_token"],
                    from_date=a.isoformat(),
                    to_date=b.isoformat(),
                    interval="day",
                    continuous=True,
                    oi=True,
                )
                candles += store_eod(row["exchange"], row["name"], bars or [])
                if i < len(windows) - 1:
                    time.sleep(0.35)
        except Exception as error:
            print(f"Error downloading EOD for {row['name']}:", error)
            errors.append(f"{row['name']}: {error}")

        if index < len(rows) - 1:
            time.sleep(0.35)

    report(
        status="completed",
        done=total,
        total=total,
        symbol="",
        candles=candles,
        errors=list(errors),
    )
    return {"symbols": total, "candles": candles, "errors": errors}
