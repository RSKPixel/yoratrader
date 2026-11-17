"""Books + gold: the two trading books (RSI(2) short-term mean reversion and long trend low volatility)
with a fixed share of capital held in gold (GOLDBEES), rebalanced at each month-end.

- Books: (100 - gold)% of capital, split between RSI(2) (F&O stocks, max 3, 5-day hold, at the close) and low
  volatility (F&O stocks, max 10, 20% trailing stop) half each (fixed); traded in cash
  (delivery charges, no rolls) or futures (futures charges and the monthly rolls)., each with its own backtest's monthly net.
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
GOLD_SHARES = (0, 30)  # none or 30%: nothing in between to tune
RSI_SHARES = (50,)  # the books are always half each: no other split, so it can't be fitted to the past
INSTRUMENTS = ("cash",)  # delivery only
DATASETS = ("fno", "fnopit", "cash500")  # fnopit / cash500: survivorship-free (pit.py, cash500.py)
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


def _monthly(daily, key):
    m = daily.groupby(daily.index.strftime("%Y-%m"))[["book_ret", "book_cost"]].sum()
    return m.rename(columns={"book_ret": f"{key}_gross", "book_cost": f"{key}_cost"})


def _inputs(instrument, dataset="fno"):
    with _lock:
        hit = _cache.get((instrument, dataset))
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    import v2connors
    import v2ltlv
    t_r, _, daily_r = v2connors._sized(dataset, "rsi2", "5d", 3, "none", "close", "all", 0.0002, "long", instrument)
    t_l, _, daily_l, _, _ = v2ltlv._book(10, "20", 0.0002, instrument, dataset)
    daily_r = daily_r[daily_r.index >= t_r["entry_day"].min()]
    g = _gold_months()
    gold = g.pct_change().dropna()
    gold.index = gold.index.strftime("%Y-%m")
    mr, ml = _monthly(daily_r, "rsi2"), _monthly(daily_l, "lv")
    start, end = max(mr.index[0], ml.index[0], gold.index[0]), min(mr.index[-1], ml.index[-1], gold.index[-1])
    months = [p.strftime("%Y-%m") for p in pd.period_range(start, end, freq="M")]
    df = pd.concat([mr, ml, gold.rename("gold")], axis=1).reindex(months).fillna(0.0)
    keep = lambda t: t[(t["day"].dt.strftime("%Y-%m") >= start) & (t["day"].dt.strftime("%Y-%m") <= end)]
    data = (df, keep(t_r), keep(t_l))
    with _lock:
        _cache[(instrument, dataset)] = (time.time(), data)
    return data


def _weights(gold_pct, rsi_pct):
    w = gold_pct / 100
    return w, (1 - w) * rsi_pct / 100, (1 - w) * (100 - rsi_pct) / 100


def _gold_cost(df, w, a, b, cost):
    """Buying the gold slice, then each month-end the drift between gold and the rest traded back."""
    if not w:
        return pd.Series(0.0, index=df.index)
    rest = (a * (df["rsi2_gross"] - df["rsi2_cost"]) + b * (df["lv_gross"] - df["lv_cost"])) / max(a + b, 1e-9)
    c = w * (1 - w) * (df["gold"] - rest).abs() * cost
    c.iloc[0] += w * cost
    return c


def _stats(r):
    eq = r.cumsum()
    yrs = r.groupby(r.index.str[:4]).sum()
    return {"net_pct": round(100 * float(r.sum()), 2), "net_year_pct": round(100 * float(r.mean() * 12), 2),
            "sharpe": round(float(r.mean() / r.std() * np.sqrt(12)), 2) if r.std() else None,
            "max_dd_pct": round(100 * float((eq - eq.cummax()).min()), 2),
            "green_years": int((yrs > 0).sum()), "years": int(len(yrs)),
            "worst_year": yrs.idxmin(), "worst_year_pct": round(100 * float(yrs.min()), 2)}


def _scaled(t, k):
    t = t.copy()
    for col in ("book_ret", "book_cost", "book_net"):
        t[col] = t[col] * k
    return t


def results(gold_pct=30, rsi_pct=50, instrument="cash", slippage=0.0002, dataset="fno"):
    import v2ltlv
    import xsmr
    df, t_r, t_l = _inputs(instrument, dataset)
    w, a, b = _weights(gold_pct, rsi_pct)
    cps = v2ltlv.cash_cost_per_side(slippage) if instrument == "cash" else xsmr.cost_per_side(slippage)
    gold_cost = _gold_cost(df, w, a, b, v2ltlv.cash_cost_per_side(slippage))
    gross = a * df["rsi2_gross"] + b * df["lv_gross"] + w * df["gold"]
    cost = a * df["rsi2_cost"] + b * df["lv_cost"] + gold_cost
    net = gross - cost
    t = pd.concat([x for x, k in ((_scaled(t_r, a), a), (_scaled(t_l, b), b)) if k > 0], ignore_index=True)
    rsi_net, lv_net = df["rsi2_gross"] - df["rsi2_cost"], df["lv_gross"] - df["lv_cost"]
    books = (a * rsi_net + b * lv_net) / max(a + b, 1e-9)
    eq = net.cumsum()
    wins, losses = t.loc[t["book_net"] > 0, "book_net"].sum(), -t.loc[t["book_net"] < 0, "book_net"].sum()
    yearly = net.groupby(net.index.str[:4]).sum()
    s = {"trades": int(len(t)), "days_traded": int(t["day"].nunique()), "from": df.index[0], "to": df.index[-1],
         "win_rate": round(float(100 * (t["net"] > 0).mean()), 1), "win_rate_gross": round(float(100 * (t["ret"] > 0).mean()), 1),
         "gross_pct": round(float(100 * gross.sum()), 3), "cost_pct": round(float(100 * cost.sum()), 3), "net_pct": round(float(100 * net.sum()), 3),
         "avg_cost_pct": round(float(100 * t["book_cost"].mean()), 4), "avg_net_pct": round(float(100 * t["book_net"].mean()), 4),
         "avg_trade_net_pct": round(float(100 * t["net"].mean()), 3),
         "profit_factor": round(float(wins / losses), 2) if losses > 0 else None,
         "max_dd_pct": round(float(100 * (eq - eq.cummax()).min()), 3), "net_year_pct": round(float(100 * net.mean() * 12), 2),
         "sharpe": round(float(net.mean() / net.std() * np.sqrt(12)), 2) if net.std() else None,
         "green_years": int((yearly > 0).sum()), "years": int(len(yearly)),
         "cost_per_side_bps": round(10000 * cps, 2), "gold_cost_pct": round(float(100 * gold_cost.sum()), 3),
         "gold_pct": gold_pct, "rsi_pct": rsi_pct, "instrument": instrument,
         "split": {"rsi2": round(100 * a, 1), "lv": round(100 * b, 1), "gold": round(100 * w, 1)},
         "corr_books_gold": round(float(books.corr(df["gold"])), 2),
         "parts": {"mix": _stats(net), "books": _stats(books), "gold": _stats(df["gold"]), "rsi2": _stats(rsi_net), "lv": _stats(lv_net)}}
    key_t = t["day"].dt.strftime("%Y-%m")

    def period(keys, kind):
        out = []
        for k, idx in pd.Series(df.index, index=df.index).groupby(keys).groups.items():
            sel = t[key_t.str[:4] == k] if kind == "year" else t[key_t == k]
            row = {kind: int(k) if kind == "year" else k, "trades": int(len(sel)),
                   "win_rate": round(float(100 * (sel["net"] > 0).mean()), 1) if len(sel) else None,
                   "net_pct": round(100 * float(net[idx].sum()), 3)}
            if kind == "year":
                row.update(gross_pct=round(100 * float(gross[idx].sum()), 3), books_pct=round(100 * float(books[idx].sum()), 2),
                           rsi2_pct=round(100 * float(rsi_net[idx].sum()), 2), lv_pct=round(100 * float(lv_net[idx].sum()), 2),
                           gold_pct=round(100 * float(df["gold"][idx].sum()), 2))
            out.append(row)
        return out

    equity = [{"date": f"{m}-28", "gross": round(100 * float(x), 3), "net": round(100 * float(n), 3)}
              for m, x, n in zip(df.index, books.cumsum(), eq)]
    return {"summary": s, "years": period(df.index.str[:4], "year"), "months": period(df.index, "month"), "equity": equity}


def month_trades(month, gold_pct=30, rsi_pct=50, instrument="cash", slippage=0.0002, dataset="fno"):
    """The month's trades of both books, each sized to its share of capital, then the gold slice's month."""
    import v2connors
    import v2ltlv
    df, _, _ = _inputs(instrument, dataset)
    w, a, b = _weights(gold_pct, rsi_pct)

    def scale(rows, k, book):
        out = []
        for r in rows:
            r = dict(r, book=book, days=r.get("days", r.get("days_held")))
            for col in ("weight_pct", "book_net_pct", "book_cost_pct"):
                r[col] = round(r[col] * k, 4)
            out.append(r)
        return out

    rows = []
    if a:
        rows += scale(v2connors.month_trades(month, dataset, "rsi2", "5d", 3, "none", "close", "all", slippage, "long", instrument), a, "RSI(2)")
    if b:
        rows += scale(v2ltlv.month_trades(month, 10, "20", slippage, instrument, dataset), b, "Low volatility")
    if w and month in df.index:
        g = float(df.at[month, "gold"])
        c = float(_gold_cost(df, w, a, b, v2ltlv.cash_cost_per_side(slippage))[month])
        rows.append({"book": "Gold", "symbol": GOLD, "entry_at": f"{month} start", "exit_at": f"{month} end", "reason": "held",
                     "days": None, "entry": None, "exit": None, "ret_pct": round(100 * g, 3), "net_pct": round(100 * (g - c / w), 3),
                     "weight_pct": round(100 * w, 2), "book_cost_pct": round(100 * c, 4), "book_net_pct": round(100 * (w * g - c), 4)})
    return rows
