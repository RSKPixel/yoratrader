"""Scan Indian Market UT datasets with universaltrader.signals2 (KBDT)."""

from __future__ import annotations

import pandas as pd

from contracts import list_contracts
from db import fetch_eod_frame, fetch_ut_frame, replace_kbdt_signals
from enrich import enrich_eod
from universaltrader.ut import signals2


def _load_enriched(exchange: str, symbol: str) -> pd.DataFrame:
    frame = fetch_ut_frame(exchange, symbol)
    if frame is not None and not frame.empty:
        return frame
    raw = fetch_eod_frame(exchange, symbol)
    if raw.empty:
        return raw
    enriched = enrich_eod(raw, project=False)
    enriched["symbol"] = symbol
    enriched["exchange"] = exchange
    if "datetime" not in enriched.columns:
        enriched["datetime"] = enriched.index
    return enriched


def _signal_rows(exchange: str, symbol: str, hits: pd.DataFrame, lot_size=None) -> list[dict]:
    rows = []
    for _, hit in hits.iterrows():
        day = hit.get("datetime")
        if hasattr(day, "date"):
            day = day.date().isoformat()
        elif day is not None:
            day = str(day)[:10]
        else:
            continue
        side = hit.get("kbdt") or hit.get("signal")
        if not side:
            continue
        rows.append(
            {
                "exchange": exchange,
                "symbol": symbol,
                "datetime": day,
                "signal": str(side).lower(),
                "lot_size": int(lot_size) if lot_size is not None else None,
                "signal_price": float(hit["signal_price"])
                if pd.notna(hit.get("signal_price"))
                else None,
                "stop_loss": float(hit["stop_loss"])
                if pd.notna(hit.get("stop_loss"))
                else None,
                "close": float(hit["close"]) if pd.notna(hit.get("close")) else None,
                "direction": float(hit["direction"])
                if pd.notna(hit.get("direction"))
                else None,
                "lwv": float(hit["lwv"]) if pd.notna(hit.get("lwv")) else None,
            }
        )
    return rows


def scan_kbdt(symbols=None, history_bars: int = 1, on_progress=None):
    """Run KBDT via signals2 across contracts.

    history_bars=1 → last-bar scanner (ut-intraday style).
    history_bars>1 → walk the last N bars for recent historical signals.
    """
    contracts = list_contracts("ALL")
    if symbols:
        wanted = {name.upper() for name in symbols}
        contracts = [row for row in contracts if row["name"].upper() in wanted]

    def report(**state):
        if on_progress:
            on_progress(state)

    total = len(contracts)
    if total == 0:
        report(status="completed", done=0, total=0, symbol="", signals=0, errors=[])
        return {"symbols": 0, "signals": 0, "errors": []}

    history_bars = max(1, int(history_bars or 1))
    collected = []
    errors = []

    for index, contract in enumerate(contracts):
        exchange = contract["exchange"]
        symbol = contract["name"]
        report(
            status="running",
            done=index,
            total=total,
            symbol=symbol,
            signals=len(collected),
            errors=list(errors),
        )
        try:
            frame = _load_enriched(exchange, symbol)
            if frame is None or len(frame) < 3:
                continue

            lot_size = contract.get("lot_size")
            if history_bars <= 1:
                hits = signals2(frame, models=["KBDT"])
                collected.extend(_signal_rows(exchange, symbol, hits, lot_size=lot_size))
            else:
                start = max(3, len(frame) - history_bars + 1)
                seen = set()
                for end in range(start, len(frame) + 1):
                    window = frame.iloc[:end]
                    hits = signals2(window, models=["KBDT"])
                    for row in _signal_rows(exchange, symbol, hits, lot_size=lot_size):
                        key = (row["exchange"], row["symbol"], row["datetime"], row["signal"])
                        if key in seen:
                            continue
                        seen.add(key)
                        collected.append(row)
        except Exception as error:
            print(f"Error scanning KBDT for {symbol}:", error)
            errors.append(f"{symbol}: {error}")

    scope = [(row["exchange"], row["name"]) for row in contracts]
    # Full market scan replaces everything; filtered scan only those symbols.
    replace_kbdt_signals(
        collected,
        scope_keys=None if symbols is None else scope,
    )
    report(
        status="completed",
        done=total,
        total=total,
        symbol="",
        signals=len(collected),
        errors=list(errors),
    )
    return {"symbols": total, "signals": len(collected), "errors": errors}
