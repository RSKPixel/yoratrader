"""Books + gold: the two trading books (RSI(2) short-term mean reversion and long trend low volatility)
with a fixed share of capital held in gold (GOLDBEES), rebalanced at each month-end.

- Books: (100 - gold)% of capital, split between RSI(2) (F&O, max 3, 5-day hold, at the close) and low
  volatility (F&O cash, max 10, 20% trailing stop), each with its own backtest's monthly net.
- Gold: gold% of capital in GOLDBEES, bought and held; each month-end it's topped up or trimmed back to
  gold% (the trade is the drift, charged at delivery costs).
- Monthly, not compounded, like the other backtests.

Gold prices (bt_gold): GOLDBEES month-end closes from the NSE bhavcopies before 2015, daily closes from
Kite after, all on Kite's (split-adjusted) scale; topped up after the close each day.
"""

import threading
import time
from datetime import date, timedelta

import numpy as np
import pandas as pd

from db import connect

GOLD = "GOLDBEES"
GOLD_SHARES = (0, 20, 30, 40)
CACHE_SECONDS = 6 * 3600
_cache, _lock = {}, threading.Lock()


def ensure_table():
    with connect() as conn, conn.cursor() as cur:
        cur.execute("CREATE TABLE IF NOT EXISTS bt_gold (day date PRIMARY KEY, close double precision NOT NULL)")
        conn.commit()


def _gold_months():
    with connect() as conn:
        g = pd.read_sql("SELECT day, close FROM bt_gold ORDER BY day", conn, parse_dates=["day"]).set_index("day")["close"]
    return g.groupby(g.index.to_period("M")).last()


def topup_gold():
    """The last 60 days of GOLDBEES from Kite into bt_gold. If Kite's scale moved (a split), the whole
    stored history is rescaled to it first."""
    import kite_auth
    kite = kite_auth.trading_client()
    ins = [i for i in kite.instruments("NSE") if i["tradingsymbol"] == GOLD]
    if not ins:
        return 0
    bars = kite.historical_data(ins[0]["instrument_token"], date.today() - timedelta(days=60), date.today(), "day")
    if not bars:
        return 0
    new = {b["date"].date(): float(b["close"]) for b in bars}
    ensure_table()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT day, close FROM bt_gold WHERE day = ANY(%s)", (list(new),))
        old = dict(cur.fetchall())
        if old:
            ratio = float(np.median([new[d] / old[d] for d in old]))
            if abs(ratio - 1) > 0.02:
                cur.execute("UPDATE bt_gold SET close = close * %s", (ratio,))
        cur.executemany("INSERT INTO bt_gold (day, close) VALUES (%s, %s) ON CONFLICT (day) DO UPDATE SET close = EXCLUDED.close",
                        list(new.items()))
        conn.commit()
    invalidate()
    return len(new)


def invalidate():
    with _lock:
        _cache.clear()


def _book_months(out):
    return pd.Series({m["month"]: m["net_pct"] / 100 for m in out.get("months", [])}, dtype=float)


def _book_trades(out):
    return pd.Series({m["month"]: m["trades"] for m in out.get("months", [])}, dtype=float)


def _inputs():
    with _lock:
        hit = _cache.get("inputs")
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    import v2connors
    import v2ltlv
    rsi = v2connors.results("fno", "rsi2", "5d", 3, "none", "close", "all")
    lv = v2ltlv.results(10, "20", 0.0002, "cash")
    g = _gold_months()
    gold = g.pct_change().dropna()
    gold.index = gold.index.strftime("%Y-%m")
    start = max(rsi["summary"]["from"][:7], lv["summary"]["from"][:7], gold.index[0])
    end = min(rsi["summary"]["to"][:7], lv["summary"]["to"][:7], gold.index[-1])
    months = [p.strftime("%Y-%m") for p in pd.period_range(start, end, freq="M")]
    df = pd.DataFrame({"rsi2": _book_months(rsi), "lv": _book_months(lv), "gold": gold}).reindex(months).fillna(0.0)
    trades = (_book_trades(rsi).reindex(months).fillna(0) + _book_trades(lv).reindex(months).fillna(0)).astype(int)
    data = (df, trades, {"rsi2": rsi["summary"], "lv": lv["summary"]})
    with _lock:
        _cache["inputs"] = (time.time(), data)
    return data


def _stats(r):
    eq = r.cumsum()
    yrs = r.groupby(r.index.str[:4]).sum()
    return {"net_pct": round(100 * float(r.sum()), 2), "net_year_pct": round(100 * float(r.mean() * 12), 2),
            "sharpe": round(float(r.mean() / r.std() * np.sqrt(12)), 2) if r.std() else None,
            "max_dd_pct": round(100 * float((eq - eq.cummax()).min()), 2),
            "green_years": int((yrs > 0).sum()), "years": int(len(yrs)),
            "worst_year": yrs.idxmin(), "worst_year_pct": round(100 * float(yrs.min()), 2)}


def results(gold_pct=30, slippage=0.0002):
    import v2ltlv
    df, trades, books = _inputs()
    w = gold_pct / 100
    cost = v2ltlv.cash_cost_per_side(slippage)
    books_r = (df["rsi2"] + df["lv"]) / 2
    mix_gross = (1 - w) * books_r + w * df["gold"]
    # rebalancing: the gold slice drifts by (gold - mix) in a month; that drift is bought or sold back
    rebal = (w * (df["gold"] - mix_gross).abs() * cost) if w else 0 * mix_gross
    first = pd.Series(0.0, index=df.index)
    if w:
        first.iloc[0] = w * cost  # the first gold purchase
    mix = mix_gross - rebal - first
    s = _stats(mix)
    s.update({"from": df.index[0], "to": df.index[-1], "gold_pct": gold_pct, "trades": int(trades.sum()),
              "gold_cost_pct": round(100 * float(rebal.sum() + first.sum()), 3),
              "parts": {"books": _stats(books_r), "gold": _stats(df["gold"]), "rsi2": _stats(df["rsi2"]), "lv": _stats(df["lv"])},
              "corr_books_gold": round(float(books_r.corr(df["gold"])), 2)})
    years = []
    for y, grp in df.groupby(df.index.str[:4]):
        years.append({"year": int(y), "trades": int(trades[grp.index].sum()), "win_rate": None,
                      "net_pct": round(100 * float(mix[grp.index].sum()), 3), "gross_pct": round(100 * float(mix_gross[grp.index].sum()), 3),
                      "books_pct": round(100 * float(books_r[grp.index].sum()), 2), "gold_pct": round(100 * float(df["gold"][grp.index].sum()), 2),
                      "rsi2_pct": round(100 * float(df["rsi2"][grp.index].sum()), 2), "lv_pct": round(100 * float(df["lv"][grp.index].sum()), 2)})
    months = [{"month": m, "trades": int(trades[m]), "win_rate": None, "net_pct": round(100 * float(mix[m]), 3)} for m in df.index]
    equity = [{"date": f"{m}-28", "gross": round(100 * float(b), 3), "net": round(100 * float(n), 3)}
              for m, b, n in zip(df.index, books_r.cumsum(), mix.cumsum())]
    return {"summary": s, "years": years, "months": months, "equity": equity}
