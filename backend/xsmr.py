"""Cross-sectional mean reversion: Chan's linear long-short model (Algorithmic Trading ch. 4,
after Khandani & Lo), on the F&O stocks (or the Nifty 50).

Each day every stock gets weight w_i = -(r_i - mean r) / sum_j |r_j - mean r|: long the stocks
that lagged the cross-section, short the ones that led, in proportion to the move; the long and
short sides are each half of gross exposure, so the book is market-neutral. Two variants, both
from the book, no parameters:

- "intraday": r = previous official close -> today's 09:15 open; enter at the open, exit at 15:15
  (the close of the 15:00 candle). Turnover: the whole book twice a day. The book enters at the
  open ("intraday-0915"); "intraday-0916" (from the 1-minute candles: a market order sent once the
  open is known), "-0930" and "-0945" use the same signal but enter later. They are an execution check, not alternatives: the edge sits almost entirely in the
  09:15 auction price.
- "daily": r = previous day's 15:15 -> today's 15:15; hold to 15:15 the next day, rebalancing
  daily. Turnover: sum |w_t - w_t-1|.

Results are portfolio returns on gross exposure (not R per trade). Costs: NSE futures charges and
slippage on every rupee traded (costs_per_side). Stored per day in bt_portfolio.
"""

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

import backtest
from db import connect

VARIANTS = {
    "intraday-0915": {"label": "Intraday · enter 09:15 (book)", "entry": "09:15"},
    "intraday-0916": {"label": "Intraday · enter 09:16", "entry": "09:16"},
    "intraday-0930": {"label": "Intraday · enter 09:30", "entry": "09:30"},
    "intraday-0945": {"label": "Intraday · enter 09:45", "entry": "09:45"},
    "daily": {"label": "Daily · 15:15 to next 15:15 (book)", "entry": "15:15"},
}
BOOK = ("intraday-0915", "daily")
# How many stocks the book holds. "all" is the book: linear weights on every priced stock (~190
# F&O stocks a day, one futures lot each: not tradable on a small account). "top5"/"top3": only
# the N stocks per side furthest from the cross-section mean, equal rupees each, so the book is
# 2N positions. Stored as "<variant>-<take>"; "all" keeps the plain variant id.
TAKES = {"all": None, "top5": 5, "top3": 3}


def variant_id(base, take="all"):
    return base if take == "all" else f"{base}-{take}"


def parse_variant(variant):
    """'intraday-0915-top5' -> ('intraday-0915', 'top5'); raises ValueError if unknown."""
    for take in TAKES:
        if take != "all" and variant.endswith(f"-{take}"):
            base = variant[: -len(take) - 1]
            break
    else:
        base, take = variant, "all"
    if base not in VARIANTS:
        raise ValueError(f"unknown variant {variant}")
    return base, take
DATASETS = ("fno", "stocks")
TRADING_DAYS = 248
MIN_STOCKS = 20  # days with fewer priced stocks are skipped
# Data hygiene, not tuning: a 15:15 price outside the day's high-low range is a bad print (PIIND
# Dec 2018 shows 15:00 closes ~89% below the open for weeks), and a move over 20% from one price
# to the next (beyond NSE's F&O price bands) is a corporate action (ADANIENT 2015-06-03, +203%).
RANGE_TOLERANCE = 0.005
MAX_MOVE = 0.20


