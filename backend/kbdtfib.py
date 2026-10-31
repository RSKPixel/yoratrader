"""Key break (Dow theory) for direction, Fibonacci for timing, on 15m bars.

Rules (long; shorts are the mirror image)
- Swings and Dow structure come from SwingPoints2 + ddt2 on the symbol's 15m series,
  the same tools KBDT uses on daily bars.
- Key break: a bar trades above the last Dow peak (dow_cross with direction 1).
  The daily SMA50 trend must agree, as in ORB / Fib.
- Break leg: from the lowest low since the previous opposite key break up to the
  highest high after the break (extends until the pullback starts).
  The leg must be at least MIN_LEG_ATR x the daily ATR(14).
- Entry timing: price pulls back into the 38.2–61.8% zone of the leg, then a green
  bar closes above the previous bar's high. The setup dies on a close below 78.6%,
  on an opposite key break, or at the entry cutoff. One trade per break.
- Stop: the lower of 78.6% and the pullback low.
- Exit timing: T1 at the leg high (100%) books half and moves the stop to entry;
  T2 at the 161.8% extension closes the rest. An opposite key break closes everything,
  and the position is flat at the session exit time.
Results are in R before costs. When a bar touches both stop and target, the stop is taken.
Note: SwingPoints2 marks a swing on its bar once later bars confirm it, so key-break
levels are slightly optimistic on history versus live.
"""

from datetime import date

import numpy as np
import pandas as pd

from orb import SESSIONS, _daily_context, _epoch_ist, _in_universe, _load, summarize  # noqa: F401

MIN_LEG_ATR = 0.4
ZONE_SHALLOW = 0.382
INVALID = 0.786
EXTENSION = 1.618
LEVELS = (("0", 0.0), ("38.2", 0.382), ("50", 0.5), ("61.8", 0.618), ("78.6", 0.786), ("100", 1.0))


def _bar_types(high, low):
    """BarIdentification on arrays: DB (directional), ISB (inside), OSB (outside)."""
    types = ["DB"] * len(high)
    anchor = 0
    for i in range(1, len(high)):
        ah, al = high[anchor], low[anchor]
        if high[i] <= ah and low[i] >= al:
            types[i] = "ISB"
            continue
        types[i] = "OSB" if high[i] > ah and low[i] < al else "DB"
        anchor = i
    return types


def _swings(high, low):
    """SwingPoints2 on arrays (same rules, no per-row pandas access). Returns (swing, swing_point)."""
    n = len(high)
    types = _bar_types(high, low)
    swing_of = [""] * n
    point_of = np.full(n, np.nan)

    def mark(idx, side, value):
        swing_of[idx], point_of[idx] = side, value

    previous_db, swing_index = 0, 0
    swing_point, swing = high[0], "low"
    if n > 1 and types[1] == "DB":
        if high[1] > high[0]:
            swing, swing_point = "low", low[0]
        else:
            swing, swing_point = "high", high[0]
        mark(0, swing, swing_point)

    for i in range(1, n):
        prev_h, prev_l = high[previous_db], low[previous_db]
        cur_h, cur_l, bar = high[i], low[i], types[i]
        if bar == "ISB":
            continue
        if bar == "OSB":
            if swing == "low":
                if swing_index != previous_db and cur_l < swing_point and cur_h > prev_h:
                    if high[previous_db] > swing_point:
                        swing_point, swing = high[swing_index:previous_db + 1].max(), "high"
                        swing_index = int(np.flatnonzero(high == swing_point)[0])
                    else:
                        swing_point, swing = low[swing_index:previous_db + 1].min(), "low"
                        swing_index = int(np.flatnonzero(low == swing_point)[0])
                    mark(swing_index, swing, swing_point)
                    swing_point, swing, swing_index = cur_h, "high", i
                    mark(i, swing, swing_point)
                    previous_db = i
                    continue
                if cur_l <= swing_point:
                    swing_point = cur_l
                    mark(swing_index, swing, swing_point)
                else:
                    previous_db = i
                    continue
            if swing == "high":
                if swing_index != previous_db and cur_h > swing_point and cur_l < prev_l:
                    if low[previous_db] < swing_point:
                        swing_point, swing = low[swing_index:previous_db + 1].min(), "low"
                        swing_index = int(np.flatnonzero(low == swing_point)[0])
                    else:
                        swing_point, swing = high[swing_index:previous_db + 1].max(), "high"
                        swing_index = int(np.flatnonzero(high == swing_point)[0])
                    mark(swing_index, swing, swing_point)
                    swing_point, swing, swing_index = cur_l, "low", i
                    mark(i, swing, swing_point)
                    previous_db = i
                    continue
                if cur_h >= swing_point:
                    swing_point = cur_h
                    mark(swing_index, swing, swing_point)
                else:
                    previous_db = i
                    continue
        if bar == "DB":
            no_of_osb, db_osb = 0, 0
            for j in range(i - 1, -1, -1):
                if types[j] == "OSB":
                    no_of_osb += 1
                elif types[j] == "DB":
                    db_osb = j
                    break
            if no_of_osb == 2:
                if swing_of[db_osb + 1] == "low":
                    mark(db_osb + 1, "high", high[db_osb + 1])
                    mark(db_osb, "low", low[db_osb])
                elif swing_of[db_osb + 1] == "high":
                    mark(db_osb + 1, "low", low[db_osb + 1])
                    mark(db_osb, "high", high[db_osb])
            if cur_h > prev_h:
                if swing == "low":
                    previous_db = i
                    continue
                swing, swing_index, swing_point = "low", previous_db, prev_l
                mark(swing_index, swing, swing_point)
                previous_db = i
            if cur_l < prev_l:
                if swing == "high":
                    previous_db = i
                    continue
                swing, swing_index, swing_point = "high", previous_db, prev_h
                mark(swing_index, swing, swing_point)
                previous_db = i
    return swing_of, point_of


