import time
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

import kite_auth
from contracts import list_contracts
from db import store_intraday

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

INTERVAL = "15minute"
MAX_DAYS = 7


def download_intraday(symbols, on_progress=None, today_only=False, exchange=None):
    wanted = {symbol.upper() for symbol in symbols}
    rows = [
        row
        for row in list_contracts("ALL")
        if row["name"].upper() in wanted and (exchange is None or row["exchange"] == exchange)
    ]

    def report(**state):
        if on_progress:
            on_progress(state)

    if not rows:
        report(status="completed", done=0, total=0, symbol="", candles=0, errors=[])
        return {"symbols": 0, "candles": 0, "errors": []}

    kite = kite_auth.trading_client()
    today = date.today()
    floor = today - timedelta(days=MAX_DAYS)
    candles = 0
    errors = []
    total = len(rows)

    for index, row in enumerate(rows):
        report(status="running", done=index, total=total, symbol=row["name"], candles=candles, errors=list(errors))
        # Shorter of: previous expiry -> today, or the last 7 days.
        from_day = floor
        if today_only:
            from_day = today
        elif row.get("previous_expiry"):
            from_day = max(floor, date.fromisoformat(row["previous_expiry"]))
        to_time = datetime.combine(today, datetime.max.time()).replace(microsecond=0)

        try:
            bars = kite.historical_data(
                row["instrument_token"],
                from_date=datetime.combine(from_day, datetime.min.time()),
                to_date=to_time,
                interval=INTERVAL,
                # Kite only allows continuous for day bars; the window never crosses
                # the previous expiry, so the current contract covers it.
                oi=True,
            )
            candles += store_intraday(row["exchange"], row["name"], bars or [])
        except Exception as error:
            print(f"Error downloading intraday for {row['name']}:", error)
            errors.append(f"{row['name']}: {error}")

        if index < len(rows) - 1:
            time.sleep(0.35)

    report(status="completed", done=total, total=total, symbol="", candles=candles, errors=list(errors))
    return {"symbols": total, "candles": candles, "errors": errors}
