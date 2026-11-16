"""Meta-sizing for the cross-sectional mean reversion paper book (Lopez de Prado, Advances in Financial
Machine Learning ch. 3): a logistic regression, fitted on the backtest book (intraday-0915-top5, every
stored day), gives each morning's chance that the book ends the day net positive. Days above the
training days' median get 2 lots a position, the rest 1 lot. Tested walk-forward 2018-2026 in research
(at the same average capital): the same Sharpe (6.0), worst drawdown -19% instead of -27%, 2026 -10%
instead of -20%.

Features, all known at 09:15:01: Nifty's gap at the open, its size, the previous day's Nifty return, 20-day
Nifty volatility, Monday / Friday, and the book's own mean net over the last 5 and 20 days. The book's
recent days are the backtest's up to the first paper day, then the paper book's (as per model, 5 + 5, the
same units: return on gross exposure).

Shown alongside the paper results only: nothing here changes what is recorded.
"""

import threading
import time
from datetime import timedelta

import numpy as np
import pandas as pd

import gapwatch
import kite_auth
import xsmr
from db import connect

VARIANT = "intraday-0915-top5"
FEATURES = ["gap", "absgap", "prev_ret", "vol20", "mon", "fri", "book5", "book20"]
BIG, SMALL = 2, 1  # lots a position on a predicted-good / other day
NIFTY_TOKEN = 256265  # NSE:NIFTY 50 (Kite instrument token)
_lock = threading.Lock()
_model = {"day": None, "fit": None}
_nifty_cache = {"at": 0, "value": None}
NIFTY_TTL = 60  # the paper page polls every 20 s; Nifty's daily bars needn't be fetched each time


def _nifty(kite=None):
    """Nifty daily (open, close): stored candles, topped up from Kite for the latest days."""
    with connect() as conn:
        d = pd.read_sql("SELECT day, open, close FROM bt_daily WHERE symbol = 'NIFTY 50' ORDER BY day", conn, parse_dates=["day"]).set_index("day")
        o15 = pd.read_sql("SELECT (datetime AT TIME ZONE 'Asia/Kolkata')::date AS day, open FROM bt_15m WHERE symbol = 'NIFTY 50' "
                          "AND to_char(datetime AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') = '09:15'", conn, parse_dates=["day"]).set_index("day")["open"]
    d["open915"] = o15.reindex(d.index)
    if kite is not None:
        try:
            token = NIFTY_TOKEN
            now = gapwatch._now().replace(tzinfo=None)
            bars = kite.historical_data(token, from_date=now - timedelta(days=60), to_date=now, interval="day")
            k = pd.DataFrame([{"day": pd.Timestamp(b["date"].date()), "open": b["open"], "close": b["close"]} for b in bars]).set_index("day")
            k["open915"] = k["open"]
            d = pd.concat([d[~d.index.isin(k.index)], k]).sort_index()
        except Exception as error:
            print("Meta-sizing: Nifty from Kite failed:", error)
    return d


def _features(book, nifty):
    """One row a day of `book` (a Series of daily net returns, indexed by day)."""
    nc = nifty["close"]
    idx = book.index
    f = pd.DataFrame(index=idx)
    prev_close = nc.shift(1).reindex(idx)
    f["gap"] = nifty["open915"].reindex(idx) / prev_close - 1
    f["absgap"] = f["gap"].abs()
    f["prev_ret"] = nc.pct_change().shift(1).reindex(idx)
    f["vol20"] = nc.pct_change().rolling(20).std().shift(1).reindex(idx)
    f["mon"] = (idx.dayofweek == 0).astype(float)
    f["fri"] = (idx.dayofweek == 4).astype(float)
    f["book5"] = book.rolling(5).mean().shift(1)
    f["book20"] = book.rolling(20).mean().shift(1)
    return f.replace([np.inf, -np.inf], np.nan)


def _fit(X, y, l2=1.0, iters=3000, lr=0.1):
    mu, sd = X.mean(), X.std().replace(0, 1)
    Z = np.c_[np.ones(len(X)), ((X - mu) / sd).to_numpy()]
    w = np.zeros(Z.shape[1])
    yy = y.to_numpy()
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        w -= lr * (Z.T @ (p - yy) / len(Z) + l2 * np.r_[0, w[1:]] / len(Z))
    predict = lambda Xt: 1 / (1 + np.exp(-np.c_[np.ones(len(Xt)), ((Xt[X.columns] - mu) / sd).to_numpy()] @ w))
    return predict, float(np.median(predict(X))), {k: float(v) for k, v in zip(["const"] + list(X.columns), np.round(w, 3))}


def _backtest_book():
    with connect() as conn:
        b = pd.read_sql("SELECT day, gross_ret, turnover FROM bt_portfolio WHERE model = 'xsmr' AND dataset = 'fno' AND variant = %s ORDER BY day",
                        conn, params=[VARIANT], parse_dates=["day"]).set_index("day")
    return b["gross_ret"] - b["turnover"] * xsmr.cost_per_side(0.0002)


def _model_for(today, nifty):
    with _lock:
        if _model["day"] == today and _model["fit"]:
            return _model["fit"]
        book = _backtest_book()
        f = _features(book, nifty)
        ok = f.notna().all(axis=1)
        fit = _fit(f[ok], (book[ok] > 0).astype(float))
        _model.update(day=today, fit=(fit, book))
        return _model["fit"]


def _nifty_cached(kite):
    if _nifty_cache["value"] is None or time.time() - _nifty_cache["at"] > NIFTY_TTL:
        _nifty_cache.update(value=_nifty(kite), at=time.time())
    return _nifty_cache["value"]


def sizes(paper_days):
    """paper_days: [{"day", "net_pct" (as per model, % on gross), "status"}], newest first. Returns
    ({day: {"p", "size"}}, info) for every paper day, today's included once it is recorded."""
    today = gapwatch._now().date()
    kite = kite_auth.trading_client() if kite_auth.status().get("connected") else None
    nifty = _nifty_cached(kite)
    (predict, threshold, weights), backtest = _model_for(today, nifty)
    paper = pd.Series({pd.Timestamp(d["day"]): d["net_pct"] / 100 for d in paper_days}).sort_index()
    if paper.empty:
        return {}, {"threshold": round(threshold, 3), "weights": weights}
    book = pd.concat([backtest[backtest.index < paper.index.min()], paper])
    f = _features(book, nifty).loc[paper.index]
    out = {}
    for d, row in f.iterrows():
        if row.isna().any():
            continue
        p = float(predict(row.to_frame().T)[0])
        out[d.date().isoformat()] = {"p": round(p, 3), "size": BIG if p > threshold else SMALL}
    return out, {"threshold": round(threshold, 3), "weights": weights, "trained_to": backtest.index.max().date().isoformat()}
