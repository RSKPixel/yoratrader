"""Long Trend Low Volatility (Laurens Bensdorp, Automated Stock Trading Systems, 2020), long, F&O stocks.

- Market filter: the Nifty 50 closed above its 200-day average (no new buys otherwise; held stocks stay).
- Setup: the stock closed above its own 200-day average.
- Rank: the lowest volatility (standard deviation of the last 100 daily returns) first; free slots are
  filled at the close, up to max open N (10 in the book), capital / N each.
- Exit: a 20% trailing stop on the close (20% under the highest close since the buy): sold at the close
  that ends at or below it. Nothing else; a stock whose data ends is sold at its last close.

Data: daily closes of today's F&O stocks (2005 on, after 200 days of history), so survivorship-biased;
the survivorship-free test (each month's actual F&O list) gave 10.5% a year, Sharpe 0.83, worst drop -33%.
Returns: a move over 20% in a day (a split, a bad print) counts as no move.
Instrument: "cash" (delivery, the default: positions last months, so no rolls): STT 0.1% on the buy and
the sale, stamp duty on the buy, exchange + SEBI fees with GST, DP charge on the sale, slippage; or
"futures": NSE futures charges + slippage on the buy and the sale, and a roll (both sides) every month end.
"""

import threading
import time

import numpy as np
import pandas as pd

import xsmom
import xsmr
from db import connect

START = "2005-01-01"
SMA_DAYS, VOL_DAYS = 200, 100
TRAILS = {"20": 0.20, "15": 0.15, "25": 0.25}  # 20% is the book's
INSTRUMENTS = ("cash", "futures")
# Delivery (cash) charges: STT both sides, stamp duty on buys, NSE exchange + SEBI fees (GST on them),
# a DP charge on each sale (about Rs 18 on a Rs 1 lakh position); no brokerage on delivery (Zerodha).
CASH_STT, CASH_STAMP_BUY, CASH_EXCHANGE, CASH_SEBI, GST = 0.001, 0.00015, 0.0000297, 0.000001, 0.18
DP_PER_SALE, POSITION_RS = 18.0, 100000.0


def cash_cost_per_side(slippage=0.0002):
    """Cost of trading one rupee once in delivery, averaged over buys and sells."""
    return CASH_STT + CASH_STAMP_BUY / 2 + (CASH_EXCHANGE + CASH_SEBI) * (1 + GST) + DP_PER_SALE / POSITION_RS / 2 + slippage
BOOK_OPEN = 10
CACHE_SECONDS = 6 * 3600
DATASETS = ("fno", "fnopit", "cash500")  # fnopit / cash500: survivorship-free (pit.py, cash500.py): only each month's list can be bought
_cache, _lock = {}, threading.Lock()


def _data(dataset="fno"):
    with _lock:
        hit = _cache.get(dataset)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    c = xsmom._closes(dataset)
    r, bad, history = xsmom.gap_aware(c)
    r = r.where(~bad, 0.0)
    px = (1 + r.fillna(0.0)).cumprod().where(c.notna())  # a price index (splits and bad prints taken out)
    pf = px.ffill()
    has = c.notna()
    up = (pf > pf.rolling(SMA_DAYS, min_periods=int(0.9 * SMA_DAYS)).mean()) & history(SMA_DAYS) & has
    vol = r.rolling(VOL_DAYS, min_periods=int(0.9 * VOL_DAYS)).std().where(history(VOL_DAYS))
    with connect() as conn:
        n = pd.read_sql("SELECT day, close FROM bt_daily WHERE symbol = 'NIFTY 50' AND close > 0 ORDER BY day", conn,
                        parse_dates=["day"]).set_index("day")["close"]
    n = n.reindex(c.index).ffill()
    market = n > n.rolling(SMA_DAYS, min_periods=180).mean()
    import pit
    src = pit.source(dataset)
    if src:
        up = up & src.member_mask(c.index, c.columns)
        if hasattr(src, "tradable_mask"):
            up = up & src.tradable_mask(c.index, c.columns)
    data = {"c": c, "r": r.fillna(0.0), "pf": pf, "has": has, "up": up, "vol": vol, "market": market}
    with _lock:
        _cache[dataset] = (time.time(), data)
    return data


