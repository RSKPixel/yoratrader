"""Option straddles on Nifty and Bank Nifty monthly options (NSE daily bhavcopies, optdata.bt_opt_daily).

Strategy "vrp" (Euan Sinclair, Volatility Trading): the monthly short straddle, sold only when its implied
volatility (from its price: an at-the-money straddle ~ 0.8 x future x vol x sqrt(time left)) is above the
index's actual volatility over the last 20 trading days; no trade that month otherwise.

Strategy "late": the short straddle sold LATE_DAYS (10) trading days before expiry, held to expiry.
Strategy "long": the straddle BOUGHT 10 trading days before expiry, only when the index's last 7-day move was
within +-1% (a quiet week); held to expiry (STT 0.125% on the intrinsic value of a leg exercised in the money).

Strategy "fly" (iron butterfly): the same, plus a bought call and put at the strikes nearest 5% above and
below the sold strike (traded that day), so the worst loss is capped at the wing width less the credit.

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
STRATEGIES = ("short", "fly", "late", "long", "vrp")
# fly: the iron butterfly (the short straddle + bought wings ~5% away); late: the short straddle sold
# LATE_DAYS trading days before expiry; long: the straddle BOUGHT LATE_DAYS before expiry, only after a
# quiet week (the index's last QUIET_DAYS-day move within +-QUIET_MOVE)
LATE_DAYS, QUIET_DAYS, QUIET_MOVE = 10, 7, 0.01
RV_DAYS = 20  # vrp: the index's actual volatility over the last 20 trading days
STT_EXERCISE = 0.00125  # on the intrinsic value of a bought option exercised at expiry
SPOT = {"NIFTY": "NIFTY 50", "BANKNIFTY": "NIFTY BANK"}
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


WING = 0.05  # the iron butterfly's bought call / put: the strikes nearest 5% above / below the sold strike


def _legs(o, K, strategy):
    """[(type, strike, qty)] for the position: qty -1 sold, +1 bought; None when a wing didn't trade."""
    if strategy == "long":
        return [("CE", K, 1), ("PE", K, 1)]
    legs = [("CE", K, -1), ("PE", K, -1)]
    if strategy == "fly":
        ce = np.sort(o.loc[o["type"] == "CE", "strike"].unique())
        pe = np.sort(o.loc[o["type"] == "PE", "strike"].unique())
        if not len(ce) or not len(pe):
            return None
        kc, kp = float(ce[np.argmin(np.abs(ce - K * (1 + WING)))]), float(pe[np.argmin(np.abs(pe - K * (1 - WING)))])
        if kc <= K or kp >= K:
            return None
        legs += [("CE", kc, 1), ("PE", kp, 1)]
    return legs