def _ensure_table(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bt_portfolio (
            model TEXT NOT NULL, variant TEXT NOT NULL, dataset TEXT NOT NULL, day DATE NOT NULL,
            gross_ret DOUBLE PRECISION NOT NULL,  -- return on gross exposure (long + short = 1)
            turnover DOUBLE PRECISION NOT NULL,   -- rupees traded per rupee of gross exposure
            long_ret DOUBLE PRECISION, short_ret DOUBLE PRECISION, stocks INTEGER,
            PRIMARY KEY (model, variant, dataset, day)
        );
        """
    )


def _prices(dataset, start=None, end=None):
    """Per symbol and day: the 09:15 open and the 15:15 price (close of the 15:00 candle) from the
    15m candles, and the official close from the daily candles. Days where the 09:15 open is more
    than 1% from the daily open are dropped (stale prints, as in buy-on-gap), and so are 15:15
    prices outside the day's high-low range (bad prints)."""
    with connect() as conn:
        frame = pd.read_sql(
            """
            WITH s AS (SELECT symbol FROM bt_symbols WHERE dataset = %(ds)s),
            b AS (
              SELECT symbol, (datetime AT TIME ZONE 'Asia/Kolkata')::date AS day,
                     (datetime AT TIME ZONE 'Asia/Kolkata')::time AS t, open, close
              FROM bt_15m WHERE symbol IN (SELECT symbol FROM s)
                AND datetime >= COALESCE(%(start)s::date, DATE '1900-01-01')
                AND datetime < COALESCE(%(end)s::date, DATE '2999-01-01') + 1
            )
            SELECT b.symbol, b.day,
                   max(b.open) FILTER (WHERE b.t = '09:15') AS open915,
                   max(b.open) FILTER (WHERE b.t = '09:30') AS open930,
                   max(b.open) FILTER (WHERE b.t = '09:45') AS open945,
                   max(b.close) FILTER (WHERE b.t = '15:00') AS px1515,
                   max(d.open) AS day_open, max(d.close) AS day_close,
                   max(d.high) AS day_high, max(d.low) AS day_low
            FROM b JOIN bt_daily d ON d.symbol = b.symbol AND d.day = b.day
            GROUP BY b.symbol, b.day
            """,
            conn, params={"ds": dataset, "start": start, "end": end},
        )
    bad = (frame["open915"] / frame["day_open"] - 1).abs() > backtest.GAP_OPEN_TOLERANCE
    frame.loc[bad, "open915"] = np.nan
    outside = ((frame["px1515"] > frame["day_high"] * (1 + RANGE_TOLERANCE))
               | (frame["px1515"] < frame["day_low"] * (1 - RANGE_TOLERANCE)) | (frame["px1515"] <= 0))
    frame.loc[outside, "px1515"] = np.nan
    for col in ("open930", "open945"):
        frame.loc[(frame[col] > frame["day_high"] * (1 + RANGE_TOLERANCE))
                  | (frame[col] < frame["day_low"] * (1 - RANGE_TOLERANCE)) | (frame[col] <= 0), col] = np.nan
    frame.loc[frame["day_close"] <= 0, "day_close"] = np.nan
    # 09:16 price: the open of the 09:16 minute candle (minute index 1 in bt_1m), where downloaded.
    with connect() as conn:
        m = pd.read_sql("SELECT symbol, day, open[array_position(minute, 1::smallint)] AS open916 FROM bt_1m "
                        "WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = %(ds)s) "
                        "AND day BETWEEN COALESCE(%(start)s::date, DATE '1900-01-01') AND COALESCE(%(end)s::date, DATE '2999-01-01')",
                        conn, params={"ds": dataset, "start": start, "end": end})
    frame = frame.merge(m, on=["symbol", "day"], how="left")
    frame.loc[(frame["open916"] > frame["day_high"] * (1 + RANGE_TOLERANCE))
              | (frame["open916"] < frame["day_low"] * (1 - RANGE_TOLERANCE)) | (frame["open916"] <= 0), "open916"] = np.nan
    frame["day"] = pd.to_datetime(frame["day"])
    return {col: frame.pivot(index="day", columns="symbol", values=col).sort_index()
            for col in ("open915", "open916", "open930", "open945", "px1515", "day_close")}


def _weights(signal, top=None):
    """Linear long-short weights per row: -(r - mean) / sum |r - mean|, NaN where unpriced.
    With top=N: only the N lowest and N highest deviations, each +-0.5/N (equal rupees per stock)."""
    dev = signal.sub(signal.mean(axis=1), axis=0)
    if top is None:
        return -dev.div(dev.abs().sum(axis=1), axis=0)
    low = dev.rank(axis=1, method="first")
    high = dev.rank(axis=1, method="first", ascending=False)
    w = pd.DataFrame(0.0, index=dev.index, columns=dev.columns)
    w[low <= top] = 0.5 / top
    w[high <= top] = -0.5 / top
    return w.where(dev.notna())


ENTRY_COLS = {"intraday-0915": "open915", "intraday-0916": "open916", "intraday-0930": "open930",
              "intraday-0945": "open945"}


def _book(p, variant):
    variant, take = parse_variant(variant)
    """Signal, weights, entry and exit prices per day and stock for one variant.
    Intraday: signal previous official close -> 09:15 open; position entry -> 15:15 the same day.
    Daily: signal 15:15(t-1) -> 15:15(t); position 15:15(t) -> 15:15(t+1), rebalanced daily."""
    if variant == "daily":
        px = p["px1515"]
        sig = px / px.shift(1) - 1
        entry, exit_ = px, px.shift(-1)
    else:
        sig = p["open915"] / p["day_close"].shift(1) - 1
        entry, exit_ = p[ENTRY_COLS[variant]], p["px1515"]
    pos = exit_ / entry - 1
    ok = sig.notna() & pos.notna() & (sig.abs() <= MAX_MOVE) & (pos.abs() <= MAX_MOVE)
    w = _weights(sig.where(ok), TAKES[take]).fillna(0.0)
    return {"sig": sig, "w": w, "pos": pos, "entry": entry, "exit": exit_, "n": ok.sum(axis=1)}


def run(dataset):
    p = _prices(dataset)
    out = {}
    for variant in (variant_id(v, t) for v in VARIANTS for t in TAKES):
        b = _book(p, variant)
        rows, prev = [], None
        for day in b["w"].index:
            if b["n"][day] < MIN_STOCKS:
                prev = None
                continue
            wd, rd = b["w"].loc[day], b["pos"].loc[day].fillna(0.0)
            if variant.startswith("daily"):  # rebalance from yesterday's book
                traded = float(wd.abs().sum() if prev is None else (wd - prev).abs().sum())
                prev = wd
            else:  # the whole book in at the open, out at 15:15
                traded = float(2 * wd.abs().sum())
            rows.append((day.date(), float((wd * rd).sum()), traded,
                         float((wd.clip(lower=0) * rd).sum()), float((wd.clip(upper=0) * rd).sum()), int(b["n"][day])))
        out[variant] = rows
    return out


def day_trades(variant, dataset, day):
    """Every stock position the model held on one day (day: datetime.date)."""
    from datetime import timedelta
    p = _prices(dataset, day - timedelta(days=10), day + timedelta(days=10))
    b = _book(p, variant)
    ts = pd.Timestamp(day)
    if ts not in b["w"].index or b["n"][ts] < MIN_STOCKS:
        return []
    rows = []
    for symbol, w in b["w"].loc[ts].items():
        if w == 0:
            continue
        r = float(b["pos"].at[ts, symbol])
        rows.append({"symbol": symbol, "side": "long" if w > 0 else "short", "weight_pct": round(100 * abs(w), 3),
                     "signal_pct": round(100 * float(b["sig"].at[ts, symbol]), 2),
                     "entry": round(float(b["entry"].at[ts, symbol]), 2), "exit": round(float(b["exit"].at[ts, symbol]), 2),
                     "move_pct": round(100 * r, 2), "contribution_bps": round(10000 * w * r, 2)})
    return sorted(rows, key=lambda x: -x["contribution_bps"])


def run_all(datasets=DATASETS):
    with connect() as conn, conn.cursor() as cursor:
        _ensure_table(cursor)
        conn.commit()
    counts = {}
    for dataset in datasets:
        result = run(dataset)
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("DELETE FROM bt_portfolio WHERE model = 'xsmr' AND dataset = %s", (dataset,))
            for variant, rows in result.items():
                execute_values(cursor, "INSERT INTO bt_portfolio (model, variant, dataset, day, gross_ret, turnover, "
                                       "long_ret, short_ret, stocks) VALUES %s",
                               [("xsmr", variant, dataset, *r) for r in rows], page_size=5000)
                counts[(dataset, variant)] = len(rows)
            conn.commit()
    return counts


def cost_per_side(slippage=0.0002, notional=None):
    """Cost of trading one rupee once (one side), averaged over buys and sells: NSE futures
    exchange + SEBI fees with GST, STT on sells, stamp duty on buys, brokerage per order on a
    one-lot notional, and slippage."""
    notional = notional or backtest.LOT_NOTIONAL["fno"]
    brokerage = backtest.BROKERAGE_PER_ORDER / notional
    fees = (backtest.EXCHANGE + backtest.SEBI + brokerage) * (1 + backtest.GST)
    return fees + (backtest.STT_SELL + backtest.STAMP_BUY) / 2 + slippage


def _load(variant, dataset, slippage, model="xsmr"):
    with connect() as conn:
        f = pd.read_sql("SELECT day, gross_ret, turnover, long_ret, short_ret, stocks FROM bt_portfolio "
                        "WHERE model = %s AND variant = %s AND dataset = %s ORDER BY day",
                        conn, params=[model, variant, dataset])
    if f.empty:
        return f
    f["cost"] = f["turnover"] * cost_per_side(slippage)
    f["net_ret"] = f["gross_ret"] - f["cost"]
    f["day"] = pd.to_datetime(f["day"])
    return f


def _stats(f):
    """Fixed gross exposure every day, not compounded: annual return = mean daily x 248."""
    def one(col):
        r = f[col]
        eq = r.cumsum()
        return {
            "ann_return_pct": round(float(100 * r.mean() * TRADING_DAYS), 1),
            "sharpe": round(float(r.mean() / r.std() * np.sqrt(TRADING_DAYS)), 2) if r.std() else None,
            "max_dd_pct": round(float(100 * (eq - eq.cummax()).min()), 1),
            "avg_day_bps": round(float(10000 * r.mean()), 2),
            "win_days_pct": round(float(100 * (r > 0).mean()), 1),
        }
    yearly = f.groupby(f["day"].dt.year)["net_ret"].sum()
    return {
        "days": int(len(f)), "from": f["day"].iloc[0].date().isoformat(), "to": f["day"].iloc[-1].date().isoformat(),
        "avg_stocks": round(float(f["stocks"].mean())), "avg_turnover": round(float(f["turnover"].mean()), 2),
        "avg_cost_bps": round(float(10000 * f["cost"].mean()), 2),
        "long_bps": round(float(10000 * f["long_ret"].mean()), 2), "short_bps": round(float(10000 * f["short_ret"].mean()), 2),
        "gross": one("gross_ret"), "net": one("net_ret"),
        "green_years": int((yearly > 0).sum()), "years": int(len(yearly)),
    }


def summary(variant, dataset, slippage=0.0002):
    f = _load(variant, dataset, slippage)
    return (_stats(f) if not f.empty else None), f


def results(variant, dataset, slippage=0.0002, model="xsmr"):
    """Everything the backtest page shows for one variant (of any model stored in bt_portfolio)."""
    f = _load(variant, dataset, slippage, model)
    if f.empty:
        return {"summary": None, "years": [], "months": [], "equity": []}
    f["year"], f["month"] = f["day"].dt.year, f["day"].dt.strftime("%Y-%m")

    def group(key):
        g = f.groupby(key)
        return [{key: (int(k) if key == "year" else k), "days": int(len(x)), "net_pct": round(float(100 * x["net_ret"].sum()), 2),
                 "gross_pct": round(float(100 * x["gross_ret"].sum()), 2),
                 "win_days_pct": round(float(100 * (x["net_ret"] > 0).mean()), 1)} for k, x in g]

    weekly = f.set_index("day")[["gross_ret", "net_ret"]].resample("W-FRI").sum().cumsum()
    equity = [{"date": d.date().isoformat(), "gross": round(float(100 * g), 2), "net": round(float(100 * n), 2)}
              for d, g, n in zip(weekly.index, weekly["gross_ret"], weekly["net_ret"])]
    return {"summary": _stats(f), "years": group("year"), "months": group("month"), "equity": equity,
            "cost_per_side_bps": round(10000 * cost_per_side(slippage), 2)}


def compare(dataset, slippage=0.0002, take="all"):
    rows = []
    for base, meta in VARIANTS.items():
        variant = variant_id(base, take)
        f = _load(variant, dataset, slippage)
        if not f.empty:
            rows.append({"variant": variant, "label": meta["label"], "book": base in BOOK, **_stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, model="xsmr"):
    """Each trading day of one month (YYYY-MM): what the month cell on the page adds up."""
    f = _load(variant, dataset, slippage, model)
    if f.empty:
        return []
    f = f[f["day"].dt.strftime("%Y-%m") == month]
    return [{"day": r.day.date().isoformat(), "gross_pct": round(100 * r.gross_ret, 3), "cost_pct": round(100 * r.cost, 3),
             "net_pct": round(100 * r.net_ret, 3), "long_pct": round(100 * r.long_ret, 3) if pd.notna(r.long_ret) else None,
             "short_pct": round(100 * r.short_ret, 3) if pd.notna(r.short_ret) else None, "turnover": round(r.turnover, 2),
             "stocks": int(r.stocks)} for r in f.itertuples()]