def invalidate():
    with _lock:
        _cache.clear()


def _book(max_open, trail, slippage, instrument="cash", dataset="fno"):
    d = _data(dataset)
    if dataset == "cash500":  # most of these stocks have no futures: cash, and wider spreads
        import cash500
        instrument, slippage = "cash", slippage + cash500.EXTRA_SLIPPAGE
    n = max_open or BOOK_OPEN
    tr = TRAILS[trail]
    futures = instrument == "futures"
    cps = xsmr.cost_per_side(slippage) if futures else cash_cost_per_side(slippage)
    roll = 2 if futures else 0  # a futures roll is a sale and a buy
    idx = d["c"].index
    cols = list(d["c"].columns)
    pf, has, up, vol, r, c = d["pf"].to_numpy(), d["has"].to_numpy(), d["up"].to_numpy(), d["vol"].to_numpy(), d["r"].to_numpy(), d["c"].to_numpy()
    market = d["market"].to_numpy()
    month_end = (idx.to_series().dt.month != idx.to_series().shift(-1).dt.month).to_numpy()
    start = idx.searchsorted(pd.Timestamp(START))
    held = {}  # column -> dict(buy_i, buy, peak, stop, rolls)
    trades, book_ret, book_cost = [], np.zeros(len(idx)), np.zeros(len(idx))
    for i in range(start, len(idx)):
        # the day's returns on what was held after yesterday's close
        for j in held:
            book_ret[i] += r[i, j] / n
        out = []
        for j, h in held.items():
            if not has[i, j]:
                if i + 1 >= len(idx) or not has[i + 1:i + 6, j].any():  # data ended: out at the last close
                    out.append((j, "data ended", h["last_i"]))
                continue
            h["last_i"] = i
            p = pf[i, j]
            if p <= h["stop"]:
                out.append((j, "trailing stop", i))
            else:
                h["peak"] = max(h["peak"], p)
                h["stop"] = max(h["stop"], h["peak"] * (1 - tr))
        for j, reason, k in out:
            h = held.pop(j)
            trades.append((cols[j], idx[h["buy_i"]], idx[k], h["buy"], float(c[k, j]), h["buy_px"], float(pf[k, j]), reason, h["rolls"], k - h["buy_i"]))
            book_cost[i] += cps / n
        if market[i] and len(held) < n:
            ok = np.where(up[i] & ~np.isnan(vol[i]))[0]
            ok = [j for j in ok[np.argsort(vol[i, ok])] if j not in held]
            for j in ok[: n - len(held)]:
                p = pf[i, j]
                held[j] = {"buy_i": i, "buy": float(c[i, j]), "buy_px": p, "peak": p, "stop": p * (1 - tr), "rolls": 0, "last_i": i}
                book_cost[i] += cps / n
        if month_end[i] and i + 1 < len(idx):
            for h in held.values():
                h["rolls"] += 1
            book_cost[i] += len(held) * roll * cps / n
    t = pd.DataFrame(trades, columns=["symbol", "entry_day", "day", "buy", "sell", "buy_px", "sell_px", "reason", "rolls", "held"])
    t["ret"] = t["sell_px"] / t["buy_px"] - 1
    t["cost"] = (1 + t["sell_px"] / t["buy_px"] + roll * t["rolls"]) * cps
    t["net"] = t["ret"] - t["cost"]
    t["w"] = 1.0 / n
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t["w"] * t[col]
    daily = pd.DataFrame({"book_ret": book_ret, "book_cost": book_cost}, index=idx).iloc[start:]
    return t, idx[start:], daily, held, n