def _book(index, strategy, slippage):
    sym = INDICES[index]
    f = _data(sym)
    slip = SLIPPAGES[slippage]
    fut = f[f["type"] == "FUT"]
    opt = f[f["type"] != "FUT"]
    days = pd.DatetimeIndex(sorted(f["day"].unique()))
    expiries = sorted(set(opt["expiry"]))
    trades, marks, skipped = [], [], 0
    spot = None
    if strategy in ("long", "vrp"):
        with connect() as conn:
            spot = pd.read_sql("SELECT day, close FROM bt_daily WHERE symbol = %s AND close > 0 ORDER BY day", conn,
                               params=[SPOT[sym]], parse_dates=["day"]).set_index("day")["close"]
        spot = spot[spot.index.dayofweek < 5]
        move = (spot / spot.shift(QUIET_DAYS) - 1)
        rv = np.log(spot).diff().rolling(RV_DAYS, min_periods=RV_DAYS - 2).std() * np.sqrt(252)
    for prev_exp, exp in zip(expiries, expiries[1:]):
        cycle = days[(days > prev_exp) & (days <= exp)]
        if not len(cycle) or cycle[0] >= exp:
            continue
        if strategy in ("late", "long"):
            if len(cycle) <= LATE_DAYS:
                continue
            entry = cycle[-(LATE_DAYS + 1)]  # LATE_DAYS trading days left after it
            if strategy == "long":
                mv = move.get(entry)
                if mv is None or pd.isna(mv) or abs(mv) > QUIET_MOVE:
                    continue  # not a quiet week: no trade this month
        else:
            entry = cycle[0]
        fe = fut[(fut["day"] == entry) & (fut["expiry"] == exp)]
        fx = fut[(fut["day"] == exp) & (fut["expiry"] == exp)]
        if fe.empty or fx.empty:
            continue
        F0 = float(fe["close"].iloc[0])
        o = opt[(opt["day"] == entry) & (opt["expiry"] == exp) & (opt["contracts"] > 0)]
        both = o.groupby("strike")["type"].nunique()
        strikes = both[both == 2].index.to_numpy()
        if not len(strikes):
            continue
        K = float(strikes[np.argmin(np.abs(strikes - F0))])
        legs = _legs(o, K, strategy)
        iv = rv_now = None
        if strategy == "vrp":  # Sinclair: sell only when implied volatility is above the actual volatility
            left = int(((days > entry) & (days <= exp)).sum())
            prem_atm = float(o[(o["strike"] == K)]["close"].sum())
            iv = prem_atm / (0.798 * F0 * np.sqrt(max(left, 1) / 252))  # an at-the-money straddle ~ 0.8 x F x vol x sqrt(T)
            rv_now = rv.get(entry)
            if rv_now is None or pd.isna(rv_now) or iv <= rv_now:
                continue
        if legs is None:
            skipped += 1
            continue
        px0 = {(t, k): float(o[(o["type"] == t) & (o["strike"] == k)]["close"].iloc[0]) for t, k, _ in legs}
        sold = sum(px0[(t, k)] for t, k, q in legs if q < 0)
        bought = sum(px0[(t, k)] for t, k, q in legs if q > 0)
        credit = sold - bought
        S = float(fx["settle"].iloc[0] or fx["close"].iloc[0])
        intrinsic = lambda t, k: max(S - k, 0.0) if t == "CE" else max(k - S, 0.0)
        payout = sum(-q * intrinsic(t, k) for t, k, q in legs)  # what the position pays out at expiry (net)
        cost = (_charges(sold, bought, len(legs), F0 * LOTS[sym]) + slip * (sold + bought)
                + STT_EXERCISE * sum(intrinsic(t, k) for t, k, q in legs if q > 0))  # bought legs exercised in the money
        width = max(max(k - K for t, k, q in legs if q > 0 and t == "CE"), max(K - k for t, k, q in legs if q > 0 and t == "PE")) if strategy == "fly" else None
        trades.append({"entry_day": entry, "day": pd.Timestamp(exp), "strike": K, "fut": F0, "ce": px0[("CE", K)], "pe": px0[("PE", K)],
                       "premium": credit, "sold": sold, "bought": bought, "settle": S, "payout": payout, "pnl_pts": credit - payout,
                       "cost_pts": cost, "legs": legs, "width": width, "iv": iv, "rv": rv_now,
                       "days_held": int(((days > entry) & (days <= exp)).sum())})
        # daily marks: the position's value at each close (a leg that didn't trade: its settlement price)
        span = days[(days >= entry) & (days <= exp)]
        value = pd.Series(0.0, index=span)
        for t, k, q in legs:
            lg = opt[(opt["expiry"] == exp) & (opt["strike"] == k) & (opt["type"] == t) & (opt["day"] >= entry) & (opt["day"] <= exp)]
            px = pd.Series(np.where(lg["contracts"] > 0, lg["close"], lg["settle"]), index=lg["day"]).groupby(level=0).last()
            px = px.reindex(span).ffill().fillna(px0[(t, k)])
            px.iloc[0] = px0[(t, k)]
            px.iloc[-1] = intrinsic(t, k)
            value += q * px
        d = value.diff().fillna(0.0)  # the position's gain each day (sold legs gain as their price falls)
        for day, pts in d.items():
            marks.append((day, pts, F0))
    t = pd.DataFrame(trades)
    if t.empty:
        return t, days, pd.DataFrame(columns=["book_ret", "book_cost"]), skipped
    t["ret"] = t["pnl_pts"] / t["fut"]
    t["cost"] = t["cost_pts"] / t["fut"]
    t["net"] = t["ret"] - t["cost"]
    t["w"] = 1.0
    for col in ("ret", "cost", "net"):
        t[f"book_{col}"] = t[col]
    m = pd.DataFrame(marks, columns=["day", "pts", "notional"])
    daily = pd.DataFrame({"book_ret": (m["pts"] / m["notional"]).groupby(m["day"]).sum()})
    daily["book_cost"] = t.groupby("entry_day")["cost"].sum().reindex(daily.index).fillna(0.0)
    return t, days, daily.reindex(days, fill_value=0.0), skipped


