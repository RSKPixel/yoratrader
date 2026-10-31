"""Opening drive + Fibonacci pullback on 15m bars.

Rules (long; shorts are the mirror image)
- Daily trend from eod (previous close vs SMA50) picks the side, as in ORB.
- Impulse low: the session low made by the impulse cutoff (10:30 NSE, 10:15 MCX).
  Impulse high: the highest high after that low, until the pullback starts.
- The impulse must be at least 0.6x the daily ATR(14).
- Pullback starts when a bar trades down to the 50% retracement. The setup fails if
  a bar closes below 78.6% before entry.
- Entry: a green bar that closes above the previous bar's high, once the pullback has
  reached 50%. No entries after the cutoff; one trade per symbol per day.
- Stop: the lower of 78.6% and the pullback low.
- T1: impulse high (books half, stop to entry). T2: 127.2% extension closes the rest.
  Everything is flat at the session exit time.
Results are in R before costs. When a bar touches both stop and target, the stop is taken.
"""

from datetime import date, time

import pandas as pd

from orb import SESSIONS, _daily_context, _epoch_ist, _in_universe, _load, summarize  # noqa: F401

IMPULSE_CUTOFF = {"NSE": time(10, 30), "MCX": time(10, 15)}
MIN_IMPULSE_ATR = 0.6
ZONE = 0.5
INVALID = 0.786
EXTENSION = 1.272


def _mirror(session):
    """Flip prices so the long-side logic also handles shorts."""
    flipped = session.copy()
    flipped["open"], flipped["close"] = -session["open"], -session["close"]
    flipped["high"], flipped["low"] = -session["low"], -session["high"]
    return flipped


def _scan_day(session, exchange, atr):
    """Long-side setup on (possibly mirrored) bars. Returns a dict or None."""
    cutoff, flat_at = SESSIONS[exchange]
    early = session[session["datetime"].dt.time <= IMPULSE_CUTOFF[exchange]]
    if early.empty:
        return None
    low_i = int(early["low"].idxmin())
    lo = float(session.loc[low_i, "low"])
    hi = float(session.loc[low_i, "high"])
    hi_i = low_i
    pulling_back = False
    pull_low = None

    for j in range(low_i + 1, len(session)):
        bar = session.iloc[j]
        if bar["datetime"].time() > cutoff:
            return {"status": "no_entry", "lo": lo, "hi": hi, "hi_i": hi_i, "low_i": low_i}
        if not pulling_back:
            if bar["high"] > hi:
                hi, hi_i = float(bar["high"]), j
            level50 = hi - ZONE * (hi - lo)
            if hi - lo >= MIN_IMPULSE_ATR * atr and bar["low"] <= level50 and j > hi_i:
                pulling_back = True
                pull_low = float(bar["low"])
            else:
                continue
        else:
            pull_low = min(pull_low, float(bar["low"]))

        rng = hi - lo
        invalid = hi - INVALID * rng
        if bar["close"] < invalid:
            return {"status": "failed", "lo": lo, "hi": hi, "hi_i": hi_i, "low_i": low_i}
        prev = session.iloc[j - 1]
        if bar["close"] > bar["open"] and bar["close"] > prev["high"] and bar["close"] < hi:
            entry = float(bar["close"])
            stop = min(invalid, pull_low)
            return {"status": "entry", "lo": lo, "hi": hi, "hi_i": hi_i, "low_i": low_i, "entry_i": j, "entry": entry,
                    "stop": stop, "t1": hi, "t2": lo + EXTENSION * rng, "flat_at": flat_at}
    return {"status": "no_entry", "lo": lo, "hi": hi, "hi_i": hi_i, "low_i": low_i}


def _manage(session, setup, today_open):
    """Walk bars after entry: stop, T1 (half + breakeven), T2, time exit."""
    entry, stop, t1, t2 = setup["entry"], setup["stop"], setup["t1"], setup["t2"]
    risk = entry - stop
    realized, half = 0.0, False
    for j in range(setup["entry_i"] + 1, len(session)):
        bar = session.iloc[j]
        if bar["low"] <= stop:
            return realized + (0.5 if half else 1.0) * (stop - entry) / risk, stop, bar["datetime"], "trail" if half else "stop", half
        if not half and bar["high"] >= t1:
            half = True
            realized += 0.5 * (t1 - entry) / risk
            stop = entry
        if half and bar["high"] >= t2:
            return realized + 0.5 * (t2 - entry) / risk, t2, bar["datetime"], "T2", half
        if bar["datetime"].time() >= setup["flat_at"]:
            close = float(bar["close"])
            return realized + (0.5 if half else 1.0) * (close - entry) / risk, close, bar["datetime"], "time", half
    last = session.iloc[-1]
    close = float(last["close"])
    reason = "open" if today_open else "session end"
    return realized + (0.5 if half else 1.0) * (close - entry) / risk, close, None if today_open else last["datetime"], reason, half


def _scan_symbol(exchange, symbol, bars, daily):
    if exchange not in SESSIONS or bars.empty or daily.empty:
        return []
    context = _daily_context(daily)
    trades = []
    for day, session in bars.groupby(bars["datetime"].dt.date):
        session = session.reset_index(drop=True)
        if len(session) < 4 or day not in context.index:
            continue
        atr, trend = context.loc[day, "atr"], context.loc[day, "trend"]
        if pd.isna(atr) or trend not in ("up", "down"):
            continue
        side = "long" if trend == "up" else "short"
        sign = 1 if side == "long" else -1
        work = session if side == "long" else _mirror(session)
        setup = _scan_day(work, exchange, float(atr))
        if setup is None:
            continue

        def px(value):
            return round(float(sign * value), 2)

        lo, hi = setup["lo"], setup["hi"]
        rng = hi - lo
        levels = {name: px(hi - ratio * rng) for name, ratio in
                  (("0", 0.0), ("38.2", 0.382), ("50", 0.5), ("61.8", 0.618), ("78.6", 0.786), ("100", 1.0))}
        levels["127.2"] = px(lo + EXTENSION * rng)
        base = {"exchange": exchange, "symbol": symbol, "date": day.isoformat(), "trend": trend, "side": side,
                "atr": round(float(atr), 2), "fib": levels,
                "impulse_start": _epoch_ist(session.loc[setup["low_i"], "datetime"]),
                "impulse_end": _epoch_ist(session.loc[setup["hi_i"], "datetime"])}
        if setup["status"] != "entry":
            trades.append({**base, "status": setup["status"]})
            continue
        if setup["entry"] - setup["stop"] <= 0:
            continue

        today_open = day >= date.today()
        r, exit_px, exit_time, reason, t1_hit = _manage(work, setup, today_open)
        entry_bar = session.iloc[setup["entry_i"]]
        trades.append({
            **base,
            "status": "open" if reason == "open" else "closed",
            "entry_time": _epoch_ist(entry_bar["datetime"]),
            "entry_label": entry_bar["datetime"].strftime("%H:%M"),
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
