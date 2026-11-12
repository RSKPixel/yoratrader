"""Six mechanical strategies for the backtest, run on 15m bars with daily bars for
signals and context. Each returns trades in the backtest's common shape.

- nrib:  NR4/NR7 inside day (Toby Crabel). The setup day is both the narrowest
         range of the last 4 or 7 days AND an inside day. Next day, trade the
         break of its high (buy) or low (sell); stop at the other side.
- bbsq:  Bollinger squeeze. 20-day Bollinger Band width at its lowest in 120
         days; trade the break of that day's range; stop 1 or 2 x ATR; hold 3/5 days.
- rsi2:  RSI(2) pullback (Larry Connors). Daily close: RSI(2) below 10 (or 5)
         and above the 200-day average -> buy next open; above 90 (95) and below
         the 200-day average -> sell (optional). Exit at the next open after the
         close crosses the 5-day average, or after 5 days.
- ibs:   Internal Bar Strength. At 15:15, IBS = (price - day low)/(day high - day low)
         from the day's 15m candles so far. Below 0.2 (or 0.1): buy at 15:15. Exit at
         15:15 next day, or at 15:15 once IBS is above 0.8 (max 5 days).
- donch: Donchian / Turtle breakout. Buy a break of the 20/55-day high, sell a
         break of the 20/55-day low; stop 2 x ATR; exit on a break of the 10/20-day
         opposite extreme.
- tom:   Turn of the month. Buy at 15:15 on the last (or 2nd-last) trading day of
         the month; sell at 15:15 on the 3rd (or 5th) trading day of the next month.

Common rules: stop-order entries fill at the level, or at the bar's open if price
gapped past it. Each bar checks an opening gap past the stop first, then the stop;
a stop touched in the entry bar counts as hit (worst case). "15:15" prices are the
15:15 bar's open. Strategies without a stop of their own (RSI(2), IBS, turn of the
month) carry a 2 x ATR protective stop, which also sets 1R. One open position per
symbol at a time. Setups based on a short special session (Muhurat trading) are skipped.
"""

from datetime import date
from datetime import time as clock

import numpy as np
import pandas as pd

import orb

EXIT_1515 = clock(15, 15)
MIN_SESSION_BARS = 20
PROTECTIVE_ATR = 2.0


class _Session:
    """15m bars grouped by trading day, with fast lookups."""

    def __init__(self, bars):
        self.bars = bars.reset_index(drop=True)
        self.day_of = self.bars["datetime"].dt.date
        self.time_of = self.bars["datetime"].dt.time
        groups = self.bars.groupby(self.day_of).indices
        self.days = sorted(groups)
        self.index = {d: i for i, d in enumerate(self.days)}
        self.start = {d: int(idx[0]) for d, idx in groups.items()}
        self.end = {d: int(idx[-1]) for d, idx in groups.items()}
        self.o = self.bars["open"].to_numpy(float)
        self.h = self.bars["high"].to_numpy(float)
        self.l = self.bars["low"].to_numpy(float)
        self.c = self.bars["close"].to_numpy(float)

    def bar_at(self, day, at):
        """First bar of `day` starting at or after `at`."""
        for i in range(self.start[day], self.end[day] + 1):
            if self.time_of.iloc[i] >= at:
                return i
        return None

    def short_session(self, day):
        return day in self.start and self.end[day] - self.start[day] + 1 < MIN_SESSION_BARS

    def next_day(self, day):
        i = self.index.get(day)
        if i is None:
            later = [d for d in self.days if d > day]
            return later[0] if later else None
        return self.days[i + 1] if i + 1 < len(self.days) else None


def _stop_hit(s, i, entry_i, stop, long):
    """(price, reason) if bar i hits the stop: an opening gap past it first, then a touch."""
    if i > entry_i and ((long and s.o[i] <= stop) or (not long and s.o[i] >= stop)):
        return s.o[i], "stop (gap)"
    if (long and s.l[i] <= stop) or (not long and s.h[i] >= stop):
        return stop, "stop"
    return None


def _walk(s, entry_i, entry, stop, long, hold_days):
    """Follow a position from bar entry_i to 15:15 on its hold_days-th day."""
    day = s.day_of.iloc[entry_i]
    last_day_i = s.index[day] + hold_days - 1
    for i in range(entry_i, len(s.bars)):
        day_i = s.index[s.day_of.iloc[i]]
        if day_i > last_day_i:
            break
        if day_i == last_day_i and s.time_of.iloc[i] >= EXIT_1515 and i > entry_i:
            return s.o[i], i, "time", "closed"
        hit = _stop_hit(s, i, entry_i, stop, long)
        if hit:
            return hit[0], i, hit[1], "closed"
    return _ran_out(s, last_day_i)


