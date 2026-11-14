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
- "<version>-hedged": the same book plus a short in Nifty futures equal to the long book's value
  (1:1 in rupees, no beta estimate), so it earns only what the stocks make over the Nifty. One-lot
  mode: short the whole number of Nifty lots nearest the book's value, re-sized at each rebalance
  (at least one). Returns stay on the long capital; the hedge's margin is extra.

Weights drift with prices between rebalances (buy and hold); turnover at a rebalance is the trade
from the drifted weights to the new ones. Returns are on capital (weights sum to 1), not
compounded. Costs: NSE futures charges + slippage on every rupee traded (xsmr.cost_per_side),
including the monthly futures roll: at each month end everything held is sold and bought again in
next month's contract (in a rebalance month, the positions kept); the Nifty hedge rolls the same way.
Not charged: the cost of carry (futures trade above the stock by about the interest rate less
dividends, ~5-6% a year), which is fair only if the idle capital (all but the ~20% margin) earns
interest; in the hedged version the short Nifty earns carry, so the two roughly cancel. Data hygiene as in cross-sectional momentum (xsmom): 253
straight closes and no daily move over 20% in the window to be ranked; a day's move over 20% earns
nothing. Survivorship bias: today's F&O list is used for every year.
"""

import threading
import time
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
BASES = dict(VARIANTS)
for _base, _meta in list(BASES.items()):
    VARIANTS[f"{_base}-hedged"] = {"label": f"{_meta['label']} · hedged, short Nifty"}
BOOK = ("book", "book-hedged")
# "-max<N>" (computed on request, not stored): at most N stocks, each capital / N at the rebalance;
# a slot with no pick stays in cash. The N taken are the book's order: the smoothest (lowest FIP) of
# the top 10% for "book"/"monthly", the strongest momentum for "generic". The benchmark has no max.
MAX_OPEN = tuple(range(1, 11))
for _v, _meta in list(VARIANTS.items()):
    if not _v.startswith("universe"):
        for _m in MAX_OPEN:
            VARIANTS[f"{_v}-max{_m}"] = {"label": f"{_meta['label']} · max {_m}", "max_open": _m}
HEDGE_INDEX, HEDGE_LOT_KEY = "NIFTY 50", ("NSE", "NIFTY")
TAKES = {"all": None}


def variant_id(base, take="all"):
    return base


def parse_variant(variant):
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant {variant}")
    return variant, "all"


def _split(variant):
    """'book-hedged-max5' -> ('book', True, 5)."""
    v, cap = variant, None
    if "-max" in v:
        v, m = v.rsplit("-max", 1)
        cap = int(m)
    return v.removesuffix("-hedged"), v.endswith("-hedged"), cap


def _base(variant):
    return _split(variant)[0]


def _signals(c):
    """Momentum (t-252 -> t-21), FIP over the same window, and the clean daily returns."""
    r, bad, history = xsmom.gap_aware(c)
    clean = ~bad.rolling(LOOKBACK).max().fillna(1).astype(bool)
    ok = history(LOOKBACK + 1) & clean
    cf = c.ffill()
    mom = (cf.shift(SKIP) / cf.shift(LOOKBACK) - 1).where(ok)
    window = LOOKBACK - SKIP
    seen = r.notna().astype(float).shift(SKIP).rolling(window).sum()  # days with a price in the window
    up = (r > 0).astype(float).shift(SKIP).rolling(window).sum() / seen
    down = (r < 0).astype(float).shift(SKIP).rolling(window).sum() / seen
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


def _book(c, base, cap=None):
    """Weights held after each close (drifting between rebalances) and the picks per rebalance.
    cap: at most that many stocks, capital / cap each; unfilled slots are cash (which doesn't drift)."""
    mom, fip, r = _signals(c)
    rebal = _rebalance_days(c.index, base == "monthly")
    month_ends = set(pd.Series(c.index, index=c.index).groupby([c.index.year, c.index.month]).max().values[:-1])
    cols = list(c.columns)
    w = np.zeros((len(c), len(cols)))
    turn = np.zeros(len(c))
    picks, cur, cash = {}, np.zeros(len(cols)), 0.0
    rv = r.to_numpy()
    for i, day in enumerate(c.index):
        if i:  # drift with today's returns
            grown = cur * (1 + rv[i])
            total = grown.sum() + cash
            cur, cash = (grown / total, cash / total) if total > 0 else (grown, cash)
        if day in rebal:
            names = _picks(mom.loc[day], fip.loc[day], base)
            if cap and base != "universe":
                names = names[:cap]
            new = np.zeros(len(cols))
            if names:
                new[[cols.index(s) for s in names]] = 1.0 / (cap if cap and base != "universe" else len(names))
            picks[day] = names
            turn[i] = np.abs(new - cur).sum()
            if day in month_ends:  # the positions kept are rolled to next month's contract
                turn[i] += 2 * np.minimum(new, cur).sum()
            cur, cash = new, 1.0 - new.sum()
        elif day in month_ends:  # futures roll: sell this month's contract, buy next month's
            turn[i] += 2 * cur.sum()
        w[i] = cur
    return {"w": pd.DataFrame(w, index=c.index, columns=cols), "r": r, "mom": mom, "fip": fip,
            "picks": picks, "rebal": rebal, "turn": pd.Series(turn, index=c.index)}


def _nifty(index):
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT day, close FROM bt_daily WHERE symbol = %s AND close > 0 ORDER BY day", (HEDGE_INDEX,))
        rows = cursor.fetchall()
    n = pd.Series({pd.Timestamp(d): float(v) for d, v in rows}).reindex(index).ffill()
    return n, (n / n.shift(1) - 1).fillna(0.0)


def _hedge_roll(index, size):
    """The Nifty future's own monthly roll: twice the hedge's size at each month end."""
    ends = pd.Series(index, index=index).groupby([index.year, index.month]).max().values[:-1]
    roll = pd.Series(0.0, index=index)
    roll[ends] = 2 * size[ends]
    return roll


def _hedged(c, b, out_rows, lot_rows, nifty, nifty_r, hedge_lot):
    """The book's rows with a 1:1 short Nifty hedge added (see the module note)."""
    w = b["w"]
    size = w.sum(axis=1)  # long book's share of capital after each close (1, or 0 when empty)
    held_size = size.shift(1).fillna(0.0)
    roll = _hedge_roll(c.index, size)
    rows = []
    for d, g, t, lg, sh, n in out_rows:
        ts = pd.Timestamp(d)
        hedge = -float(held_size[ts]) * float(nifty_r[ts])
        rows.append((d, g + hedge, t + abs(float(size[ts]) - float(held_size[ts])) + float(roll[ts]), lg, hedge, n))
    # One lot mode: Nifty lots nearest the value of the long lots, set at each rebalance close.
    lot = xsmr.lot_series(c.columns)
    cols = [s for s in c.columns if pd.notna(lot.get(s))]
    value = (np.sign(w[cols]) * lot[cols] * c[cols]).sum(axis=1)  # long lots' value after each close
    target = pd.Series(np.nan, index=c.index)
    for day in b["rebal"]:
        if value[day] > 0 and pd.notna(nifty[day]):
            target[day] = max(1, round(value[day] / (hedge_lot * nifty[day])))
        else:
            target[day] = 0
    target = target.ffill().fillna(0.0).where(value > 0, 0.0)
    held = target.shift(1).fillna(0.0)
    lrows = []
    for d, g, t, lg, sh, notional, pos in lot_rows:
        ts = pd.Timestamp(d)
        i = c.index.get_loc(ts)
        prev = nifty.iloc[i - 1] if i else np.nan
        pnl = -held[ts] * hedge_lot * (nifty[ts] - prev) if held[ts] and pd.notna(prev) else 0.0
        traded = abs(target[ts] - held[ts]) * hedge_lot * nifty[ts] if pd.notna(nifty[ts]) else 0.0
        lrows.append((d, float(g + pnl), float(t + traded), float(lg), float(pnl),
                      float(notional + (held[ts] * hedge_lot * prev if held[ts] and pd.notna(prev) else 0.0)),
                      int(pos + int(held[ts] > 0))))
    return rows, lrows


def run(dataset):
    c = xsmom._closes(dataset)
    out, lots_out = {}, {}
    lot = xsmr.lot_series(c.columns)
    nifty, nifty_r = _nifty(c.index)
    from db import stored_lot_sizes
    hedge_lot = stored_lot_sizes()[HEDGE_LOT_KEY]
    for base in BASES:
        b = _book(c, base)
        w = b["w"]
        held = w.shift(1).fillna(0.0)  # weights carried into each day's close
        gross = (held * b["r"]).sum(axis=1)
        turnover = b["turn"]  # rebalance trades + the monthly futures roll
        stocks = (held > 0).sum(axis=1)
        first = w.index[(w.sum(axis=1) > 0.5).to_numpy()].min()
        days = c.index[c.index >= first]
        out[base] = [(d.date(), float(gross[d]), float(turnover[d]), float(gross[d]), 0.0, int(stocks[d])) for d in days]
        lots_out[base] = xsmom._lot_rows(c, b, lot, days)
        out[f"{base}-hedged"], lots_out[f"{base}-hedged"] = _hedged(c, b, out[base], lots_out[base], nifty, nifty_r, hedge_lot)
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


_cache, _lock = {}, threading.Lock()
CACHE_SECONDS = 1800


def _closes_cached(dataset):
    with _lock:
        hit = _cache.get(("closes", dataset))
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    c = xsmom._closes(dataset)
    with _lock:
        _cache[("closes", dataset)] = (time.time(), c)
    return c


def _max_frame(variant, dataset):
    """Daily frame (gross, turnover, long, short, stocks) for a "-max<N>" variant, computed now."""
    key = ("frame", dataset, variant)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1].copy()
    base, hedged, cap = _split(variant)
    c = _closes_cached(dataset)
    b = _book(c, base, cap)
    held = b["w"].shift(1).fillna(0.0)
    gross = (held * b["r"]).sum(axis=1)
    f = pd.DataFrame({"day": c.index, "gross_ret": gross.to_numpy(), "turnover": b["turn"].to_numpy(),
                      "long_ret": gross.to_numpy(), "short_ret": 0.0, "stocks": (held > 0).sum(axis=1).to_numpy()})
    if hedged:  # short Nifty equal to the invested share, re-sized as the book's value changes
        _, nifty_r = _nifty(c.index)
        size = b["w"].sum(axis=1)
        hedge = -size.shift(1).fillna(0.0) * nifty_r
        f["gross_ret"] += hedge.to_numpy()
        f["short_ret"] = hedge.to_numpy()
        f["turnover"] += (size - size.shift(1).fillna(0.0)).abs().to_numpy() + _hedge_roll(c.index, size).to_numpy()
    first = b["w"].index[(b["w"].sum(axis=1) > 0).to_numpy()].min()
    f = f[f["day"] >= first].reset_index(drop=True)
    with _lock:
        _cache[key] = (time.time(), f)
    return f.copy()


