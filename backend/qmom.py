"""Quantitative Momentum (Wesley Gray & Jack Vogel, Quantitative Momentum, Wiley 2016) on the F&O
stocks (or the Nifty 50). Long only, as in the book.

The book's process, with its parameters:

1. Universe: the book takes US stocks above the 40th size percentile; here the F&O list (already
   the large, liquid stocks).
2. Momentum: the return from 12 months ago to 1 month ago (t-252 to t-21 trading days), skipping
   the last month (short-term reversal). Keep the top 10%.
3. Quality of momentum, "frog in the pan" (FIP): over the same window,
   FIP = sign(momentum) x (% of days down - % of days up). Lower is a smoother climb. Keep the
   smoother half of the top 10% (the book: 50 of ~100).
4. Seasonality: rebalance quarterly at the last close of February, May, August and November
   (ahead of quarter-end window dressing), equal weight, and hold until the next rebalance.

Versions:
- "book": the four steps.
- "generic": steps 1, 2 and 4 without the FIP filter (the whole top 10%): what FIP adds.
- "monthly": the book's selection, rebalanced at every month end: what the quarterly timing does.
- "universe": every rankable stock, equal weight, same quarterly rebalance: the benchmark the book
  measures against (the market the stocks come from).

Weights drift with prices between rebalances (buy and hold); turnover at a rebalance is the trade
from the drifted weights to the new ones. Returns are on capital (weights sum to 1), not
compounded. Costs: NSE futures charges + slippage on every rupee traded (xsmr.cost_per_side); the
monthly futures roll is not charged. Data hygiene as in cross-sectional momentum (xsmom): 253
straight closes and no daily move over 20% in the window to be ranked; a day's move over 20% earns
nothing. Survivorship bias: today's F&O list is used for every year.
"""

from datetime import timedelta

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

import xsmom
import xsmr
from db import connect

MODEL = "qmom"
DATASETS = ("fno", "stocks")
LOOKBACK, SKIP, TOP, KEEP = 252, 21, 0.10, 0.5
QUARTER_MONTHS = (2, 5, 8, 11)
MIN_STOCKS = xsmr.MIN_STOCKS
MAX_MOVE = xsmr.MAX_MOVE
VARIANTS = {
    "book": {"label": "Momentum + FIP · quarterly, Feb/May/Aug/Nov (book)"},
    "generic": {"label": "Momentum only (top 10%) · quarterly"},
    "monthly": {"label": "Momentum + FIP · monthly"},
    "universe": {"label": "All stocks, equal weight · quarterly (benchmark)"},
}
BOOK = ("book",)
TAKES = {"all": None}


def variant_id(base, take="all"):
    return base


def parse_variant(variant):
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant {variant}")
    return variant, "all"


def _signals(c):
    """Momentum (t-252 -> t-21), FIP over the same window, and the clean daily returns."""
    r = c / c.shift(1) - 1
    bad = r.abs() > MAX_MOVE
    full = c.notna().rolling(LOOKBACK + 1).sum().eq(LOOKBACK + 1)
    clean = ~bad.rolling(LOOKBACK).max().fillna(1).astype(bool)
    ok = full & clean
    mom = (c.shift(SKIP) / c.shift(LOOKBACK) - 1).where(ok)
    window = LOOKBACK - SKIP
    up = (r > 0).astype(float).shift(SKIP).rolling(window).sum() / window
    down = (r < 0).astype(float).shift(SKIP).rolling(window).sum() / window
    fip = (np.sign(mom) * (down - up)).where(ok)
    return mom, fip, r.where(~bad, 0.0).fillna(0.0)


def _rebalance_days(index, monthly):
    days = pd.Series(index, index=index)
    last = days.groupby([index.year, index.month]).max()
    last = last[last.index.get_level_values(1).isin(range(1, 13) if monthly else QUARTER_MONTHS)]
    return set(last.values[:-1]) | ({last.values[-1]} if last.values[-1] < index[-1] else set())


def _picks(mom_row, fip_row, base):
    """The stocks held after one rebalance close."""
    m = mom_row.dropna()
    if len(m) < MIN_STOCKS:
        return []
    if base == "universe":
        return list(m.index)
    top = m.nlargest(max(1, int(round(len(m) * TOP))))
    if base == "generic":
        return list(top.index)
    keep = max(1, int(round(len(top) * KEEP)))
    return list(fip_row[top.index].sort_values(kind="stable").index[:keep])