def results(max_open=10, trail="20", slippage=0.0002, instrument="cash", dataset="fno"):
    import v2common
    t, days, daily, held, n = _book(max_open, trail, slippage, instrument, dataset)
    d = _data(dataset)
    cols, idx, last = d["c"].columns, d["c"].index, len(d["c"].index) - 1
    open_rows = sorted(({"symbol": cols[j], "entry_at": f"{idx[h['buy_i']].date().isoformat()} 15:30", "entry": round(h["buy"], 2),
                         "last": round(float(d["c"].iloc[h["last_i"], j]), 2), "days_held": last - h["buy_i"],
                         "ret_pct": round(100 * float(d["pf"].iloc[h["last_i"], j] / h["buy_px"] - 1), 2),
                         "peak_pct": round(100 * float(h["peak"] / h["buy_px"] - 1), 2),
                         "to_stop_pct": round(100 * float(h["stop"] / d["pf"].iloc[h["last_i"], j] - 1), 2)}
                        for j, h in held.items()), key=lambda x: x["entry_at"])
    extra = {"open_positions": open_rows,
             "avg_days": round(float(t["held"].mean()), 1) if len(t) else None,
             "avg_open": round(float(t["held"].sum() / max(1, len(days))), 1), "open_now": len(held), "max_open": n,
             "in_market_pct": round(float(100 * (daily["book_ret"] != 0).mean()), 1)}
    if dataset == "cash500":
        import cash500
        instrument, slippage = "cash", slippage + cash500.EXTRA_SLIPPAGE
    extra["instrument"] = instrument
    out = v2common.build_results(t, days, slippage, extra, daily=daily)
    if out.get("summary") and instrument == "cash":
        out["summary"]["cost_per_side_bps"] = round(10000 * cash_cost_per_side(slippage), 2)
    return out


def month_trades(month, max_open=10, trail="20", slippage=0.0002, instrument="cash", dataset="fno"):
    """The trades sold in the month, then the ones bought in it that are still held (marked open: their
    result so far shows, but adds nothing to the month's total until they're sold)."""
    t, _, _, held, n = _book(max_open, trail, slippage, instrument, dataset)
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    d = _data(dataset)
    cols, idx = d["c"].columns, d["c"].index
    still = [{"day": idx[h["last_i"]].date().isoformat(), "symbol": cols[j], "open": True,
              "entry_at": f"{idx[h['buy_i']].date().isoformat()} 15:30", "exit_at": "open", "reason": "still held",
              "entry": round(h["buy"], 2), "exit": round(float(d["c"].iloc[h["last_i"], j]), 2), "days_held": len(idx) - 1 - h["buy_i"],
              "rolls": h["rolls"], "weight_pct": round(100 / n, 2),
              "ret_pct": round(100 * float(d["pf"].iloc[h["last_i"], j] / h["buy_px"] - 1), 3), "cost_pct": 0.0,
              "net_pct": round(100 * float(d["pf"].iloc[h["last_i"], j] / h["buy_px"] - 1), 3), "book_net_pct": 0.0, "book_cost_pct": 0.0}
             for j, h in held.items() if idx[h["buy_i"]].strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "symbol": r.symbol,
             "entry_at": f"{r.entry_day.date().isoformat()} 15:30", "exit_at": f"{r.day.date().isoformat()} 15:30",
             "reason": r.reason, "entry": round(r.buy, 2), "exit": round(r.sell, 2), "days_held": int(r.held), "rolls": int(r.rolls),
             "weight_pct": round(100 * float(r.w), 2), "ret_pct": round(100 * float(r.ret), 3), "cost_pct": round(100 * float(r.cost), 3),
             "net_pct": round(100 * float(r.net), 3), "book_net_pct": round(100 * float(r.book_net), 4),
             "book_cost_pct": round(100 * float(r.book_cost), 4)}
            for r in t.sort_values(["day", "symbol"]).itertuples()] + sorted(still, key=lambda x: (x["entry_at"], x["symbol"]))