def _ran_out(s, last_day_i):
    """No exit before the data ends: open if the data runs to today, else flat at the last bar."""
    if last_day_i >= len(s.days) or s.days[-1] >= date.today():
        return s.c[-1], len(s.bars) - 1, "open", "open"
    last_i = s.end[s.days[last_day_i]]
    return s.c[last_i], last_i, "session end", "closed"


def _trade(s, entry_i, entry, stop, long, exit_px, exit_i, reason, status, risk=None):
    risk = risk if risk is not None else (entry - stop if long else stop - entry)
    sign = 1 if long else -1
    ts = s.bars["datetime"].iloc[entry_i]
    return {
        "date": s.day_of.iloc[entry_i].isoformat(), "side": "long" if long else "short",
        "entry_time": orb._epoch_ist(ts), "entry_label": ts.strftime("%H:%M"), "entry": round(float(entry), 2),
        "stop": round(float(stop), 2), "target": None, "exit": round(float(exit_px), 2), "exit_reason": reason,
        "t1_hit": False, "r": round(float(sign * (exit_px - entry) / risk), 3), "status": status,
        "exit_date": s.day_of.iloc[exit_i].isoformat(),
    }


def _daily(daily):
    """Daily bars indexed by date, with ATR(14) and SMA50 trend known at each day's open."""
    d = daily.copy()
    d["day"] = pd.to_datetime(d["datetime"]).dt.date
    d = d.set_index("day")
    context = orb._daily_context(daily)
    d["atr"] = context["atr"]
    d["trend"] = context["trend"]
    return d


def _prev_row(rows):
    """Trading day -> index of the previous daily row."""
    return {rows["day"].iloc[k + 1]: k for k in range(len(rows) - 1)}


def _range_breakout(s, d, setup_mask, hold_days, trend_mode, stop_atr=None):
    """Break of the setup day's range the next day. stop_atr=None: stop at the other
    side of the range; else stop_atr x ATR from entry. trend_mode "with" trades only
    the SMA50 trend side, "any" whichever side breaks first."""
    rows = d.reset_index()
    prev = _prev_row(rows)
    trades, busy_until = [], None
    for day in s.days:
        k = prev.get(day)
        if k is None or (busy_until and day <= busy_until) or not bool(setup_mask.iloc[k]):
            continue
        if s.short_session(rows["day"].iloc[k]):
            continue
        hi, lo = float(rows["high"].iloc[k]), float(rows["low"].iloc[k])
        atr = d["atr"].get(day)
        if hi <= lo or (stop_atr and (atr is None or pd.isna(atr))):
            continue
        if trend_mode == "with":
            trend = d["trend"].get(day)
            if trend not in ("up", "down"):
                continue
            sides = [trend == "up"]
        else:
            sides = [True, False]
        entry_i = long = None
        for i in range(s.start[day], s.end[day] + 1):
            up = True in sides and s.h[i] >= hi
            down = False in sides and s.l[i] <= lo
            if up and down:
                break  # one bar took out both sides: ambiguous, skip the day
            if up or down:
                entry_i, long = i, up
                break
        if entry_i is None or (hold_days == 1 and s.time_of.iloc[entry_i] >= EXIT_1515):
            continue
        entry = max(hi, s.o[entry_i]) if long else min(lo, s.o[entry_i])
        if stop_atr:
            stop = entry - stop_atr * atr if long else entry + stop_atr * atr
        else:
            stop = lo if long else hi
        if (long and entry <= stop) or (not long and entry >= stop):
            continue
        exit_px, exit_i, reason, status = _walk(s, entry_i, entry, stop, long, hold_days)
        trades.append(_trade(s, entry_i, entry, stop, long, exit_px, exit_i, reason, status))
        busy_until = s.day_of.iloc[exit_i]
    return trades


def nr_inside(bars, daily, n, hold_days, trend):
    """NR4/NR7 inside day: narrowest range of the last n days and inside the day before."""
    s, d = _Session(bars), _daily(daily)
    rows = d.reset_index()
    rng = rows["high"] - rows["low"]
    inside = (rows["high"] <= rows["high"].shift(1)) & (rows["low"] >= rows["low"].shift(1))
    mask = (rng == rng.rolling(n).min()) & inside
    return _range_breakout(s, d, mask, hold_days, trend)


