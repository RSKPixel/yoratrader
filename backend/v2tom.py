"""Turn of the month (Larry Williams, Long-Term Secrets to Short-Term Trading: trading day of the month;
also Kaufman, Trading Systems and Methods), long the index future around each month end.

- Window "4": bought at the close of the 5th-last trading day of the month (so held through the last
  4 days), sold at the close of the 3rd trading day of the next month: 7 trading days.
- Window "1": bought at the close of the 2nd-last day, sold at the close of the 3rd: 4 trading days.
- Index: Nifty 50 or Nifty Bank (the index closes, 2003 on; traded as the near-month future).
- One position, the whole capital (1x the contract value), out of the market the rest of the month.

Costs: NSE futures charges + slippage on the buy and the sale, plus one futures roll per trade (the
monthly expiry usually falls inside the window). Returns: % of capital, not compounded.
"""

import threading
import time

import numpy as np
import pandas as pd

import xsmr
from db import connect

START = "2003-01-01"
INDICES = {"nifty": "NIFTY 50", "banknifty": "NIFTY BANK"}
WINDOWS = {"4": 4, "1": 1}  # trading days held before the month end; always 3 after it
DAYS_AFTER = 3
CACHE_SECONDS = 6 * 3600
_cache, _lock = {}, threading.Lock()


FUTURES = {"nifty": "NIFTY", "banknifty": "BANKNIFTY"}  # the continuous near-month index future (eod, exchange NSE)
INSTRUMENTS = ("spot", "futures")


def _closes(index, instrument="spot"):
    """The index's closes (spot, over the same years as the futures, to compare like for like), or the near-month
    future's (futures: stored continuous futures daily candles,
    Nifty from Oct 2010, Bank Nifty from Mar 2011), adjusted at each expiry: the day the series moves to the next
    contract earns the index's move, not the jump between contracts (the roll is paid in costs). The futures
    series carries attrs["factor"]: adjusted price x factor = the contract's own price."""
    key = (index, instrument)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    with connect() as c:
        d = pd.read_sql("SELECT day, close FROM bt_daily WHERE symbol = %s AND day >= %s AND close > 0 ORDER BY day", c,
                        params=[INDICES[index], START], parse_dates=["day"])
        spot = d.set_index("day")["close"]
        if True:  # spot uses the futures' years too, so the two compare like for like
            f = pd.read_sql("SELECT datetime AS day, close FROM eod WHERE exchange = 'NSE' AND symbol = %s AND close > 0 ORDER BY 1",
                            c, params=[FUTURES[index]], parse_dates=["day"])
    if instrument != "futures":  # spot: only the years the futures have (Nifty Oct 2010, Bank Nifty Mar 2011 on)
        spot = spot[spot.index >= f["day"].min()] if len(f) else spot
    if instrument == "futures":
        import futsig
        fut = f.set_index("day")["close"]
        fut = fut[fut.index.isin(spot.index)]
        sp = spot.reindex(fut.index)
        roll = futsig.roll_days(fut.index)
        jump = ((fut / fut.shift(1)) / (sp / sp.shift(1))).where(roll & ((fut / fut.shift(1)) / (sp / sp.shift(1)) - 1).abs().le(futsig.MAX_BASIS), 1.0).fillna(1.0)
        factor = jump.cumprod()
        s = fut / factor
        s.attrs["factor"] = factor
    else:
        s = spot
    with _lock:
        _cache[key] = (time.time(), s)
    return s


def invalidate():
    with _lock:
        _cache.clear()


