"""Build and persist universaltrader enrichment for stored EOD bars."""

from contracts import list_contracts
from db import fetch_eod_frame, store_ut_eod
from enrich import enrich_eod


def build_ut_data(symbols, on_progress=None):
    wanted = {symbol.upper() for symbol in symbols}
    rows = [row for row in list_contracts("ALL") if row["name"].upper() in wanted]

    def report(**state):
        if on_progress:
            on_progress(state)

    if not rows:
        report(status="completed", done=0, total=0, symbol="", candles=0, errors=[])
        return {"symbols": 0, "candles": 0, "errors": []}

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
        try:
            frame = fetch_eod_frame(row["exchange"], row["name"])
            if frame.empty:
                errors.append(f"{row['name']}: no EOD bars")
                continue
            enriched = enrich_eod(frame, project=True)
            candles += store_ut_eod(row["exchange"], row["name"], enriched)
        except Exception as error:
            print(f"Error building UT data for {row['name']}:", error)
            errors.append(f"{row['name']}: {error}")

    report(
        status="completed",
        done=total,
        total=total,
        symbol="",
        candles=candles,
        errors=list(errors),
    )
    return {"symbols": total, "candles": candles, "errors": errors}
