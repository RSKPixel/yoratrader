import os
import time
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv
from kiteconnect import KiteConnect

from contracts import list_contracts
from db import store_eod

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)


def download_eod(symbols, on_progress=None):
    wanted = {symbol.upper() for symbol in symbols}
    rows = [row for row in list_contracts("ALL") if row["name"].upper() in wanted]

    def report(**state):
        if on_progress:
            on_progress(state)

    if not rows:
        report(status="completed", done=0, total=0, symbol="", candles=0, errors=[])
        return {"symbols": 0, "candles": 0, "errors": []}

    api_key = os.environ.get("KITE_API_KEY", "")
    access_token = os.environ.get("KITE_ACCESS_TOKEN", "")
    if not api_key or not access_token:
        raise RuntimeError("KITE_API_KEY and KITE_ACCESS_TOKEN are required")

    kite = KiteConnect(api_key=api_key)
    kite.set_access_token(access_token)
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
        # Pull from the previous expiry to today; without one, fall back to the last 30 days.
        if row.get("previous_expiry"):
            from_date = row["previous_expiry"]
        else:
            from_date = (today - timedelta(days=30)).isoformat()
        to_date = today.isoformat()

        try:
            bars = kite.historical_data(
                row["instrument_token"],
                from_date=from_date,
                to_date=to_date,
                interval="day",
                continuous=True,
                oi=True,
            )
            candles += store_eod(row["exchange"], row["name"], bars or [])
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
