"""Shared result-building for the v2 backtest pages: a table of trades, each with its share of
capital, turned into the cards, equity, years and months the pages show (all as % of capital)."""

import numpy as np
import pandas as pd

import xsmr

TRADING_DAYS = xsmr.TRADING_DAYS


CLOSE = "15:30 close"
STOP_INTRADAY = "stop, intraday"  # a stop whose time wasn't stored (only the day)


def exit_time(reason, normal):
    """The exit's time of day from a trade's exit reason: a stop at the open is 09:15; a stop otherwise
    happened during the day (its time isn't stored); anything else exits at `normal`."""
    reason = str(reason or "")
    if reason == "stop (gap)":
        return "09:15 (stop at the open)"
    if reason.startswith("stop"):
        return STOP_INTRADAY
    return normal


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
        **compounded(r, TRADING_DAYS),
        **ruin(monthly_compounded(r)),
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


def compounded(r, per_year):
    """CAGR and the compounded worst drop: profits left in, losses taken from what's there (r: each
    period's net as a share of capital)."""
    if not len(r):
        return {"cagr_pct": None, "max_dd_compounded_pct": None}
    eq = (1 + r.clip(lower=-0.99)).cumprod()
    years = len(r) / per_year
    return {"cagr_pct": round(float(100 * (eq.iloc[-1] ** (1 / years) - 1)), 2) if years > 0 and eq.iloc[-1] > 0 else None,
            "max_dd_compounded_pct": round(float(100 * (eq / eq.cummax() - 1).min()), 2)}


RUIN_PATHS, RUIN_YEARS = 5000, 10
RUIN_SIZES = (1.0, 0.75, 0.5, 0.33, 0.25, 0.1)  # shares of capital tried for the 0%-ruin size


def ruin(monthly):
    """Risk of ruin from the backtest's own months: RUIN_PATHS ten-year futures, each built from months
    drawn at random from the backtest (compounded, the whole capital in the model, profits left in).
    Ruin = the capital falls below half of where it started at any point; also the chance of a 30% / 50%
    fall from a peak, and the worst-5% ending value. Fixed seed, so a page shows the same number each time.
    Shuffling months breaks up long crashes, so the real risk is likely a little higher. Penfold (Universal
    Principles, ch. 4): only trade a model whose risk of ruin is 0; ruin_safe_size is the largest share of
    capital (of RUIN_SIZES) at which none of the futures ends up below half."""
    mo = np.asarray(monthly, dtype=float)
    mo = mo[~np.isnan(mo)]
    if len(mo) < 24:
        return {}
    rng = np.random.default_rng(7)
    paths = mo[rng.integers(0, len(mo), size=(RUIN_PATHS, RUIN_YEARS * 12))]

    def half(size):  # chance of falling below half the start with `size` of the capital in the model
        return float(100 * (np.cumprod(1 + np.clip(size * paths, -0.99, None), axis=1).min(axis=1) <= 0.5).mean())
    eq = np.cumprod(1 + np.clip(paths, -0.99, None), axis=1)
    dd = (eq / np.maximum.accumulate(eq, axis=1) - 1).min(axis=1)
    # Penfold: trade only at a size whose risk of ruin is 0; the largest of these sizes that gets there
    safe = next((f for f in RUIN_SIZES if half(f) == 0), None)
    return {"ruin_half_pct": round(float(100 * (eq.min(axis=1) <= 0.5).mean()), 2), "ruin_safe_size": safe,
            "ruin_dd30_pct": round(float(100 * (dd <= -0.3).mean()), 1),
            "ruin_dd50_pct": round(float(100 * (dd <= -0.5).mean()), 1),
            "ruin_p5_end": round(float(np.percentile(eq[:, -1], 5)), 2), "ruin_years": RUIN_YEARS}


def monthly_compounded(r):
    """Daily net returns (DatetimeIndex) -> each month's compounded return."""
    return (1 + r).groupby(r.index.to_period("M")).prod() - 1


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
