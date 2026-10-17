"""Attach universaltrader columns onto YoraTrader EOD OHLC frames.

Indicators are computed on read (not stored in Postgres). SSC/Dow Theory
rewrite history as new bars arrive, so denormalizing into `eod` is a poor fit.

Expected input:
  - DatetimeIndex (sorted ascending), or a `datetime` / `date` column
  - Columns: open, high, low, close  (volume / oi / symbol optional)

Adds (same pipeline as ut-intraday `data.history`):
  bar_type, swing, swing_point, swing_high, swing_low,
  direction, peak, trough, intersection, dow_cross, dow_point,
  mvf, ldv, atr, sma200, weekly_*, lwv
"""

from __future__ import annotations

import math

import pandas as pd

from universaltrader.ssc import SwingPoints2
from universaltrader.tools import atr, asc, ddt2, lv, sma, weekly_rdata

ENRICHED_COLUMNS = [
    "datetime",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "oi",
    "bar_type",
    "swing_high",
    "swing_low",
    "swing_point",
    "direction",
    "intersection",
    "dow_cross",
    "dow_point",
    "mvf",
    "ldv",
    "lwv",
    "atr",
    "sma200",
]

# Warmup for ASC(20), ATR(20), LV(4), SMA(200), weekly LV(4)
MIN_BARS_FOR_FULL_ENRICH = 200


def _as_ohlc_frame(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    if not isinstance(frame.index, pd.DatetimeIndex):
        if "datetime" in frame.columns:
            frame["datetime"] = pd.to_datetime(frame["datetime"])
            frame = frame.set_index("datetime")
        elif "date" in frame.columns:
            frame["date"] = pd.to_datetime(frame["date"])
            frame = frame.set_index("date")
        else:
            raise ValueError("EOD frame needs a DatetimeIndex or datetime/date column")

    frame.index = pd.to_datetime(frame.index)
    frame = frame.sort_index()
    required = {"open", "high", "low", "close"}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"EOD frame missing columns: {sorted(missing)}")
    return frame


def enrich_eod(df: pd.DataFrame, project: bool = True) -> pd.DataFrame:
    """Run SSC → Dow Theory → MVF/LDV/ATR/SMA200 → weekly LV on an OHLC frame."""
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=ENRICHED_COLUMNS)

    frame = _as_ohlc_frame(df)
    if len(frame) < 2:
        # Not enough bars for swing / Dow walks
        out = frame.copy()
        out["datetime"] = out.index
        if project:
            for column in ENRICHED_COLUMNS:
                if column not in out.columns:
                    out[column] = None
            return out[ENRICHED_COLUMNS]
        return out

    frame = SwingPoints2(frame)
    frame = ddt2(frame)

    ascending = asc(frame["close"], lookback=20)
    frame["mvf"] = (ascending - frame["low"]) / ascending * 100
    frame["ldv"] = lv(frame["high"], frame["low"], frame["close"], lookback=4)
    frame["atr"] = atr(frame["high"], frame["low"], frame["close"], lookback=20)
    frame["sma200"] = sma(frame["close"], lookback=200)
    frame = weekly_rdata(frame)
    frame["datetime"] = frame.index

    if not project:
        return frame

    for column in ENRICHED_COLUMNS:
        if column not in frame.columns:
            frame[column] = None

    return frame[ENRICHED_COLUMNS]


def _json_safe(value):
    if value is None:
        return None
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


def enrich_eod_records(rows: list[dict]) -> list[dict]:
    """Enrich chart/API candle dicts ({time, open, high, low, close, volume})."""
    if not rows:
        return []

    frame = pd.DataFrame(rows)
    frame = frame.rename(columns={"time": "datetime"})
    enriched = enrich_eod(frame, project=True)

    records = []
    for _, row in enriched.iterrows():
        day = row["datetime"]
        time_value = day.date().isoformat() if hasattr(day, "date") else str(day)[:10]
        records.append(
            {
                "time": time_value,
                "open": _json_safe(row.get("open")),
                "high": _json_safe(row.get("high")),
                "low": _json_safe(row.get("low")),
                "close": _json_safe(row.get("close")),
                "volume": int(row.get("volume") or 0),
                "oi": int(row.get("oi") or 0) if "oi" in enriched.columns else 0,
                "bar_type": _json_safe(row.get("bar_type")),
                "swing_high": _json_safe(row.get("swing_high")),
                "swing_low": _json_safe(row.get("swing_low")),
                "swing_point": _json_safe(row.get("swing_point")),
                "direction": _json_safe(row.get("direction")),
                "intersection": _json_safe(row.get("intersection")),
                "dow_cross": _json_safe(row.get("dow_cross")),
                "dow_point": _json_safe(row.get("dow_point")),
                "mvf": _json_safe(row.get("mvf")),
                "ldv": _json_safe(row.get("ldv")),
                "lwv": _json_safe(row.get("lwv")),
                "atr": _json_safe(row.get("atr")),
                "sma200": _json_safe(row.get("sma200")),
            }
        )
    return records