def _book(index, window, slippage, instrument="futures"):
    """(trades, daily, days): one row per trade, the book marked to market each day, every trading day."""
    s = _closes(index, instrument)
    r = s.pct_change().fillna(0.0)
    pos = pd.Series(np.arange(len(s)), index=s.index)
    month = s.index.to_period("M")
    fwd = pos - pos.groupby(month).transform("min") + 1  # 1 = the month's first trading day
    back = pos - pos.groupby(month).transform("max") - 1  # -1 = its last
    ended = pd.Series(month != month[-1], index=s.index)  # the data's last month isn't over: its end is unknown
    held = (((back >= -WINDOWS[window]) & ended) | (fwd <= DAYS_AFTER)).to_numpy().copy()  # days whose return the book earns
    held[0] = False
    cps = xsmr.cost_per_side(slippage)
    trades, i, n = [], 1, len(s)
    while i < n:
        if not held[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and held[j + 1]:
            j += 1
        if j == n - 1 and fwd.iloc[j] < DAYS_AFTER:  # still open today: not a closed trade yet
            break
        entry, exit_ = float(s.iloc[i - 1]), float(s.iloc[j])
        trades.append((s.index[i - 1], s.index[j], entry, exit_, j - i + 1))
        i = j + 1
    t = pd.DataFrame(trades, columns=["entry_day", "day", "entry", "exit", "days_held"])
    t["ret"] = t["exit"] / t["entry"] - 1
    if "factor" in s.attrs and len(t):  # show the contracts' own prices (the adjusted ones give the same returns)
        fac = s.attrs["factor"]
        t["entry"], t["exit"] = t["entry"] * fac.reindex(t["entry_day"]).to_numpy(), t["exit"] * fac.reindex(t["day"]).to_numpy()
    t["cost"] = (1 + t["exit"] / t["entry"]) * cps + 2 * cps  # buy, sale, one roll
    t["net"] = t["ret"] - t["cost"]
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t[col]
    t["w"] = 1.0
    daily = pd.DataFrame({"book_ret": np.where(held, r.to_numpy(), 0.0), "book_cost": 0.0}, index=s.index)
    for row in t.itertuples():
        daily.at[row.entry_day, "book_cost"] += cps + 2 * cps  # the buy and the roll
        daily.at[row.day, "book_cost"] += cps * row.exit / row.entry
    return t, daily, s.index


def results(index="nifty", window="4", slippage=0.0002, instrument="futures"):
    import v2common
    t, daily, days = _book(index, window, slippage, instrument)
    extra = {"in_market_pct": round(float(100 * (daily["book_ret"] != 0).mean()), 1), "avg_days": round(float(t["days_held"].mean()), 1),
             "buy_hold_year_pct": round(float(100 * _closes(index, instrument).pct_change().mean() * v2common.TRADING_DAYS), 2),
             "priced_on": instrument}
    return v2common.build_results(t, days, slippage, extra, daily=daily)


def month_trades(month, index="nifty", window="4", slippage=0.0002, instrument="futures"):
    t, _, _ = _book(index, window, slippage, instrument)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    name = f"{FUTURES[index]} FUT" if instrument == "futures" else INDICES[index]
    return [{"day": r.day.date().isoformat(), "symbol": name,
             "entry_at": f"{r.entry_day.date().isoformat()} 15:30", "exit_at": f"{r.day.date().isoformat()} 15:30",
             "reason": "3rd day of the month", "entry": round(r.entry, 2), "exit": round(r.exit, 2), "days_held": int(r.days_held),
             "weight_pct": 100.0, "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.itertuples()]


# ---- the manual trade's calendar (the dashboard card) --------------------------------------------

HOLIDAYS_URL = "https://zerodha.com/marketintel/holiday-calendar/"  # NSE's list; nseindia.com refuses servers
HOLIDAY_NAMES_KEY = "NSE_TRADING_HOLIDAY_NAMES"  # {date: name}, for the Settings tab
HOLIDAYS_KEY = "NSE_TRADING_HOLIDAYS"  # the last list fetched (JSON dates), used when the fetch fails
_plan_cache = {"day": None, "holidays": None, "source": None, "expiries": None}


def _fetch_holidays():
    """NSE trading holidays (weekdays only) from Zerodha's holiday calendar page."""
    import html
    import json
    import re
    import urllib.request
    from datetime import datetime as dt
    req = urllib.request.Request(HOLIDAYS_URL, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"})
    text = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", text, flags=re.S)
    lines = [x.strip() for x in html.unescape(re.sub(r"<[^>]+>", "\n", text)).split("\n") if x.strip()]
    end = next((i for i, x in enumerate(lines) if x.lower().startswith("settlement holidays")), len(lines))
    days, names = set(), {}
    weekdays = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "long weekend"}
    for i, x in enumerate(lines[:end]):
        if re.fullmatch(r"\d{2} [A-Z][a-z]{2} \d{4}", x) and "nse" in [y.lower() for y in lines[i + 1:i + 9]]:
            d = dt.strptime(x, "%d %b %Y").date()
            if d.weekday() < 5:
                days.add(d)
                # the holiday's name: the first line after the date that isn't its weekday or "Long weekend"
                names[d.isoformat()] = next((y for y in lines[i + 1:i + 4] if y.lower() not in weekdays), "")
    if len(days) < 5:
        raise ValueError(f"only {len(days)} holidays parsed")
    import db
    db.set_settings({HOLIDAYS_KEY: json.dumps(sorted(x.isoformat() for x in days)), HOLIDAY_NAMES_KEY: json.dumps(names)})
    return days


def holiday_list(today):
    """Settings' NSE holidays tab: every weekday NSE is shut (this year's list and any next year's), with its name."""
    import json
    import db
    days, source = _holidays(today)
    stored = db.get_settings([HOLIDAY_NAMES_KEY]).get(HOLIDAY_NAMES_KEY)
    names = json.loads(stored) if stored else {}
    rows = [{"date": d.isoformat(), "weekday": d.strftime("%A"), "name": names.get(d.isoformat(), ""), "past": d < today} for d in sorted(days)]
    upcoming = next((r for r in rows if not r["past"]), None)
    return {"source": source, "holidays": rows, "next": upcoming}


def _holidays(today):
    import json
    from datetime import date as ddate
    if _plan_cache["day"] == today and _plan_cache["holidays"] is not None:
        return _plan_cache["holidays"], _plan_cache["source"]
    try:
        days, source = _fetch_holidays(), "NSE holiday list (via Zerodha)"
    except Exception as error:
        print("Turn of the month: holiday list fetch failed:", error)
        import db
        stored = db.get_settings([HOLIDAYS_KEY]).get(HOLIDAYS_KEY)
        days = {ddate.fromisoformat(x) for x in json.loads(stored)} if stored else set()
        source = "the last holiday list fetched" if stored else "weekdays only (holiday list unavailable)"
    _plan_cache.update(day=today, holidays=days, source=source, expiries=None)
    return days, source


def _trading_days(year, month, holidays):
    import calendar
    from datetime import date as ddate
    n = calendar.monthrange(year, month)[1]
    return [ddate(year, month, d) for d in range(1, n + 1) if ddate(year, month, d).weekday() < 5 and ddate(year, month, d) not in holidays]


def _next_month(y, m):
    return (y + 1, 1) if m == 12 else (y, m + 1)


def _cycle(y, m, holidays):
    """(buy, sell) for month y-m: the close of its 5th-last trading day, the close of the next month's 3rd."""
    days = _trading_days(y, m, holidays)
    ny, nm = _next_month(y, m)
    return days[-(WINDOWS["4"] + 1)], _trading_days(ny, nm, holidays)[DAYS_AFTER - 1]


def _nifty_calls(kite):
    """Every listed Nifty call: [(expiry, strike, tradingsymbol, lot)] (fetched once a day, with the
    Nifty futures: {expiry: tradingsymbol} in _plan_cache["futures"])."""
    if _plan_cache.get("expiries") is None:
        rows = [r for r in kite.instruments("NFO") if r["name"] == "NIFTY"]
        _plan_cache["futures"] = {r["expiry"]: r["tradingsymbol"] for r in rows if r["segment"] == "NFO-FUT"}
        _plan_cache["expiries"] = [(r["expiry"], float(r["strike"]), r["tradingsymbol"], int(r["lot_size"])) for r in rows
                                   if r["segment"] == "NFO-OPT" and r["instrument_type"] == "CE"]
    return _plan_cache["expiries"]


def _nifty_option_expiry(kite, after_month):
    """The Nifty monthly option expiry in the month after `after_month` (y, m): the last expiry that month."""
    y, m = _next_month(*after_month)
    inside = sorted({e for e, _, _, _ in _nifty_calls(kite) if e.year == y and e.month == m})
    return inside[-1] if inside else None


ITM_FROM, ITM_TO = 0.02, 0.035  # the calls considered: 2% to 3.5% below the same-expiry Nifty future (delta about 0.7-0.8)


def _best_call(kite, nifty, expiry):
    """`nifty`: the price the options follow, the Nifty future of that expiry. The in-the-money calls of
    that expiry 2-3.5% below it, with live bid/ask, and the pick: the
    tightest bid-ask spread (% of the mid), ties to the larger open interest. Limit price: the mid."""
    rows = [(k, ts, lot) for e, k, ts, lot in _nifty_calls(kite) if e == expiry and nifty * (1 - ITM_TO - 0.015) <= k <= nifty * (1 - ITM_FROM + 0.015)]
    if not rows:
        return None, []
    q = kite.quote([f"NFO:{ts}" for _, ts, _ in rows])
    out = []
    for k, ts, lot in sorted(rows):
        x = q.get(f"NFO:{ts}") or {}
        depth = x.get("depth") or {}
        bid = ((depth.get("buy") or [{}])[0]).get("price") or None
        ask = ((depth.get("sell") or [{}])[0]).get("price") or None
        ltp = x.get("last_price")
        mid = (bid + ask) / 2 if bid and ask else ltp
        if not mid:
            continue
        out.append({"strike": int(k), "symbol": ts, "lot": lot, "bid": bid, "ask": ask, "ltp": ltp, "oi": x.get("oi"),
                    "mid": round(mid, 2), "limit": round(round(mid / 0.05) * 0.05, 2),
                    "spread_pct": round(100 * (ask - bid) / mid, 2) if bid and ask else None,
                    "itm_pct": round(100 * (1 - k / nifty), 2), "time_value": round(mid - max(0.0, nifty - k), 2),
                    "per_lot": round(mid * lot)})
    priced = [o for o in out if o["spread_pct"] is not None and 100 * ITM_FROM <= o["itm_pct"] <= 100 * ITM_TO]
    best = min(priced, key=lambda o: (o["spread_pct"], -(o["oi"] or 0))) if priced else None
    if best is None:
        return None, []
    i = next(n for n, o in enumerate(out) if o["symbol"] == best["symbol"])
    return best, out[max(0, i - 3): i + 4]  # the pick with 3 strikes either side


def plan(today=None, live=True):
    """The card: this cycle's buy and sell dates, where we are in it, and the in-the-money call to buy."""
    import gapwatch
    import kite_auth
    today = today or gapwatch._now().date()
    holidays, source = _holidays(today)
    y, m = today.year, today.month
    prev = (y - 1, 12) if m == 1 else (y, m - 1)
    buy, sell = _cycle(*prev, holidays)
    month = prev
    if today > sell:
        buy, sell = _cycle(y, m, holidays)
        month = (y, m)
    state = ("buy today (at the close)" if today == buy else "sell today (at the close)" if today == sell
             else "holding" if buy < today < sell else "waiting")
    out = {"buy": buy.isoformat(), "sell": sell.isoformat(), "state": state, "holidays_source": source,
           "days_to_buy": len([d for d in _trading_days(today.year, today.month, holidays) if today < d <= buy]) if today < buy else 0}
    out["call_label"] = "Call held (from the buy day's close)" if buy < today <= sell else "Call to buy"
    if live and kite_auth.status().get("connected"):
        try:
            kite = kite_auth.trading_client()
            exp = _nifty_option_expiry(kite, month)
            fut = _plan_cache.get("futures", {}).get(exp) if exp else None
            keys = ["NSE:NIFTY 50"] + ([f"NFO:{fut}"] if fut else [])
            px = kite.ltp(keys)
            spot = px["NSE:NIFTY 50"]["last_price"]
            nifty = px[f"NFO:{fut}"]["last_price"] if fut and f"NFO:{fut}" in px else spot  # what the options follow
            out.update(nifty=round(spot, 2), future=round(nifty, 2) if fut else None, future_symbol=fut,
                       basis_pct=round(100 * (nifty / spot - 1), 2) if fut else None)
            base = nifty
            if buy < today <= sell:  # bought already: the strike the buy day's close gave
                with connect() as c, c.cursor() as cur:
                    cur.execute("SELECT close FROM bt_daily WHERE symbol = 'NIFTY 50' AND day = %s", (buy,))
                    row = cur.fetchone()
                base = row[0] * nifty / spot if row else None  # the buy day's close, on the future's level
                out["buy_close"] = round(row[0], 2) if row else None
            out.update(strike=int(base * 0.975 // 100 * 100) if base else None, expiry=exp.isoformat() if exp else None)
            if exp and not buy < today <= sell:  # before the buy: the best call to buy now, from live prices
                best, calls = _best_call(kite, nifty, exp)
                out.update(best=best, calls=calls, quoted_at=gapwatch._now().strftime("%H:%M:%S"))
                if best:
                    out["strike"] = best["strike"]
        except Exception as error:
            out["live_error"] = str(error)
    return out
