"""Short-term mean reversion (Larry Connors & Conor Sen, How Markets Really Work, 2nd ed. 2012) on
the F&O stocks (or the Nifty 50). Long only: the book's short-side mirror (overbought below the
200-day average) lost in every test here.

The book's setups, in a stock above its 200-day average:
- "rsi2": the 2-day RSI (Wilder) below 10 (book).
- "low10": a close at a new 10-day low.
- "down3": three down closes in a row.

Live timing: everything happens at 15:15, because the official close (a 30-minute average) can't
be traded and the next open gives up the overnight move, where much of the edge sits. The signal
uses official closes up to yesterday plus today's 15:15 price (the close of the 15:00 candle) as
today's close; the entry is that 15:15 price; the exit is the 15:15 price `hold` trading days
later (5 = the book's week; 2 = a check).

Book: each day's picks get 1/hold of capital, split equally, so the book is the last `hold` days'
picks together (overlapping tranches, as in xsmom); a day with no picks leaves its slice in cash.
Take: "all" buys every signal; "top5"/"top3" only the 5 / 3 lowest 2-day RSIs of the day (for
every setup, so the take means the same thing across setups). A stock picked again while held adds
a slice. One-lot mode: one lot per stock held, however many slices.

Costs: NSE futures charges + slippage on every rupee traded (xsmr.cost_per_side); the futures roll
is not charged. Data hygiene: 200 straight closes and no move over 20% in the window to qualify;
a day's move over 20% earns nothing. Survivorship bias: today's F&O list is used for every year,
which flatters every long position. The "every" setup is the control: with take "all" it buys
every stock above its 200-day average (the baseline); with "top5"/"top3" it buys the day's 5 / 3
lowest 2-day RSIs without the below-10 threshold, which shows what the threshold adds.
"""

from datetime import timedelta

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

import xsmom
import xsmr
from db import connect

MODEL = "connors"
DATASETS = ("fno", "stocks")
SMA_DAYS, RSI_MAX, LOW_DAYS, DOWN_DAYS = 200, 10.0, 10, 3
MIN_STOCKS = xsmr.MIN_STOCKS
MAX_MOVE = xsmr.MAX_MOVE
SETUPS = {"rsi2": "2-day RSI below 10 (book)", "low10": "New 10-day low", "down3": "3 down days",
          "every": "Any stock above the 200-day average (no RSI threshold)"}
HOLDS = {5: "hold 5 days (book)", 2: "hold 2 days"}
VARIANTS = {f"{s}-{h}d": {"label": f"{SETUPS[s]} · {HOLDS[h]}", "setup": s, "hold": h} for s in SETUPS for h in HOLDS}
BOOK = ("rsi2-5d",)
TAKES = {"all": None, "top5": 5, "top3": 3}


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


def _data(dataset, start=None, end=None):
    """15:15 prices, and the setups computed live at 15:15 (closes to yesterday + today's 15:15)."""
    p = xsmr._prices(dataset, start, end)
    px = p["px1515"]
    c = xsmom._closes(dataset)
    if start is not None:
        c = c[c.index >= pd.Timestamp(start) - timedelta(days=500)]
    if end is not None:
        c = c[c.index <= pd.Timestamp(end)]
    r = c / c.shift(1) - 1
    bad = r.abs() > MAX_MOVE
    ok = c.rolling(SMA_DAYS).count().eq(SMA_DAYS) & ~bad.rolling(SMA_DAYS).max().fillna(1).astype(bool)
    d = c.diff()
    au = d.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
    ad = (-d).clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
    idx = px.index.intersection(c.index)
    cols = px.columns.intersection(c.columns)
    y = lambda x: x.shift(1).reindex(index=idx, columns=cols)  # known by yesterday's close
    px = px.loc[idx, cols]
    prev = y(c)
    move = px / prev - 1
    qualified = y(ok).fillna(False).astype(bool) & (move.abs() <= MAX_MOVE)
    sma = (y(c.rolling(SMA_DAYS - 1).sum()) + px) / SMA_DAYS
    up = 0.5 * y(au) + 0.5 * (px - prev).clip(lower=0)
    dn = 0.5 * y(ad) + 0.5 * (prev - px).clip(lower=0)
    rsi = 100 - 100 / (1 + up / dn)
    setups = {"rsi2": rsi < RSI_MAX, "low10": px <= y(c.rolling(LOW_DAYS - 1).min()),
              "down3": (move < 0) & (y(r) < 0) & (y(r.shift(1)) < 0),
              "every": pd.DataFrame(True, index=idx, columns=cols)}
    eligible = qualified & (px > sma)
    # Daily 15:15 -> 15:15 returns for holding; a missing 15:15 price carries the last one (up to 3 days).
    pxf = px.ffill(limit=3)
    ret = pxf / pxf.shift(1) - 1
    ret = ret.where(ret.abs() <= MAX_MOVE, 0.0).fillna(0.0)
    return {"px": pxf, "rsi": rsi, "eligible": eligible, "setups": setups, "r": ret,
            "rankable": qualified.sum(axis=1)}