def results(index="nifty", strategy="short", slippage="0.5"):
    import v2common
    t, days, daily, skipped = _book(index, strategy, slippage)
    if t.empty:
        return {"summary": None}
    sym = INDICES[index]
    lot = LOTS[sym]
    extra = {"avg_premium_pct": round(float(100 * (t["premium"] / t["fut"]).mean()), 2),
             "avg_days": round(float(t["days_held"].mean()), 1),
             "worst_month_pct": round(float(100 * t["net"].min()), 2), "best_month_pct": round(float(100 * t["net"].max()), 2),
             "lot": lot, "last_premium_rs": round(float(t["premium"].iloc[-1] * lot)),
             "avg_net_rs_per_lot": round(float((t["pnl_pts"] - t["cost_pts"]).mean() * lot)),
             "trades_label": "Months", "skipped_months": skipped, "strategy": strategy}
    if strategy == "fly":
        risk = ((t["width"] - t["premium"]) / t["fut"]).clip(lower=0)  # the most a month can lose (before costs)
        extra.update(avg_width_pct=round(float(100 * (t["width"] / t["fut"]).mean()), 2),
                     avg_max_loss_pct=round(float(100 * risk.mean()), 2),
                     return_on_risk_year_pct=round(float(100 * t["net"].mean() * 12 / risk.mean()), 1) if risk.mean() > 0 else None)
    return v2common.build_results(t, days[days >= t["entry_day"].min()], 0.0, extra, daily=daily)


def month_trades(month, index="nifty", strategy="short", slippage="0.5"):
    t, _, _, _ = _book(index, strategy, slippage)
    if t.empty:
        return []
    t = t[t["day"].dt.strftime("%Y-%m") == month]
    lot = LOTS[INDICES[index]]
    return [{"day": r.day.date().isoformat(), "entry_at": f"{r.entry_day.date().isoformat()} close", "exit_at": f"{r.day.date().isoformat()} expiry",
             "symbol": ("Bought " if strategy == "long" else "") + f"{INDICES[index]} {int(r.strike)} CE + PE" + (f" · wings {int(max(k for t_, k, q in r.legs if t_ == 'CE'))} CE / {int(min(k for t_, k, q in r.legs if t_ == 'PE'))} PE" if strategy == "fly" else ""),
             "strike": r.strike, "credit": round(r.premium, 2), "bought": round(r.bought, 2), "fut": round(r.fut, 2),
             "ce": round(r.ce, 2), "pe": round(r.pe, 2), "premium": round(r.premium, 2), "settle": round(r.settle, 2),
             "payout": round(r.payout, 2), "days_held": int(r.days_held), "ret_pct": round(100 * r.ret, 3),
             "cost_pct": round(100 * r.cost, 3), "net_pct": round(100 * r.net, 3), "book_net_pct": round(100 * r.net, 3),
             "book_cost_pct": round(100 * r.cost, 3), "weight_pct": 100.0, "net_rs_lot": round((r.pnl_pts - r.cost_pts) * lot)}
            for r in t.itertuples()]
