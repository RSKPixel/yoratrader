"""Cross-sectional momentum (Chan, Algorithmic Trading ch. 6) on the F&O stocks (or the Nifty 50).

The book's stock version, with its parameters:

- Every day, rank the stocks by their return over the last 252 trading days (12 months).
- Buy the top 10% and short the bottom 10% (the book: top and bottom 50 of the S&P 500), equal
  rupees each; long and short are each half of the day's portfolio.
- Hold each day's portfolio for 25 trading days. Portfolios overlap: the book on any day is the
  average of the last 25 daily portfolios (1/25 of capital each), so about 1/25 of it turns over
  daily instead of all of it once a month.
- Fill: the book trades at the close the ranking is computed from ("book"); "next" keeps the
  same ranking and trades one close later (a fill check).

Take: "all" is the book (10% per side: ~22 stocks a side on today's 218 F&O stocks). "top5":
only the 5 strongest and 5 weakest, the same 25-day overlap.

Data hygiene, not tuning: a stock is ranked only with 253 straight closes and no daily move over
20% in the window (a split or bonus in unadjusted prices, or a bad print); a day's move over 20%
earns nothing. Sparse special sessions (Muhurat, Saturday budget days, where only a few symbols
have a close) are dropped. Days with fewer than 20 rankable stocks hold nothing.

Returns are on gross exposure (long + short = 1), not compounded. Costs: NSE futures charges and
slippage on every rupee traded (xsmr.cost_per_side); the monthly futures roll is not charged.
Survivorship bias: today's F&O list is used for every year.
"""

from datetime import timedelta

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

import xsmr
from db import connect

MODEL = "xsmom"
DATASETS = ("fno", "stocks")
LOOKBACK, HOLD, FRACTION = 252, 25, 0.10
MIN_STOCKS = xsmr.MIN_STOCKS
MAX_MOVE = xsmr.MAX_MOVE
VARIANTS = {
    "book": {"label": "12-month rank, hold 25 days · trade at signal close (book)", "lag": 0},
    "next": {"label": "12-month rank, hold 25 days · trade next close", "lag": 1},
}
BOOK = ("book",)
TAKES = {"all": None, "top5": 5}


def variant_id(base, take="all"):
    return base if take == "all" else f"{base}-{take}"


def parse_variant(variant):
    for take in TAKES:
        if take != "all" and variant.endswith(f"-{take}"):
            base = variant[: -len(take) - 1]
            break
    else:
        base, take = variant, "all"
    if base not in VARIANTS:
        raise ValueError(f"unknown variant {variant}")
    return base, take


def _closes(dataset):
    with connect() as conn:
        f = pd.read_sql("SELECT symbol, day, close FROM bt_daily WHERE close > 0 AND symbol IN "
                        "(SELECT symbol FROM bt_symbols WHERE dataset = %s)", conn, params=[dataset])
    f["day"] = pd.to_datetime(f["day"])
    c = f.pivot(index="day", columns="symbol", values="close").sort_index()
    count = c.notna().sum(axis=1)
    return c[count >= 0.8 * count.rolling(21, center=True, min_periods=1).median()]


def _book(c, variant):
    """Daily momentum, the target weights held after each close, and the daily returns."""
    base, take = parse_variant(variant)
    r = c / c.shift(1) - 1
    bad = r.abs() > MAX_MOVE
    full = c.notna().rolling(LOOKBACK + 1).sum().eq(LOOKBACK + 1)
    clean = ~bad.rolling(LOOKBACK).max().fillna(1).astype(bool)
    mom = (c / c.shift(LOOKBACK) - 1).where(full & clean)
    n = mom.notna().sum(axis=1)
    rank = mom.rank(axis=1)
    per_side = (n * FRACTION).round().clip(lower=1)
    if TAKES[take]:
        per_side = per_side.clip(upper=TAKES[take])
    sig = pd.DataFrame(0.0, index=c.index, columns=c.columns)
    sig[rank.le(per_side, axis=0)] = -0.5
    sig[rank.gt(n - per_side, axis=0)] = 0.5
    sig = sig.div(per_side, axis=0).where(n >= MIN_STOCKS, 0.0).fillna(0.0)
    w = sig.shift(VARIANTS[base]["lag"]).fillna(0.0).rolling(HOLD, min_periods=1).mean()
    return {"mom": mom, "w": w, "r": r.where(~bad, 0.0).fillna(0.0)}