def _book(d, variant):
    base, take = parse_variant(variant)
    meta = VARIANTS[base]
    hit = (d["setups"][meta["setup"]] & d["eligible"]).fillna(False)
    if TAKES[take]:
        order = d["rsi"].where(hit).rank(axis=1, method="first")
        hit = hit & (order <= TAKES[take])
    hit = hit & (d["rankable"] >= MIN_STOCKS).to_numpy()[:, None]
    n = hit.sum(axis=1)
    sig = hit.astype(float).div(n.where(n > 0, 1), axis=0)  # each day's picks share one slice
    w = sig.rolling(meta["hold"], min_periods=1).sum() / meta["hold"]
    return {"w": w, "r": d["r"], "hit": hit}


def run(dataset):
    d = _data(dataset)
    out, lots_out = {}, {}
    lot = xsmr.lot_series(d["px"].columns)
    for variant in (variant_id(v, t) for v in VARIANTS for t in TAKES):
        b = _book(d, variant)
        held = b["w"].shift(1).fillna(0.0)
        gross = (held * b["r"]).sum(axis=1)
        turnover = (b["w"] - held).abs().sum(axis=1)
        stocks = (held > 0).sum(axis=1)
        first = b["w"].index[(b["w"].sum(axis=1) > 0).to_numpy()].min()
        days = d["px"].index[d["px"].index >= first]
        out[variant] = [(t.date(), float(gross[t]), float(turnover[t]), float(gross[t]), 0.0, int(stocks[t])) for t in days]
        lots_out[variant] = xsmom._lot_rows(d["px"], b, lot, days)
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
        f = xsmr._load(variant_id(base, take), dataset, slippage, model=MODEL, lots=lots)
        if not f.empty:
            rows.append({"variant": variant_id(base, take), "label": meta["label"], "book": base in BOOK, **xsmr._stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, lots=False):
    return xsmr.month_days(variant, dataset, month, slippage, model=MODEL, lots=lots)


def day_trades(variant, dataset, day):
    """Every stock held into one day's 15:15: weight, when it was bought and its 2-day RSI then, the day's move."""
    ts = pd.Timestamp(day)
    d = _data(dataset, day - timedelta(days=30), day)
    if ts not in d["px"].index:
        return []
    b = _book(d, variant)
    i = d["px"].index.get_loc(ts)
    if i < 1:
        return []
    prev = d["px"].index[i - 1]
    held = b["w"].loc[prev]
    hold = VARIANTS[parse_variant(variant)[0]]["hold"]
    window = d["px"].index[max(0, i - hold):i]
    rows, lot = [], xsmr.lot_series(d["px"].columns)
    for symbol, w in held.items():
        if w <= 0:
            continue
        bought = [t for t in window if b["hit"].at[t, symbol]]
        last = bought[-1] if bought else prev
        move = float(b["r"].at[ts, symbol])
        size = lot.get(symbol)
        rsi = d["rsi"].at[last, symbol]
        rows.append({"symbol": symbol, "side": "long", "weight_pct": round(100 * w, 3),
                     "signal_pct": round(float(rsi), 1) if pd.notna(rsi) else None,
                     "bought": ", ".join(t.date().isoformat() for t in bought),
                     "entry": round(float(d["px"].at[prev, symbol]), 2), "exit": round(float(d["px"].at[ts, symbol]), 2),
                     "move_pct": round(100 * move, 2), "contribution_bps": round(10000 * w * move, 2),
                     "lot_size": int(size) if pd.notna(size) else None,
                     "pnl_rs": round(size * move * float(d["px"].at[prev, symbol])) if pd.notna(size) else None})
    return sorted(rows, key=lambda x: -x["contribution_bps"])