def bollinger_squeeze(bars, daily, stop_atr, hold_days):
    """20-day Bollinger Band width (4 sd / mean) at its lowest in 120 days."""
    s, d = _Session(bars), _daily(daily)
    rows = d.reset_index()
    mean = rows["close"].rolling(20).mean()
    width = 4 * rows["close"].rolling(20).std() / mean
    mask = (width <= width.rolling(120).min()) & width.notna()
    return _range_breakout(s, d, mask, hold_days, "any", stop_atr=stop_atr)


def _rsi(close, n):
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + gain / loss.replace(0, np.nan))


def rsi2(bars, daily, threshold, sides, max_days=5):
    """Connors RSI(2): signal on the daily close, enter at the next open, exit at the
    next open after the close crosses the 5-day average or after max_days days."""
    s, d = _Session(bars), _daily(daily)
    rows = d.reset_index()
    close = rows["close"]
    rsi = _rsi(close, 2)
    sma200 = close.rolling(200).mean()
    sma5 = close.rolling(5).mean()
    k_of = {day: k for k, day in enumerate(rows["day"])}
    trades, pos = [], None
    for day in s.days:
        k = k_of.get(day)
        if pos:
            if pos["exit_next"]:
                # Yesterday's close said exit: out at this open.
                i = s.start[day]
                trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], pos["long"], s.o[i], i, pos["exit_next"],
                                     "closed", pos["risk"]))
                pos = None
            else:
                for i in range(s.start[day], s.end[day] + 1):
                    hit = _stop_hit(s, i, pos["i"], pos["stop"], pos["long"])
                    if hit:
                        trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], pos["long"], hit[0], i, hit[1],
                                             "closed", pos["risk"]))
                        pos = None
                        break
                if pos and k is not None:
                    pos["days"] += 1
                    crossed = close.iloc[k] > sma5.iloc[k] if pos["long"] else close.iloc[k] < sma5.iloc[k]
                    if crossed:
                        pos["exit_next"] = "close crossed 5-day avg"
                    elif pos["days"] >= max_days:
                        pos["exit_next"] = "time"
        # A new signal on today's close enters at the next session's open.
        if pos is None and k is not None and not s.short_session(day) and pd.notna(sma200.iloc[k]):
            long_signal = rsi.iloc[k] < threshold and close.iloc[k] > sma200.iloc[k]
            short_signal = sides == "both" and rsi.iloc[k] > 100 - threshold and close.iloc[k] < sma200.iloc[k]
            nxt = s.next_day(day)
            atr = d["atr"].get(nxt) if nxt else None
            if (long_signal or short_signal) and nxt and atr is not None and pd.notna(atr):
                long = bool(long_signal)
                i = s.start[nxt]
                entry = s.o[i]
                stop = entry - PROTECTIVE_ATR * atr if long else entry + PROTECTIVE_ATR * atr
                pos = {"i": i, "entry": entry, "stop": stop, "long": long, "risk": PROTECTIVE_ATR * atr,
                       "days": 0, "exit_next": None}
    if pos:
        exit_px, exit_i, reason, status = _ran_out(s, len(s.days))
        trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], pos["long"], exit_px, exit_i, reason, status,
                             pos["risk"]))
    return trades


def _ibs_now(s, day, upto_i):
    """IBS at bar upto_i's open, from the day's candles before it (None if there are none)."""
    if upto_i <= s.start[day]:
        return None
    lo = s.l[s.start[day]:upto_i].min()
    hi = s.h[s.start[day]:upto_i].max()
    price = s.o[upto_i]
    return (price - lo) / (hi - lo) if hi > lo else None


def ibs(bars, daily, threshold, exit_mode, max_days=5):
    """Buy at 15:15 when the day's IBS so far is below threshold. exit_mode "next":
    sell at 15:15 the next day; "ibs": sell at 15:15 once IBS is above 0.8 (max_days)."""
    s, d = _Session(bars), _daily(daily)
    trades, pos = [], None
    for day in s.days:
        at = s.bar_at(day, EXIT_1515)
        if pos:
            for i in range(s.start[day], s.end[day] + 1):
                if at is not None and i == at:
                    held = s.index[day] - s.index[pos["day"]]
                    value = _ibs_now(s, day, at)
                    if exit_mode == "next" or held >= max_days or (value is not None and value > 0.8):
                        reason = "IBS above 0.8" if exit_mode == "ibs" and held < max_days else "time"
                        trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], True, s.o[at], at, reason, "closed",
                                             pos["risk"]))
                        pos = None
                        break
                hit = _stop_hit(s, i, pos["i"], pos["stop"], True)
                if hit:
                    trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], True, hit[0], i, hit[1], "closed",
                                         pos["risk"]))
                    pos = None
                    break
            continue  # no new entry on a day a position was open
        if at is None or at == s.start[day] or s.short_session(day):
            continue
        atr = d["atr"].get(day)
        value = _ibs_now(s, day, at)
        if value is None or atr is None or pd.isna(atr) or value >= threshold:
            continue
        entry = s.o[at]
        pos = {"day": day, "i": at, "entry": entry, "stop": entry - PROTECTIVE_ATR * atr, "risk": PROTECTIVE_ATR * atr}
    if pos:
        exit_px, exit_i, reason, status = _ran_out(s, len(s.days))
        trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], True, exit_px, exit_i, reason, status, pos["risk"]))
    return trades


