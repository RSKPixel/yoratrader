"""Opening Range Breakout on 15m bars, filtered by daily trend and session VWAP.

Rules
- Opening range (OR): high/low of the first two 15m bars of the session.
- Daily trend from eod (previous day's close vs SMA50): long only above, short only below.
- Skip the day if OR width > 1.0x or < 0.2x the daily ATR(14).
- Entry (once per day, on bar close): close beyond the OR, on the right side of
  session VWAP, with volume above its 20-bar average. No entries after the cutoff.
- Stop: tighter of the opposite OR side and entry -/+ 0.5x daily ATR.
- T1 at 1R books half and moves the stop to entry; the rest trails the
  previous 2 bars' low/high. Everything is flat at the session exit time.
Results are in R (risk units) before costs. Stops are assumed to fill at the
stop price; when a bar touches both stop and target, the stop is taken first.
"""

from datetime import date, time

import pandas as pd

from db import connect

SESSIONS = {
    # exchange: (last entry bar start, forced exit bar start), IST
    "NSE": (time(13, 30), time(15, 15)),
    "MCX": (time(20, 0), time(23, 0)),
}
# Liquid index futures. FINNIFTY, NIFTYNXT50, NIFTYFPI and the MCX indices
# have too many zero-volume 15m bars for the volume filter to mean anything.
INDEX_FUTURES = {("NSE", "NIFTY"), ("NSE", "BANKNIFTY"), ("NSE", "MIDCPNIFTY")}
UNIVERSES = ("all", "nse", "mcx", "index")


def _in_universe(exchange, symbol, universe):
    if universe == "index":
        return (exchange, symbol) in INDEX_FUTURES
    if universe in ("nse", "mcx"):
        return exchange == universe.upper()
    return True
OR_BARS = 2
VOL_LOOKBACK = 20
MAX_OR_ATR = 1.0
MIN_OR_ATR = 0.2
STOP_ATR = 0.5


def _load(exchange=None, symbol=None):
    where, params = "", []
    if exchange and symbol:
        where, params = "WHERE exchange = %s AND symbol = %s", [exchange, symbol]
    with connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT to_regclass('intraday_15m')")
            if cursor.fetchone()[0] is None:
                return pd.DataFrame(), pd.DataFrame()
        intraday = pd.read_sql(
            f"SELECT exchange, symbol, datetime, open, high, low, close, volume, oi FROM intraday_15m {where} ORDER BY exchange, symbol, datetime",
            conn,
            params=params or None,
        )
        daily = pd.read_sql(
            f"SELECT exchange, symbol, datetime, high, low, close FROM eod {where} ORDER BY exchange, symbol, datetime",
            conn,
            params=params or None,
        )
    if not intraday.empty:
        intraday["datetime"] = pd.to_datetime(intraday["datetime"], utc=True).dt.tz_convert("Asia/Kolkata")
    return intraday, daily


def _daily_context(daily):
    """Per day: trend and ATR known at that day's open (i.e. from the previous close)."""
    d = daily.copy()
    d["datetime"] = pd.to_datetime(d["datetime"]).dt.date
    prev_close = d["close"].shift(1)
    tr = pd.concat([d["high"] - d["low"], (d["high"] - prev_close).abs(), (d["low"] - prev_close).abs()], axis=1).max(axis=1)
    d["atr"] = tr.rolling(14).mean().shift(1)
    sma50 = d["close"].rolling(50).mean()
    d["trend"] = (d["close"] > sma50).map({True: "up", False: "down"}).where(sma50.notna()).shift(1)
    return d.set_index("datetime")[["atr", "trend"]]


def _epoch_ist(ts):
    # Same convention as fetch_intraday_candles: epoch seconds shifted to IST.
    return int(ts.timestamp()) + 19800


