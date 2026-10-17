import numpy as np
import pandas as pd


def ddt2(data: pd.DataFrame) -> pd.DataFrame:
    df = data.copy()

    df["direction"] = np.nan
    df["dow_point"] = np.nan
    df["peak"] = np.nan
    df["trough"] = np.nan
    df["intersection"] = np.nan
    df["dow_cross"] = np.nan

    n = len(df)
    dow_point = None
    direction = 0
    swing_high = 0
    swing_low = 0

    if df.iloc[0]["swing"] == "high":
        dow_point = df.iloc[0]["swing_point"]
        swing_high = dow_point
        direction = 1
    elif df.iloc[0]["swing"] == "low":
        dow_point = df.iloc[0]["swing_point"]
        swing_low = dow_point
        direction = -1

    for d in range(1, n):

        if direction == 0:
            if df.iloc[d]["swing"] == "high":
                dow_point = df.iloc[d]["swing_point"]
                swing_high = dow_point
                direction = 1
            elif df.iloc[d]["swing"] == "low":
                dow_point = df.iloc[d]["swing_point"]
                swing_low = dow_point
                direction = -1

            if direction == 0:
                continue

        swing_low = (
            df.iloc[d]["swing_point"] if df.iloc[d]["swing"] == "low" else swing_low
        )
        swing_high = (
            df.iloc[d]["swing_point"] if df.iloc[d]["swing"] == "high" else swing_high
        )
        df.at[df.index[d], "direction"] = direction
        df.at[df.index[d], "dow_point"] = dow_point
        h = df.iloc[d]["high"]
        l = df.iloc[d]["low"]

        if h >= dow_point and direction == 1:
            direction = -1
            df.at[df.index[d], "intersection"] = dow_point
            df.at[df.index[d], "dow_cross"] = dow_point
        elif l <= dow_point and direction == -1:
            direction = 1
            df.at[df.index[d], "intersection"] = dow_point
            df.at[df.index[d], "dow_cross"] = dow_point

        if direction == -1:
            dow_point = swing_low
            # df.at[df.index[d - 1], "trough"] = dow_point
            df.at[df.index[d], "trough"] = dow_point
        elif direction == 1:
            dow_point = swing_high
            # df.at[df.index[d - 1], "peak"] = dow_point

            df.at[df.index[d], "peak"] = dow_point

    return df


def asc(close: pd.Series, lookback=20) -> pd.Series:
    n = len(close)
    seq_close = np.full(n, np.nan)
    seq_hl = np.where(close > close.shift(-1), True, False)

    for d in range(n):

        if d < lookback - 1:
            continue

        lookarea = close[d - lookback + 1 : d + 1]
        seq_cond = seq_hl[d - lookback + 1 : d + 1]

        if close.iloc[d] > close.iloc[d - lookback + 1]:
            seq_close[d] = close.iloc[d]
            continue

        seq_closes = []
        found_high = False
        i = 0

        try:
            for i in range(0, len(lookarea) - 1, 1):
                if found_high and not seq_hl[i]:
                    break

                if seq_cond[i]:
                    found_high = True

                if found_high:
                    seq_closes.append(lookarea.iloc[i])

            if seq_closes:
                seq_close[d] = max(seq_closes)
        except Exception as e:
            print("Exception by ACC", e, len(close))

    return pd.Series(seq_close, index=close.index)


def lv(high: pd.Series, low: pd.Series, close: pd.Series, lookback=4) -> pd.Series:
    """Low Volatility (LV) = 1 when lookback close range <= lookback ATR"""

    # ATR
    prev_close = close.shift(1)
    true_high = pd.concat([high, prev_close], axis=1).max(axis=1)
    true_low = pd.concat([low, prev_close], axis=1).min(axis=1)
    tr = true_high - true_low
    atr = tr.rolling(lookback).mean()

    # CLOSE RANGE
    cr = close.rolling(lookback).max() - close.rolling(lookback).min()

    # LV VALUE
    lv_value = (cr <= atr).astype(int)

    return lv_value


def atr(high: pd.Series, low: pd.Series, close: pd.Series, lookback=14) -> pd.Series:
    """Average True Range (ATR) calculation."""
    prev_close = close.shift(1)

    true_high = pd.concat([high, prev_close], axis=1).max(axis=1)
    true_low = pd.concat([low, prev_close], axis=1).min(axis=1)

    tr = true_high - true_low  # True Range

    atr_value = tr.rolling(lookback).mean()  # Simple Moving Average of TR

    return atr_value


def weekly_rdata(data: pd.DataFrame) -> pd.DataFrame:
    """Resample daily OHLC data to weekly OHLC data."""
    data = data.copy()
    weekly_data = (
        data.resample("W-MON", label="left", closed="left")
        .agg({"open": "first", "high": "max", "low": "min", "close": "last"})
        .dropna()
    )
    weekly_data.rename(
        columns={
            "open": "weekly_open",
            "high": "weekly_high",
            "low": "weekly_low",
            "close": "weekly_close",
        },
        inplace=True,
    )

    weekly_data["lwv"] = lv(
        weekly_data["weekly_high"],
        weekly_data["weekly_low"],
        weekly_data["weekly_close"],
        lookback=4,
    )

    data = data.join(weekly_data, how="left", rsuffix="_weekly")
    data["lwv"] = data["lwv"].replace("", np.nan)
    data["lwv"] = data["lwv"].ffill()

    return data


def sma(close: pd.Series, lookback=20) -> pd.Series:
    """Simple Moving Average (SMA) calculation."""
    sma_value = close.rolling(window=lookback).mean()
    return sma_value
