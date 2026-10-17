import numpy as np
import pandas as pd


def _truthy_price(value) -> bool:
    if value is None:
        return False
    try:
        if pd.isna(value):
            return False
    except (TypeError, ValueError):
        return False
    return True


def _as_float(value):
    if not _truthy_price(value):
        return np.nan
    return float(value)


def signal(df: pd.DataFrame, symbol: str = "") -> pd.DataFrame:
    # KBD1 - Key Breakout Day 1 - Trading Model
    # Author: Brent Penfold
    # When dow_cross occurs in the direction of the trend, enter a trade.
    # Exit with a trailing stop of high if bullish or low if bearish of the previous three candles.

    df_original = df.copy()
    df_original["kbdt"] = None
    df_original["tradingmodel"] = "kbdt"
    df_original["signal_price"] = np.nan
    df_original["stop_loss"] = np.nan
    if "symbol" not in df_original.columns:
        df_original["symbol"] = symbol
    elif symbol:
        df_original["symbol"] = df_original["symbol"].fillna(symbol)

    if len(df) < 3:
        return df_original

    df = df.copy()
    last = df.iloc[-1]
    prev = df.iloc[-2]
    direction = _as_float(last.get("direction"))
    dow_cross = last.get("dow_cross")
    lwv = last.get("lwv")

    if not _truthy_price(dow_cross) or direction not in (1.0, -1.0):
        return df_original

    # Weekly low-volatility filter (required by model)
    try:
        lwv_on = bool(int(lwv)) if _truthy_price(lwv) else False
    except (TypeError, ValueError):
        lwv_on = False
    if not lwv_on:
        return df_original

    if direction == 1.0:
        buy_price = float(dow_cross)
        sl_price = float(prev["low"])
        sell_price = np.nan

        for i in range(len(df) - 2, -1, -1):
            if _as_float(df.iloc[i]["direction"]) == -1.0 and _truthy_price(
                df.iloc[i]["dow_cross"]
            ):
                sell_price = float(df.iloc[i]["dow_cross"])
                break

        if not np.isnan(sell_price):
            profit_points = sell_price - buy_price
            if profit_points < 0:
                df_original.at[df.index[-1], "kbdt"] = "buy"
                df_original.at[df.index[-1], "signal_price"] = buy_price
                df_original.at[df.index[-1], "stop_loss"] = sl_price
                df_original.at[df.index[-1], "signal"] = True

    elif direction == -1.0:
        sell_price = float(dow_cross)
        sl_price = float(prev["high"])
        buy_price = np.nan

        for i in range(len(df) - 2, -1, -1):
            if _as_float(df.iloc[i]["direction"]) == 1.0 and _truthy_price(
                df.iloc[i]["dow_cross"]
            ):
                buy_price = float(df.iloc[i]["dow_cross"])
                break

        if not np.isnan(buy_price):
            profit_points = sell_price - buy_price
            if profit_points < 0:
                df_original.at[df.index[-1], "kbdt"] = "sell"
                df_original.at[df.index[-1], "signal_price"] = sell_price
                df_original.at[df.index[-1], "stop_loss"] = sl_price
                df_original.at[df.index[-1], "signal"] = True

    return df_original