def _lot_rows(c, b, lot, days):
    """One lot of every stock the book holds (side = sign of its weight), today's lot sizes, in rupees.
    The 25 overlapping slices collapse to one lot per stock: a stock held by any slice is one lot."""
    cols = [s for s in c.columns if pd.notna(lot.get(s))]
    lot = lot[cols]
    target = np.sign(b["w"][cols]) * lot          # lots after each close
    held = target.shift(1).fillna(0.0)           # lots carried into each day
    prev_close = c[cols].shift(1)
    move = (held * prev_close * b["r"][cols]).fillna(0.0)  # a >20% day earns nothing, as in the % series
    traded = ((target - held).abs() * c[cols]).fillna(0.0)
    notional = (held.abs() * prev_close).fillna(0.0)
    return [(d.date(), float(move.loc[d].sum()), float(traded.loc[d].sum()), float(move.loc[d][held.loc[d] > 0].sum()),
             float(move.loc[d][held.loc[d] < 0].sum()), float(notional.loc[d].sum()), int((held.loc[d] != 0).sum()))
            for d in days]


def run(dataset):
    c = _closes(dataset)
    out, lots_out = {}, {}
    lot = xsmr.lot_series(c.columns)
    for base in VARIANTS:
        for take in TAKES:
            variant = variant_id(base, take)
            b = _book(c, variant)
            held = b["w"].shift(1).fillna(0.0)  # weights carried into each day's close
            gross = (held * b["r"]).sum(axis=1)
            longs = (held.clip(lower=0) * b["r"]).sum(axis=1)
            shorts = (held.clip(upper=0) * b["r"]).sum(axis=1)
            turnover = (b["w"] - held).abs().sum(axis=1)
            stocks = (held != 0).sum(axis=1)  # positions carried into the day
            live = (held.abs().sum(axis=1) > 0.5) | (b["w"].abs().sum(axis=1) > 0.5)
            first = live.idxmax()  # from the first fully built book; later empty days stay in (as flat days)
            rows = [(d.date(), float(gross[d]), float(turnover[d]), float(longs[d]), float(shorts[d]), int(stocks[d]))
                    for d in c.index[c.index >= first]]
            out[variant] = rows
            lots_out[variant] = _lot_rows(c, b, lot, c.index[c.index >= first])
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
        variant = variant_id(base, take)
        f = xsmr._load(variant, dataset, slippage, model=MODEL, lots=lots)
        if not f.empty:
            rows.append({"variant": variant, "label": meta["label"], "book": base in BOOK, **xsmr._stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, lots=False):
    return xsmr.month_days(variant, dataset, month, slippage, model=MODEL, lots=lots)


def day_trades(variant, dataset, day):
    """Every stock held into one day's close: weight, 12-month return when it was ranked, the day's move."""
    c = _closes(dataset)
    c = c[(c.index >= pd.Timestamp(day) - timedelta(days=600)) & (c.index <= pd.Timestamp(day))]
    b = _book(c, variant)
    ts = pd.Timestamp(day)
    if ts not in c.index or len(c.index) < 2:
        return []
    prev = c.index[c.index.get_loc(ts) - 1]
    held = b["w"].loc[prev]
    rows, lot = [], xsmr.lot_series(c.columns)
    for symbol, w in held.items():
        if w == 0:
            continue
        move = float(b["r"].at[ts, symbol])
        m = b["mom"].at[prev, symbol]
        rows.append({"symbol": symbol, "side": "long" if w > 0 else "short", "weight_pct": round(100 * abs(w), 3),
                     "signal_pct": round(100 * float(m), 1) if pd.notna(m) else None,
                     "entry": round(float(c.at[prev, symbol]), 2) if pd.notna(c.at[prev, symbol]) else None,
                     "exit": round(float(c.at[ts, symbol]), 2) if pd.notna(c.at[ts, symbol]) else None,
                     "move_pct": round(100 * move, 2), "contribution_bps": round(10000 * w * move, 2),
                     "lot_size": int(lot[symbol]) if pd.notna(lot.get(symbol)) else None,
                     "pnl_rs": round((1 if w > 0 else -1) * lot[symbol] * move * float(c.at[prev, symbol]))
                     if pd.notna(lot.get(symbol)) and pd.notna(c.at[prev, symbol]) else None})
    return sorted(rows, key=lambda x: -x["contribution_bps"])