def _dow(high, low, swing_of, point_of):
    """ddt2 on arrays. Returns (direction, dow_cross)."""
    n = len(high)
    direction_of = np.full(n, np.nan)
    cross = np.full(n, np.nan)
    dow_point, direction, swing_high, swing_low = None, 0, 0, 0
    if swing_of[0] == "high":
        dow_point = swing_high = point_of[0]
        direction = 1
    elif swing_of[0] == "low":
        dow_point = swing_low = point_of[0]
        direction = -1
    for d in range(1, n):
        if direction == 0:
            if swing_of[d] == "high":
                dow_point = swing_high = point_of[d]
                direction = 1
            elif swing_of[d] == "low":
                dow_point = swing_low = point_of[d]
                direction = -1
            if direction == 0:
                continue
        if swing_of[d] == "low":
            swing_low = point_of[d]
        if swing_of[d] == "high":
            swing_high = point_of[d]
        direction_of[d] = direction
        if high[d] >= dow_point and direction == 1:
            direction = -1
            cross[d] = dow_point
        elif low[d] <= dow_point and direction == -1:
            direction = 1
            cross[d] = dow_point
        dow_point = swing_low if direction == -1 else swing_high
    return direction_of, cross


def _structure(bars):
    """Dow columns on the full 15m series; returns a frame with key-break sides."""
    frame = bars.reset_index(drop=True)
    high, low = frame["high"].to_numpy(float), frame["low"].to_numpy(float)
    direction, cross = _dow(high, low, *_swings(high, low))
    hit = ~np.isnan(cross)
    frame["break"] = np.where(hit & (direction == 1), "up", np.where(hit & (direction == -1), "down", None))
    frame["break_level"] = cross
    return frame


def _setup(frame, k, sign, cutoff, flat_at, atr):
    """Walk forward from key-break bar k on sign-adjusted prices. Returns a dict or None."""
    hi_s = sign * (frame["high"] if sign == 1 else frame["low"])
    lo_s = sign * (frame["low"] if sign == 1 else frame["high"])
    op, cl = sign * frame["open"], sign * frame["close"]
    opposite = "down" if sign == 1 else "up"
    day = frame.loc[k, "datetime"].date()

    prev_opp = frame.index[(frame.index < k) & (frame["break"] == opposite)]
    start = int(prev_opp[-1]) if len(prev_opp) else max(0, k - 40)
    low_i = int(lo_s.loc[start:k].idxmin())
    lo, hi, hi_i = float(lo_s[low_i]), float(hi_s[k]), k
    pulling_back, pull_low = False, None
    base = {"low_i": low_i, "break_i": k}

    for j in range(k + 1, len(frame)):
        ts = frame.loc[j, "datetime"]
        if ts.date() != day or ts.time() > cutoff:
            return {**base, "status": "no_entry", "lo": lo, "hi": hi, "hi_i": hi_i}
        if frame.loc[j, "break"] == opposite:
            return {**base, "status": "failed", "lo": lo, "hi": hi, "hi_i": hi_i}
        rng = hi - lo
        if not pulling_back:
            if hi_s[j] > hi:
                hi, hi_i = float(hi_s[j]), j
                continue
            if lo_s[j] <= hi - ZONE_SHALLOW * rng:
                if rng < MIN_LEG_ATR * atr:
                    return {**base, "status": "small_leg", "lo": lo, "hi": hi, "hi_i": hi_i}
                pulling_back, pull_low = True, float(lo_s[j])
            else:
                continue
        else:
            pull_low = min(pull_low, float(lo_s[j]))
        invalid = hi - INVALID * rng
        if cl[j] < invalid:
            return {**base, "status": "failed", "lo": lo, "hi": hi, "hi_i": hi_i}
        if cl[j] > op[j] and cl[j] > hi_s[j - 1] and cl[j] < hi:
            return {**base, "status": "entry", "lo": lo, "hi": hi, "hi_i": hi_i, "entry_i": j,
                    "entry": float(cl[j]), "stop": min(invalid, pull_low), "t1": hi,
                    "t2": lo + EXTENSION * rng, "flat_at": flat_at, "pull_low": pull_low}
    return {**base, "status": "no_entry", "lo": lo, "hi": hi, "hi_i": hi_i}


