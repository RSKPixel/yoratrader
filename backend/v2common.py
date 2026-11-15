"""Shared result-building for the v2 backtest pages: a table of trades, each with its share of
capital, turned into the cards, equity, years and months the pages show (all as % of capital)."""

import numpy as np
import pandas as pd

import xsmr

TRADING_DAYS = xsmr.TRADING_DAYS


def build_results(t, days, slippage, extra=None, daily=None):
    """t: one row per closed trade with day (the day its result counts: the exit), ret / cost / net
    (on the position's own value) and book_ret / book_cost / book_net (its share of capital).
    days: every trading day in the span (flat days count for Sharpe and the equity).
    daily: for multi-day holdings, the book marked to market each day (index day; book_ret, book_cost):
    the equity, drawdown, Sharpe, yearly and monthly results come from it, so moves inside a holding
    show when they happen instead of all on its exit day. Trade counts and win rates still come from t."""
    if t.empty:
        return {"summary": None}
    days = days[days >= t["day"].min()]
    if daily is not None:
        daily = daily.reindex(days, fill_value=0.0)[["book_ret", "book_cost"]].copy()
        daily["book_net"] = daily["book_ret"] - daily["book_cost"]
    else:
        daily = t.groupby("day")[["book_ret", "book_net", "book_cost"]].sum().reindex(days, fill_value=0.0)
    eq = daily["book_net"].cumsum()
    r = daily["book_net"]
    wins, losses = t.loc[t["book_net"] > 0, "book_net"].sum(), -t.loc[t["book_net"] < 0, "book_net"].sum()
    yearly = daily.groupby(daily.index.year)["book_net"].sum()
    weekly = daily[["book_ret", "book_net"]].resample("W-FRI").sum().cumsum()
    summary = {
        "trades": int(len(t)), "days_traded": int(t["day"].nunique()), "days": int(len(days)),
        "from": days[0].date().isoformat(), "to": days[-1].date().isoformat(),
        "win_rate": round(float(100 * (t["net"] > 0).mean()), 1),
        "win_rate_gross": round(float(100 * (t["ret"] > 0).mean()), 1),
        "gross_pct": round(float(100 * daily["book_ret"].sum()), 3),
        "cost_pct": round(float(100 * daily["book_cost"].sum()), 3),
        "net_pct": round(float(100 * daily["book_net"].sum()), 3),
        "avg_cost_pct": round(float(100 * t["book_cost"].mean()), 4),
        "avg_net_pct": round(float(100 * t["book_net"].mean()), 4),
        "avg_trade_net_pct": round(float(100 * t["net"].mean()), 3),
        "profit_factor": round(float(wins / losses), 2) if losses > 0 else None,
        "max_dd_pct": round(float(100 * (eq - eq.cummax()).min()), 3),
        "net_year_pct": round(float(100 * r.mean() * TRADING_DAYS), 2),
        "sharpe": round(float(r.mean() / r.std() * np.sqrt(TRADING_DAYS)), 2) if r.std() else None,
        "green_years": int((yearly > 0).sum()), "years": int(len(yearly)),
        "cost_per_side_bps": round(10000 * xsmr.cost_per_side(slippage), 2),
        **(extra or {}),
    }
    return {
        "summary": summary,
        "equity": [{"date": d.date().isoformat(), "gross": round(float(100 * g), 3), "net": round(float(100 * n), 3)}
                   for d, g, n in zip(weekly.index, weekly["book_ret"], weekly["book_net"])],
        "years": _periods(t, daily, "year"),
        "months": _periods(t, daily, "month"),
    }


def _periods(t, daily, kind):
    """Net per year or month from the daily book; trades and win rates from the trades closed in it."""
    key_t = t["day"].dt.year if kind == "year" else t["day"].dt.strftime("%Y-%m")
    key_d = daily.index.year if kind == "year" else daily.index.strftime("%Y-%m")
    net, gross = daily.groupby(key_d)["book_net"].sum(), daily.groupby(key_d)["book_ret"].sum()
    trades = t.groupby(key_t)
    counts, wins = trades.size(), trades["net"].apply(lambda x: (x > 0).mean())
    out = []
    for k in net.index:
        n = int(counts.get(k, 0))
        if n == 0 and abs(net[k]) < 1e-12:
            continue
        row = {kind: (int(k) if kind == "year" else k), "trades": n,
               "win_rate": round(float(100 * wins[k]), 1) if n else None, "net_pct": round(float(100 * net[k]), 3)}
        if kind == "year":
            row["gross_pct"] = round(float(100 * gross[k]), 3)
        out.append(row)
    return out


def trading_days(dataset, since):
    from db import connect
    with connect() as conn:
        d = pd.read_sql("SELECT DISTINCT d.day FROM bt_daily d JOIN bt_symbols s ON s.symbol = d.symbol "
                        "WHERE s.dataset = %s AND d.day >= %s ORDER BY d.day", conn, params=[dataset, since])
    return pd.DatetimeIndex(pd.to_datetime(d["day"]))
