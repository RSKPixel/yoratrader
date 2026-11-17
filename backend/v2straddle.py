"""Option straddles on Nifty and Bank Nifty monthly options (NSE daily bhavcopies, optdata.bt_opt_daily).

Strategy "short" (monthly short straddle, held to expiry):
- Entry: at the close of the first trading day after a monthly expiry, sell the at-the-money call and put
  of the next monthly expiry (the strike nearest that expiry's future, both legs traded that day).
- Exit: held to expiry; settled at the final settlement price (the expiry day's future settlement):
  the short pays |settlement - strike|. No stop, no adjustment.
- One straddle at a time, every month.

Returns are on the contract value (the future at entry x 1 unit): a fully funded position, no leverage.
On margin (roughly 12% of the contract value for a short straddle) returns AND drawdowns are about 8x.
The book is marked to market at each close (both legs' closes, the settlement price where a leg didn't
trade). Costs, today's option charges for every year: STT 0.15% of the premium sold, NSE 0.0355% and
SEBI fees with GST, stamp duty 0.003% on premium bought, Rs 20 an order; plus slippage as a share of
the premium (per side, per leg); no closing trade at expiry (settled by the exchange).
"""

import threading
import time

import numpy as np
import pandas as pd

from db import connect

INDICES = {"nifty": "NIFTY", "banknifty": "BANKNIFTY"}
STRATEGIES = ("short",)
SLIPPAGES = {"0.25": 0.0025, "0.5": 0.005, "1": 0.01}  # of the premium, per side per leg
STT_SELL, EXCHANGE, SEBI, STAMP_BUY, GST, BROKERAGE = 0.0015, 0.000355, 0.000001, 0.00003, 0.18, 20.0
LOTS = {"NIFTY": 65, "BANKNIFTY": 30}  # today's lot sizes, for rupees per lot
CACHE_SECONDS = 6 * 3600
_cache, _lock = {}, threading.Lock()


def _data(symbol):
    with _lock:
        hit = _cache.get(symbol)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    with connect() as conn:
        f = pd.read_sql("SELECT day, expiry, strike, type, close, settle, contracts FROM bt_opt_daily WHERE symbol = %s",
                        conn, params=[symbol], parse_dates=["day", "expiry"])
    with _lock:
        _cache[symbol] = (time.time(), f)
    return f


def invalidate():
    with _lock:
        _cache.clear()


def _charges(premium_sold, premium_bought, orders, notional):
    """Option charges in index points on the premiums traded (per unit)."""
    turnover = premium_sold + premium_bought
    brokerage = orders * BROKERAGE / max(notional, 1.0) * 1.0  # per unit of an index-sized notional: tiny
    fees = turnover * (EXCHANGE + SEBI) * (1 + GST)
    return premium_sold * STT_SELL + premium_bought * STAMP_BUY + fees + brokerage * (1 + GST)