def donchian(bars, daily, entry_n, exit_n):
    """Break of the entry_n-day high (buy) or low (sell), stop 2 x ATR, exit on a break
    of the exit_n-day opposite extreme. Channels use days up to yesterday."""
    s, d = _Session(bars), _daily(daily)
    rows = d.reset_index()
    up_ch, dn_ch = rows["high"].rolling(entry_n).max(), rows["low"].rolling(entry_n).min()
    ex_hi, ex_lo = rows["high"].rolling(exit_n).max(), rows["low"].rolling(exit_n).min()
    prev = _prev_row(rows)
    trades, pos = [], None
    for day in s.days:
        k = prev.get(day)
        if k is None or pd.isna(up_ch.iloc[k]):
            continue
        start = s.start[day]
        if pos is None:
            atr = d["atr"].get(day)
            if atr is None or pd.isna(atr) or s.short_session(rows["day"].iloc[k]):
                continue
            hi, lo = float(up_ch.iloc[k]), float(dn_ch.iloc[k])
            for i in range(start, s.end[day] + 1):
                up, down = s.h[i] >= hi, s.l[i] <= lo
                if up and down:
                    break
                if up or down:
                    long = bool(up)
                    entry = max(hi, s.o[i]) if long else min(lo, s.o[i])
                    stop = entry - PROTECTIVE_ATR * atr if long else entry + PROTECTIVE_ATR * atr
                    pos = {"i": i, "entry": entry, "stop": stop, "long": long, "risk": PROTECTIVE_ATR * atr}
                    start = i
                    break
            if pos is None:
                continue
        # Exit level: the tighter of the 2 x ATR stop and the exit channel (known at the open).
        channel = float(ex_lo.iloc[k]) if pos["long"] else float(ex_hi.iloc[k])
        level = max(pos["stop"], channel) if pos["long"] else min(pos["stop"], channel)
        for i in range(start, s.end[day] + 1):
            hit = _stop_hit(s, i, pos["i"], level, pos["long"])
            if hit:
                reason = hit[1] if level == pos["stop"] else hit[1].replace("stop", f"{exit_n}-day exit")
                trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], pos["long"], hit[0], i, reason, "closed",
                                     pos["risk"]))
                pos = None
                break
    if pos:
        exit_px, exit_i, reason, status = _ran_out(s, len(s.days))
        trades.append(_trade(s, pos["i"], pos["entry"], pos["stop"], pos["long"], exit_px, exit_i, reason, status,
                             pos["risk"]))
    return trades


def turn_of_month(bars, daily, entry_from_end, exit_day):
    """Buy at 15:15 on the entry_from_end-th last trading day of the month (1 = last),
    sell at 15:15 on the exit_day-th trading day of the next month."""
    s, d = _Session(bars), _daily(daily)
    months = {}
    for day in s.days:
        if not s.short_session(day):
            months.setdefault((day.year, day.month), []).append(day)
    keys = sorted(months)
    trades = []
    for this, nxt in zip(keys, keys[1:]):  # the latest month isn't finished, so its last day isn't known yet
        in_month, next_month = months[this], months[nxt]
        if len(in_month) < entry_from_end:
            continue
        day = in_month[-entry_from_end]
        at = s.bar_at(day, EXIT_1515)
        atr = d["atr"].get(day)
        if at is None or atr is None or pd.isna(atr):
            continue
        entry = s.o[at]
        stop = entry - PROTECTIVE_ATR * atr
        if len(next_month) >= exit_day:
            hold = s.index[next_month[exit_day - 1]] - s.index[day] + 1
        else:
            hold = len(s.days) - s.index[day] + exit_day  # runs past the data: stays open
        exit_px, exit_i, reason, status = _walk(s, at, entry, stop, True, hold)
        trades.append(_trade(s, at, entry, stop, True, exit_px, exit_i, reason, status, PROTECTIVE_ATR * atr))
    return trades