def _book(c, base):
    """Weights held after each close (drifting between rebalances) and the picks per rebalance."""
    mom, fip, r = _signals(c)
    rebal = _rebalance_days(c.index, base == "monthly")
    cols = list(c.columns)
    w = np.zeros((len(c), len(cols)))
    target = np.zeros((len(c), len(cols)))  # weights right after the rebalance trade (0 when none)
    picks, cur = {}, np.zeros(len(cols))
    rv = r.to_numpy()
    for i, day in enumerate(c.index):
        if i:  # drift with today's returns
            grown = cur * (1 + rv[i])
            total = grown.sum()
            cur = grown / total if total > 0 else grown
        if day in rebal:
            names = _picks(mom.loc[day], fip.loc[day], base)
            new = np.zeros(len(cols))
            if names:
                new[[cols.index(s) for s in names]] = 1.0 / len(names)
            picks[day] = names
            target[i] = new
            cur = new
        w[i] = cur
    return {"w": pd.DataFrame(w, index=c.index, columns=cols), "r": r, "mom": mom, "fip": fip,
            "picks": picks, "rebal": rebal}


def run(dataset):
    c = xsmom._closes(dataset)
    out, lots_out = {}, {}
    lot = xsmr.lot_series(c.columns)
    for base in VARIANTS:
        b = _book(c, base)
        w = b["w"]
        held = w.shift(1).fillna(0.0)  # weights carried into each day's close
        drifted = held * (1 + b["r"])
        drifted = drifted.div(drifted.sum(axis=1).where(lambda s: s > 0, 1.0), axis=0)
        gross = (held * b["r"]).sum(axis=1)
        turnover = (w - drifted).abs().sum(axis=1)
        stocks = (held > 0).sum(axis=1)
        first = w.index[(w.sum(axis=1) > 0.5).to_numpy()].min()
        days = c.index[c.index >= first]
        out[base] = [(d.date(), float(gross[d]), float(turnover[d]), float(gross[d]), 0.0, int(stocks[d])) for d in days]
        lots_out[base] = xsmom._lot_rows(c, b, lot, days)
    return out, lots_out


def run_all(datasets=DATASETS):
    with connect() as conn, conn.cursor() as cursor:
        xsmr._ensure_table(cursor)
        conn.commit()
    counts = {}
    for dataset in datasets:
        result, lots = run(dataset)
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("DELETE FROM bt_portfolio WHERE model = %s AND dataset = %s", (MODEL, dataset))
            for variant, rows in result.items():
                execute_values(cursor, "INSERT INTO bt_portfolio (model, variant, dataset, day, gross_ret, turnover, "
                                       "long_ret, short_ret, stocks) VALUES %s",
                               [(MODEL, variant, dataset, *r) for r in rows], page_size=5000)
                counts[(dataset, variant)] = len(rows)
            xsmr.store_lots(cursor, MODEL, dataset, lots)
            conn.commit()
    return counts


def results(variant, dataset, slippage=0.0002, lots=False):
    return xsmr.results(variant, dataset, slippage, model=MODEL, lots=lots)


def compare(dataset, slippage=0.0002, take="all", lots=False):
    rows = []
    for base, meta in VARIANTS.items():
        f = xsmr._load(base, dataset, slippage, model=MODEL, lots=lots)
        if not f.empty:
            rows.append({"variant": base, "label": meta["label"], "book": base in BOOK, **xsmr._stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, lots=False):
    return xsmr.month_days(variant, dataset, month, slippage, model=MODEL, lots=lots)


def day_trades(variant, dataset, day):
    """Every stock held into one day's close: weight, momentum and FIP at the last rebalance, the day's move."""
    base, _ = parse_variant(variant)
    c = xsmom._closes(dataset)
    c = c[(c.index >= pd.Timestamp(day) - timedelta(days=900)) & (c.index <= pd.Timestamp(day))]
    ts = pd.Timestamp(day)
    if ts not in c.index or len(c.index) < 2:
        return []
    b = _book(c, base)
    prev = c.index[c.index.get_loc(ts) - 1]
    held = b["w"].loc[prev]
    past = [d for d in b["picks"] if d <= prev]
    ranked = max(past) if past else prev
    rows, lot = [], xsmr.lot_series(c.columns)
    for symbol, w in held.items():
        if w <= 0:
            continue
        move = float(b["r"].at[ts, symbol])
        m, f = b["mom"].at[ranked, symbol], b["fip"].at[ranked, symbol]
        size = lot.get(symbol)
        rows.append({"symbol": symbol, "side": "long", "weight_pct": round(100 * w, 3),
                     "signal_pct": round(100 * float(m), 1) if pd.notna(m) else None,
                     "fip": round(float(f), 3) if pd.notna(f) else None, "ranked": ranked.date().isoformat(),
                     "entry": round(float(c.at[prev, symbol]), 2), "exit": round(float(c.at[ts, symbol]), 2),
                     "move_pct": round(100 * move, 2), "contribution_bps": round(10000 * w * move, 2),
                     "lot_size": int(size) if pd.notna(size) else None,
                     "pnl_rs": round(size * move * float(c.at[prev, symbol])) if pd.notna(size) else None})
    return sorted(rows, key=lambda x: -x["contribution_bps"])