def _manage(frame, setup, sign, today_open):
    """After entry: stop, T1 (half + breakeven), T2, opposite key break, time exit."""
    hi_s = sign * (frame["high"] if sign == 1 else frame["low"])
    lo_s = sign * (frame["low"] if sign == 1 else frame["high"])
    cl = sign * frame["close"]
    opposite = "down" if sign == 1 else "up"
    entry, stop, t1, t2 = setup["entry"], setup["stop"], setup["t1"], setup["t2"]
    risk = entry - stop
    day = frame.loc[setup["entry_i"], "datetime"].date()
    realized, half = 0.0, False

    def out(px, ts, reason):
        return realized + (0.5 if half else 1.0) * (px - entry) / risk, px, ts, reason, half

    last_j = setup["entry_i"]
    for j in range(setup["entry_i"] + 1, len(frame)):
        ts = frame.loc[j, "datetime"]
        if ts.date() != day:
            break
        last_j = j
        if lo_s[j] <= stop:
            return out(stop, ts, "trail" if half else "stop")
        if not half and hi_s[j] >= t1:
            half = True
            realized += 0.5 * (t1 - entry) / risk
            stop = entry
        if half and hi_s[j] >= t2:
            return out(t2, ts, "T2")
        if frame.loc[j, "break"] == opposite:
            return out(float(cl[j]), ts, "key break")
        if ts.time() >= setup["flat_at"]:
            return out(float(cl[j]), ts, "time")
    ts = frame.loc[last_j, "datetime"]
    if today_open:
        return out(float(cl[last_j]), None, "open")
    return out(float(cl[last_j]), ts, "session end")


def _scan_symbol(exchange, symbol, bars, daily):
    if exchange not in SESSIONS or len(bars) < 10 or daily.empty:
        return []
    cutoff, flat_at = SESSIONS[exchange]
    context = _daily_context(daily)
    frame = _structure(bars)
    trades = []
    for k in frame.index[frame["break"].notna()]:
        ts = frame.loc[k, "datetime"]
        day = ts.date()
        if ts.time() > cutoff or day not in context.index:
            continue
        atr, trend = context.loc[day, "atr"], context.loc[day, "trend"]
        side = "long" if frame.loc[k, "break"] == "up" else "short"
        if pd.isna(atr) or trend != ("up" if side == "long" else "down"):
            continue
        sign = 1 if side == "long" else -1
        setup = _setup(frame, int(k), sign, cutoff, flat_at, float(atr))

        def px(value):
            return round(float(sign * value), 2)

        lo, hi = setup["lo"], setup["hi"]
        rng = hi - lo
        levels = {name: px(hi - ratio * rng) for name, ratio in LEVELS}
        levels["161.8"] = px(lo + EXTENSION * rng)
        base = {"exchange": exchange, "symbol": symbol, "date": day.isoformat(), "trend": trend, "side": side,
                "atr": round(float(atr), 2), "fib": levels,
                "key_break": round(float(frame.loc[k, "break_level"]), 2),
                "key_break_time": _epoch_ist(ts),
                "impulse_start": _epoch_ist(frame.loc[setup["low_i"], "datetime"]),
                "impulse_end": _epoch_ist(frame.loc[setup["hi_i"], "datetime"])}
        if setup["status"] != "entry":
            trades.append({**base, "status": setup["status"]})
            continue
        if setup["entry"] - setup["stop"] <= 0:
            continue
        r, exit_px, exit_time, reason, t1_hit = _manage(frame, setup, sign, day >= date.today())
        entry_ts = frame.loc[setup["entry_i"], "datetime"]
        trades.append({
            **base,
            "status": "open" if reason == "open" else "closed",
            "entry_time": _epoch_ist(entry_ts),
            "entry_label": entry_ts.strftime("%H:%M"),
            "entry": px(setup["entry"]),
            "stop": px(setup["stop"]),
            "target": px(setup["t1"]),
            "target2": px(setup["t2"]),
            "t1_hit": t1_hit,
            "exit_time": _epoch_ist(exit_time) if exit_time is not None else None,
            "exit": px(exit_px),
            "exit_reason": reason,
            "r": round(float(r), 2),
        })
    return trades


def scan(exchange=None, symbol=None, universe="all"):
    intraday, daily = _load(exchange, symbol)
    if intraday.empty:
        return []
    daily_groups = {key: g for key, g in daily.groupby(["exchange", "symbol"])}
    trades = []
    for (ex, sym), bars in intraday.groupby(["exchange", "symbol"]):
        if not symbol and not _in_universe(ex, sym, universe):
            continue
        trades.extend(_scan_symbol(ex, sym, bars, daily_groups.get((ex, sym), pd.DataFrame())))
    return trades