def _book(index, strategy, slippage):
    sym = INDICES[index]
    f = _data(sym)
    slip = SLIPPAGES[slippage]
    fut = f[f["type"] == "FUT"]
    opt = f[f["type"] != "FUT"]
    days = pd.DatetimeIndex(sorted(f["day"].unique()))
    expiries = sorted(set(opt["expiry"]))
    trades, marks = [], []  # marks: (day, pnl in points, entry notional)
    for prev_exp, exp in zip(expiries, expiries[1:]):
        after = days[days > prev_exp]
        if not len(after) or after[0] >= exp:
            continue
        entry = after[0]
        fe = fut[(fut["day"] == entry) & (fut["expiry"] == exp)]
        if fe.empty:
            continue
        F0 = float(fe["close"].iloc[0])
        o = opt[(opt["day"] == entry) & (opt["expiry"] == exp) & (opt["contracts"] > 0)]
        both = o.groupby("strike")["type"].nunique()
        strikes = both[both == 2].index.to_numpy()
        if not len(strikes):
            continue
        K = float(strikes[np.argmin(np.abs(strikes - F0))])
        legs = o[o["strike"] == K].set_index("type")["close"]
        ce0, pe0 = float(legs["CE"]), float(legs["PE"])
        prem = ce0 + pe0
        # expiry settlement: the future's settlement price on expiry day
        fx = fut[(fut["day"] == exp) & (fut["expiry"] == exp)]
        if fx.empty:
            continue
        S = float(fx["settle"].iloc[0] or fx["close"].iloc[0])
        payout = abs(S - K)
        cost = _charges(prem, 0.0, 2, F0 * LOTS[sym]) + slip * prem
        pnl = prem - payout  # points per unit, before costs
        trades.append({"entry_day": entry, "day": pd.Timestamp(exp), "strike": K, "fut": F0, "ce": ce0, "pe": pe0, "premium": prem,
                       "settle": S, "payout": payout, "pnl_pts": pnl, "cost_pts": cost, "days_held": int(((days > entry) & (days <= exp)).sum())})
        # daily marks: the straddle's value at each close (a leg that didn't trade: its settlement price)
        legs_t = opt[(opt["expiry"] == exp) & (opt["strike"] == K) & (opt["day"] >= entry) & (opt["day"] <= exp)]
        val = legs_t.assign(px=np.where(legs_t["contracts"] > 0, legs_t["close"], legs_t["settle"])).pivot_table(
            index="day", columns="type", values="px", aggfunc="last").reindex(days[(days >= entry) & (days <= exp)]).ffill()
        v = (val.get("CE", 0.0) + val.get("PE", 0.0)).astype(float)
        v.iloc[0] = prem
        v.iloc[-1] = payout  # expiry: settled at intrinsic
        d = -(v.diff().fillna(0.0))  # short: gains when the straddle's value falls
        for day, pts in d.items():
            marks.append((day, pts, F0))
        marks.append((entry, -cost, F0))
    t = pd.DataFrame(trades)
    if t.empty:
        return t, days, pd.DataFrame(columns=["book_ret", "book_cost"])
    t["ret"] = t["pnl_pts"] / t["fut"]
    t["cost"] = t["cost_pts"] / t["fut"]
    t["net"] = t["ret"] - t["cost"]
    t["w"] = 1.0
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t[col]
    m = pd.DataFrame(marks, columns=["day", "pts", "notional"])
    m["r"] = m["pts"] / m["notional"]
    daily = pd.DataFrame({"book_ret": m[m["pts"] == m["pts"]].groupby("day")["r"].sum()})
    cost_daily = pd.Series(0.0, index=daily.index)
    for row in t.itertuples():
        cost_daily.loc[row.entry_day] = cost_daily.get(row.entry_day, 0.0) + row.cost
    daily["book_ret"] = daily["book_ret"] + cost_daily  # the cost marks were subtracted in book_ret above
    daily["book_cost"] = cost_daily
    return t, days, daily.reindex(days, fill_value=0.0)


def results(index="nifty", strategy="short", slippage="0.5"):
    import v2common
    t, days, daily = _book(index, strategy, slippage)
    if t.empty:
        return {"summary": None}
    sym = INDICES[index]
    lot = LOTS[sym]
    extra = {"avg_premium_pct": round(float(100 * (t["premium"] / t["fut"]).mean()), 2),
             "avg_days": round(float(t["days_held"].mean()), 1),
             "worst_month_pct": round(float(100 * t["net"].min()), 2), "best_month_pct": round(float(100 * t["net"].max()), 2),
             "lot": lot, "last_premium_rs": round(float(t["premium"].iloc[-1] * lot)),
             "avg_net_rs_per_lot": round(float((t["pnl_pts"] - t["cost_pts"]).mean() * lot)),
             "trades_label": "Months"}
    return v2common.build_results(t, days[days >= t["entry_day"].min()], 0.0, extra, daily=daily)


def month_trades(month, index="nifty", strategy="short", slippage="0.5"):
    t, _, _ = _book(index, strategy, slippage)
    if t.empty:
        return []
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    lot = LOTS[INDICES[index]]
    return [{"day": r.day.date().isoformat(), "entry_at": f"{r.entry_day.date().isoformat()} close", "exit_at": f"{r.day.date().isoformat()} expiry",
             "symbol": f"{INDICES[index]} {int(r.strike)} CE + PE", "strike": r.strike, "fut": round(r.fut, 2),
             "ce": round(r.ce, 2), "pe": round(r.pe, 2), "premium": round(r.premium, 2), "settle": round(r.settle, 2),
             "payout": round(r.payout, 2), "days_held": int(r.days_held), "ret_pct": round(100 * r.ret, 3),
             "cost_pct": round(100 * r.cost, 3), "net_pct": round(100 * r.net, 3), "book_net_pct": round(100 * r.net, 3),
             "book_cost_pct": round(100 * r.cost, 3), "weight_pct": 100.0, "net_rs_lot": round((r.pnl_pts - r.cost_pts) * lot)}
            for r in t.itertuples()]