def _frame(variant, dataset, slippage):
    if _split(variant)[2]:
        return xsmr.with_costs(_max_frame(variant, dataset), slippage)
    return xsmr._load(variant, dataset, slippage, model=MODEL)


def results(variant, dataset, slippage=0.0002, lots=False):
    if _split(variant)[2]:
        return xsmr.results_from(_frame(variant, dataset, slippage), slippage)
    return xsmr.results(variant, dataset, slippage, model=MODEL, lots=lots)


def compare(dataset, slippage=0.0002, take="all", lots=False, variant=None):
    """Every version and hedge, at the max open of `variant` (the benchmark has none)."""
    cap = _split(variant)[2] if variant else None
    rows = []
    for v, meta in VARIANTS.items():
        b, hedged, m = _split(v)
        if m != (None if b == "universe" else cap):
            continue
        f = _frame(v, dataset, slippage)
        if not f.empty:
            rows.append({"variant": v, "label": meta["label"], "book": _split(v)[0] == "book" and m == cap, **xsmr._stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, lots=False):
    if _split(variant)[2]:
        return xsmr.month_days_from(_frame(variant, dataset, slippage), month)
    return xsmr.month_days(variant, dataset, month, slippage, model=MODEL, lots=lots)


def day_trades(variant, dataset, day):
    """Every stock held into one day's close: weight, momentum and FIP at the last rebalance, the day's move."""
    parse_variant(variant)
    base, _, cap = _split(variant)
    c = _closes_cached(dataset)
    c = c[(c.index >= pd.Timestamp(day) - timedelta(days=900)) & (c.index <= pd.Timestamp(day))]
    ts = pd.Timestamp(day)
    if ts not in c.index or len(c.index) < 2:
        return []
    b = _book(c, base, cap)
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
