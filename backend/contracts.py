import os
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from kiteconnect import KiteConnect

from db import store_instruments, stored_previous_expiries

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

# NSE futures trade on the NFO exchange. MCX futures trade on MCX.
EXCHANGES = {
    "NSE": ("NFO", "NFO-FUT"),
    "MCX": ("MCX", "MCX-FUT"),
}

_cache = {"at": None, "rows": None}
CACHE_FOR = timedelta(minutes=10)


def list_contracts(exchange: str = "ALL"):
    exchange = (exchange or "ALL").upper()
    if exchange != "ALL" and exchange not in EXCHANGES:
        raise ValueError(f"Unknown exchange: {exchange}")

    rows = _current_contracts()
    if exchange == "ALL":
        return rows
    return [row for row in rows if row["exchange"] == exchange]


def _current_contracts():
    if _cache["rows"] is not None and datetime.now() - _cache["at"] < CACHE_FOR:
        return _cache["rows"]

    api_key = os.environ.get("KITE_API_KEY", "")
    access_token = os.environ.get("KITE_ACCESS_TOKEN", "")
    if not api_key or not access_token:
        raise RuntimeError("KITE_API_KEY and KITE_ACCESS_TOKEN are required")

    kite = KiteConnect(api_key=api_key)
    kite.set_access_token(access_token)
    today = pd.Timestamp(date.today())
    known_previous = stored_previous_expiries()
    frames = []

    for label, (kite_exchange, segment) in EXCHANGES.items():
        frame = pd.DataFrame(kite.instruments(exchange=kite_exchange))
        frame["expiry"] = pd.to_datetime(frame["expiry"])
        futures = frame[
            (frame["instrument_type"] == "FUT") & (frame["segment"] == segment)
        ].copy()
        futures = futures.sort_values(["name", "expiry"])
        futures["previous_expiry"] = futures.groupby("name")["expiry"].shift(1)
        current = futures[futures["expiry"] >= today].groupby("name", as_index=False).head(1)
        current["exchange"] = label
        frames.append(current)

    contracts = pd.concat(frames, ignore_index=True).sort_values(["exchange", "name"])
    rows = [
        {
            "exchange": row.exchange,
            "name": row.name,
            "tradingsymbol": row.tradingsymbol,
            "expiry": row.expiry.strftime("%Y-%m-%d"),
            "previous_expiry": (
                None
                if pd.isna(row.previous_expiry)
                else row.previous_expiry.strftime("%Y-%m-%d")
            )
            or known_previous.get((row.exchange, row.name)),
            "lot_size": int(row.lot_size),
            "instrument_token": int(row.instrument_token),
        }
        for row in contracts.itertuples(index=False)
    ]
    try:
        store_instruments(rows)
    except Exception as error:
        print("Error storing instruments:", error)

    _cache["at"] = datetime.now()
    _cache["rows"] = rows
    return rows