def _scan_symbol(exchange, symbol, bars, daily, use_volume=True, use_vwap=True, or_bars=OR_BARS, stop_atr=STOP_ATR,
                 max_or_atr=MAX_OR_ATR, min_or_atr=MIN_OR_ATR, min_risk_pct=0.0):
    """Defaults are the live model. The backtest varies them:
    use_volume / use_vwap switch off those entry filters (index data has no volume);
    or_bars sets the opening range length; min_risk_pct skips trades whose stop is
    closer than that percent of price (costs are a fixed share of price, so tight
    stops cost more in R)."""
    if exchange not in SESSIONS or bars.empty or daily.empty:
        return []
    cutoff, flat_at = SESSIONS[exchange]
    context = _daily_context(daily)
    bars = bars.reset_index(drop=True)
    bars["vol_avg"] = bars["volume"].rolling(VOL_LOOKBACK, min_periods=5).mean().shift(1)
    trades = []

    for day, session in bars.groupby(bars["datetime"].dt.date):
        session = session.reset_index(drop=True)
        if len(session) <= or_bars or day not in context.index:
            continue
        atr, trend = context.loc[day, "atr"], context.loc[day, "trend"]
        if pd.isna(atr) or trend not in ("up", "down"):
            continue
        opening = session.iloc[:or_bars]
        or_high, or_low = opening["high"].max(), opening["low"].min()
        width = or_high - or_low
        base = {"exchange": exchange, "symbol": symbol, "date": day.isoformat(), "trend": trend,
                "or_high": round(float(or_high), 2), "or_low": round(float(or_low), 2), "atr": round(float(atr), 2)}
        if width > max_or_atr * atr or width < min_or_atr * atr:
            trades.append({**base, "status": "skipped", "reason": "OR too wide" if width > max_or_atr * atr else "OR too narrow"})
            continue

        typical = (session["high"] + session["low"] + session["close"]) / 3
        cum_vol = session["volume"].cumsum()
        session["vwap"] = (typical * session["volume"]).cumsum() / cum_vol.where(cum_vol > 0)

        side = "long" if trend == "up" else "short"
        entry_i = None
        for i in range(or_bars, len(session)):
            bar = session.iloc[i]
            if bar["datetime"].time() > cutoff:
                break
            vol_ok = not use_volume or (pd.notna(bar["vol_avg"]) and bar["volume"] > bar["vol_avg"])
            vwap = bar["vwap"]
            if (use_vwap and pd.isna(vwap)) or not vol_ok:
                continue
            if side == "long" and bar["close"] > or_high and (not use_vwap or bar["close"] > vwap):
                entry_i = i
                break
            if side == "short" and bar["close"] < or_low and (not use_vwap or bar["close"] < vwap):
                entry_i = i
                break

        if entry_i is None:
            trades.append({**base, "status": "no_entry", "side": side})
            continue

        entry_bar = session.iloc[entry_i]
        entry = float(entry_bar["close"])
        if side == "long":
            stop = max(or_low, entry - stop_atr * atr)
        else:
            stop = min(or_high, entry + stop_atr * atr)
        risk = abs(entry - stop)
        if risk <= 0:
            continue
        if risk < min_risk_pct / 100 * entry:
            trades.append({**base, "status": "skipped", "side": side, "reason": "stop too tight"})
            continue
        target = entry + risk if side == "long" else entry - risk
        sign = 1 if side == "long" else -1

        half_booked = False
        realized = 0.0
        exit_price, exit_time, exit_reason = None, None, None
        open_trade = True
        status = "open"
        for j in range(entry_i + 1, len(session)):
            bar = session.iloc[j]
            low, high = bar["low"], bar["high"]
            hit_stop = low <= stop if side == "long" else high >= stop
            if hit_stop:
                exit_price, exit_time = stop, bar["datetime"]
                exit_reason = "trail" if half_booked else "stop"
                open_trade = False
                break
            hit_target = high >= target if side == "long" else low <= target
            if not half_booked and hit_target:
                half_booked = True
                realized += 0.5 * 1.0
                stop = entry
            if half_booked and j >= 2:
                prev2 = session.iloc[j - 1 : j + 1]
                trail = prev2["low"].min() if side == "long" else prev2["high"].max()
                stop = max(stop, trail) if side == "long" else min(stop, trail)
            if bar["datetime"].time() >= flat_at:
                exit_price, exit_time, exit_reason = float(bar["close"]), bar["datetime"], "time"
                open_trade = False
                break

        last = session.iloc[-1]
        if open_trade and day < date.today():
            # Session ended before the forced-exit time (e.g. agri contracts): flat at the last bar.
            exit_price, exit_time, exit_reason = float(last["close"]), last["datetime"], "session end"
            open_trade = False
        mark = float(exit_price if exit_price is not None else last["close"])
        remaining = 0.5 if half_booked else 1.0
        r_multiple = realized + remaining * sign * (mark - entry) / risk
        status = "open" if open_trade else "closed"

        trades.append({
            **base,
            "status": status,
            "side": side,
            "entry_time": _epoch_ist(entry_bar["datetime"]),
            "entry_label": entry_bar["datetime"].strftime("%H:%M"),
            "entry": round(entry, 2),
            "stop": round(float(entry - sign * risk), 2),
            "target": round(float(target), 2),
            "t1_hit": half_booked,
            "exit_time": _epoch_ist(exit_time) if exit_time is not None else None,
            "exit": round(mark, 2),
            "exit_reason": exit_reason or "open",
            "r": round(float(r_multiple), 2),
        })
    return trades


def scan(exchange=None, symbol=None, universe="all"):
    intraday, daily = _load(exchange, symbol)
    if intraday.empty:
        return []
    trades = []
    daily_groups = {key: g for key, g in daily.groupby(["exchange", "symbol"])}
    for (ex, sym), bars in intraday.groupby(["exchange", "symbol"]):
        if not symbol and not _in_universe(ex, sym, universe):
            continue
        trades.extend(_scan_symbol(ex, sym, bars, daily_groups.get((ex, sym), pd.DataFrame())))
    return trades


def cap_per_day(trades, max_per_day):
    """Keep at most max_per_day taken trades per day, in the order they would have fired.

    Ties on the same bar go to the tighter stop (smaller risk as % of price). Dropped
    trades are marked "capped" so they still show up in the scan counts.
    """
    if not max_per_day:
        return trades
    taken = [t for t in trades if t["status"] in ("closed", "open")]
    taken.sort(key=lambda t: (t["date"], t["entry_time"], abs(t["entry"] - t["stop"]) / t["entry"]))
    kept, per_day = set(), {}
    for t in taken:
        if per_day.get(t["date"], 0) < max_per_day:
            per_day[t["date"]] = per_day.get(t["date"], 0) + 1
            kept.add(id(t))
    return [t if t["status"] not in ("closed", "open") or id(t) in kept else {**t, "status": "capped"} for t in trades]


def summarize(trades):
    taken = [t for t in trades if t["status"] in ("closed", "open")]
    closed = [t for t in taken if t["status"] == "closed"]
    wins = [t for t in closed if t["r"] > 0]
    total_r = sum(t["r"] for t in closed)
    return {
        "days_scanned": len(trades),
        "trades": len(closed),
        "open": len(taken) - len(closed),
        "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "total_r": round(float(total_r), 2),
        "avg_r": round(float(total_r) / len(closed), 2) if closed else None,
    }
