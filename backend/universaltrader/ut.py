import pandas as pd

from . import kbdt

# Accept either label — upstream default was "KBD1" while the gate checked "KBDT".
KBDT_MODELS = {"KBDT", "KBD1", "kbdt", "kbd1"}


def signals2(ohlc: pd.DataFrame, models=None) -> pd.DataFrame:
    """Run trading models on an enriched OHLC frame (DatetimeIndex + UT columns).

    KBDT evaluates the *last* bar only (live-scanner style). Pass a growing
    window if you need historical signals.
    """
    if models is None:
        models = ["KBDT"]

    if ohlc is None or len(ohlc) < 3:
        return pd.DataFrame()

    df = ohlc.copy()
    if "datetime" not in df.columns:
        df["datetime"] = df.index
    df["datetime"] = pd.to_datetime(df["datetime"])
    df["signal"] = False

    if "swing_point" not in df.columns:
        return pd.DataFrame()

    recent_swings = df[df["swing_point"].notna()].tail(8)
    if recent_swings.empty:
        return pd.DataFrame()

    min_date = recent_swings.index.min()
    df = df[df.index >= min_date]
    if df.empty or len(df) < 3:
        return pd.DataFrame()

    numeric = df.select_dtypes(include="number").columns
    df[numeric] = df[numeric].round(4)
    symbol = df.iloc[0].get("symbol", "")
    if pd.isna(symbol):
        symbol = ""

    signals = pd.DataFrame()
    want_kbdt = any(model in KBDT_MODELS for model in models)
    if want_kbdt:
        result = kbdt.signal(df, symbol)
        hits = result[result["kbdt"].notna()].copy()
        if not hits.empty:
            hits["signal"] = hits["kbdt"]
            if "symbol" not in hits.columns or hits["symbol"].isna().all():
                hits["symbol"] = symbol
            signals = pd.concat([signals, hits], ignore_index=True)

    return signals
