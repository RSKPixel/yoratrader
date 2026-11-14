"""Pairs trading with cointegration (Chan, Algorithmic Trading ch. 2-4) on the F&O stocks.

Walk-forward, so every trade is out of sample:

1. Formation (calendar year Y-1): every pair of F&O stocks in the same NSE industry (Nifty 500
   classification, data/industries.csv) gets the Engle-Granger cointegration test on daily closes:
   OLS y = c + h*x, then an ADF test (lag 1, constant) on the residual. Both orders are tried and
   the more negative t-stat is kept (Chan's CADF). A pair is selected when t is below the 5%
   critical value (MacKinnon 2010, two variables, constant) and the hedge ratio h is positive.
   The half-life of the residual (Ornstein-Uhlenbeck regression) is recorded.
2. Trading (calendar year Y), one of two book methods, no parameters fitted to results:
   - "bollinger" (ch. 3): spread = y - h*x with h fixed from formation; z-score over a lookback
     equal to the half-life (ch. 2's rule). Long the spread below z = -1, short above +1, exit
     when z crosses 0. Holding: 1 share of y against h shares of x.
   - "kalman" (ch. 3): a Kalman filter re-estimates the hedge ratio and intercept every day
     (the book's delta = 0.0001, Ve = 0.001). Long the spread while the forecast error e is below
     -sqrt(Q), short while above +sqrt(Q). Run on log prices so the book's noise settings mean
     the same for a Rs 100 and a Rs 10,000 stock; the hedge is then in rupees (1 of y against
     beta of x), rebalanced daily.
   Positions still open on the last day of Y are closed; selection starts over for Y+1.
3. Execution: the book trades at the close the signal is computed from ("bollinger", "kalman").
   The "-next" versions keep the same signal and trade one close later: a fill check.

Years with fewer than 10 selected pairs are skipped (2001-2003: too few stocks with history).
Capital: equal per selected pair, idle when the pair is flat, so the portfolio return each day is
the sum of pair returns / number of pairs selected that year. A pair stops for the rest of the
year if either stock moves more than 20% in a day or has no price (corporate action or bad
data; that day's P&L is not counted). Costs: NSE futures charges + slippage per rupee traded
(xsmr.cost_per_side). Survivorship bias: today's F&O list is used for every year.
"""

import csv
import os
from itertools import combinations

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

import xsmr
from db import connect

MODEL = "pairs"
DATASET = "fno"
VARIANTS = {
    "bollinger": {"label": "Bollinger · trade at signal close (book)"},
    "bollinger-next": {"label": "Bollinger · trade next close"},
    "kalman": {"label": "Kalman filter · trade at signal close (book)"},
    "kalman-next": {"label": "Kalman filter · trade next close"},
}
BOOK = ("bollinger", "kalman")
# How many of the year's selected pairs to trade. "all" is the book (often 100+ pairs: 200+ legs,
# not tradable on a small account). "top10"/"top5": the pairs with the most negative formation
# t-stat, fixed before the year starts; capital split N ways.
TAKES = {"all": None, "top10": 10, "top5": 5}


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
FIRST_YEAR = 2001  # formation 2000, the first year of Kite daily history
MIN_FORMATION_DAYS = 200
MIN_PAIRS = 10  # a year is traded only when at least this many pairs pass (so every Take covers the same years)
ENTRY_Z, EXIT_Z = 1.0, 0.0
KALMAN_DELTA, KALMAN_VE = 0.0001, 0.001
MAX_MOVE = xsmr.MAX_MOVE
INDUSTRIES = os.path.join(os.path.dirname(__file__), "data", "industries.csv")


def industries():
    with open(INDUSTRIES) as f:
        return {r["symbol"]: r["industry"] for r in csv.DictReader(f)}


def _ensure_table(cursor):
    xsmr._ensure_table(cursor)
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bt_pairs (
            variant TEXT NOT NULL, year INTEGER NOT NULL, rank INTEGER NOT NULL, y TEXT NOT NULL, x TEXT NOT NULL,
            industry TEXT, hedge DOUBLE PRECISION, tstat DOUBLE PRECISION, half_life DOUBLE PRECISION,
            trades INTEGER, days_open INTEGER,
            gross_ret DOUBLE PRECISION,  -- summed daily return on the pair's capital
            turnover DOUBLE PRECISION,   -- rupees traded per rupee of the pair's capital
            stopped DATE,                -- day the pair was stopped for bad data, if it was
            PRIMARY KEY (variant, year, y, x)
        );
        CREATE TABLE IF NOT EXISTS bt_pair_trades (
            variant TEXT NOT NULL, year INTEGER NOT NULL, rank INTEGER NOT NULL, y TEXT NOT NULL, x TEXT NOT NULL,
            side TEXT NOT NULL,  -- long or short the spread (long = long y, short x)
            entry_day DATE NOT NULL, exit_day DATE NOT NULL, days INTEGER NOT NULL,
            gross_ret DOUBLE PRECISION NOT NULL,  -- on the pair's capital
            turnover DOUBLE PRECISION NOT NULL
        );
        CREATE INDEX IF NOT EXISTS bt_pair_trades_exit ON bt_pair_trades (variant, exit_day);
        """
    )


def _closes():
    with connect() as conn:
        frame = pd.read_sql("SELECT symbol, day, close FROM bt_daily WHERE close > 0 AND symbol IN "
                            "(SELECT symbol FROM bt_symbols WHERE dataset = %s)", conn, params=[DATASET])
    frame["day"] = pd.to_datetime(frame["day"])
    return frame.pivot(index="day", columns="symbol", values="close").sort_index()


def critical_value(n):
    """5% Engle-Granger critical value for two variables with a constant (MacKinnon 2010)."""
    return -3.33613 - 6.1101 / n - 6.823 / n ** 2


def _ols(y, X):
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    return coef, y - X @ coef


def adf_t(s):
    """ADF t-stat with one lag and a constant: d s_t = a + g s_{t-1} + b d s_{t-1}."""
    ds = np.diff(s)
    y = ds[1:]
    X = np.column_stack([np.ones(len(y)), s[1:-1], ds[:-1]])
    coef, resid = _ols(y, X)
    sigma2 = resid @ resid / (len(y) - X.shape[1])
    cov = sigma2 * np.linalg.inv(X.T @ X)
    return coef[1] / np.sqrt(cov[1, 1])


def half_life(s):
    coef, _ = _ols(np.diff(s), np.column_stack([np.ones(len(s) - 1), s[:-1]]))
    return -np.log(2) / coef[1] if coef[1] < 0 else np.inf


def cadf(a, b):
    """Engle-Granger on two price arrays; returns (y_is_a, hedge, tstat, half_life) for the better order."""
    best = None
    for y_is_a, (y, x) in ((True, (a, b)), (False, (b, a))):
        coef, resid = _ols(y, np.column_stack([np.ones(len(x)), x]))
        t = adf_t(resid)
        if best is None or t < best[2]:
            best = (y_is_a, coef[1], t, half_life(resid))
    return best


def select(closes, year, ind):
    """Cointegrated same-industry pairs on year-1's closes."""
    form = closes[closes.index.year == year - 1]
    moves = (form / form.shift(1) - 1).abs()
    usable = [s for s in form.columns
              if form[s].notna().sum() >= MIN_FORMATION_DAYS and not (moves[s] > MAX_MOVE).any() and s in ind]
    pairs = []
    for a, b in combinations(sorted(usable), 2):
        if ind[a] != ind[b]:
            continue
        both = form[[a, b]].dropna()
        if len(both) < MIN_FORMATION_DAYS:
            continue
        y_is_a, hedge, t, hl = cadf(both[a].to_numpy(), both[b].to_numpy())
        if t < critical_value(len(both)) and hedge > 0 and np.isfinite(hl):
            y, x = (a, b) if y_is_a else (b, a)
            pairs.append({"y": y, "x": x, "industry": ind[a], "hedge": float(hedge), "tstat": float(t),
                          "half_life": float(hl)})
    pairs.sort(key=lambda p: p["tstat"])  # strongest cointegration first: rank 1
    for rank, p in enumerate(pairs, 1):
        p["rank"] = rank
    return pairs


def _bollinger_signal(y, x, hedge, lookback):
    """Spread position (-1, 0, +1) decided at each close."""
    spread = y - hedge * x
    z = ((spread - spread.rolling(lookback).mean()) / spread.rolling(lookback).std()).to_numpy()
    pos, out = 0, np.zeros(len(z))
    for i, zi in enumerate(z):
        if np.isnan(zi):
            pos = 0
        elif pos == 0:
            pos = 1 if zi < -ENTRY_Z else -1 if zi > ENTRY_Z else 0
        elif pos == 1 and zi >= -EXIT_Z:
            pos = 0
        elif pos == -1 and zi <= EXIT_Z:
            pos = 0
        out[i] = pos
    return out


def _kalman(ly, lx):
    """Chan's Kalman filter for y = beta*x + c. Returns per close: position (-1, 0, +1) and the slope."""
    n = len(ly)
    beta, P = np.zeros(2), np.zeros((2, 2))
    Vw = KALMAN_DELTA / (1 - KALMAN_DELTA) * np.eye(2)
    pos, slope = np.zeros(n), np.zeros(n)
    for t in range(n):
        R = P + Vw if t > 0 else np.zeros((2, 2))
        obs = np.array([lx[t], 1.0])
        Q = obs @ R @ obs + KALMAN_VE
        e = ly[t] - obs @ beta
        K = R @ obs / Q
        beta = beta + K * e
        P = R - np.outer(K, obs) @ R
        pos[t] = 1 if e < -np.sqrt(Q) else -1 if e > np.sqrt(Q) else 0
        slope[t] = beta[0]
    return pos, slope


def _trade(method, lag, y, x, pair, year_mask):
    """Daily (return, turnover, position) on the pair's capital over the trading year.
    y, x: closes over formation + trading years (formation is warm-up only)."""
    ry, rx = (y / y.shift(1) - 1).to_numpy(), (x / x.shift(1) - 1).to_numpy()
    if method == "bollinger":
        signal = _bollinger_signal(y, x, pair["hedge"], max(2, int(round(pair["half_life"]))))
        hedge = np.full(len(y), pair["hedge"])
        # 1 share of y against h shares of x, as rupee weights of the pair's gross value.
        wy = y.to_numpy() / (y.to_numpy() + hedge * x.to_numpy())
        wx = 1 - wy
    else:
        signal, slope = _kalman(np.log(y.to_numpy()), np.log(x.to_numpy()))
        wy = 1 / (1 + np.abs(slope))
        wx = slope / (1 + np.abs(slope))
    idx = np.flatnonzero(year_mask)
    last = idx[-1]
    rows, held_y, held_x, stopped = [], 0.0, 0.0, None
    for i in idx:
        # P&L on the holding carried into today's close.
        bad = not (np.isfinite(ry[i]) and np.isfinite(rx[i])) or abs(ry[i]) > MAX_MOVE or abs(rx[i]) > MAX_MOVE
        if bad:
            stopped = y.index[i].date()
            ret = 0.0
        else:
            ret = held_y * ry[i] - held_x * rx[i]
        # Target holding after today's close.
        s = 0.0
        if not bad and i != last and i - lag >= idx[0]:
            s = signal[i - lag]
        if method == "bollinger" and s and s == np.sign(held_y):
            target_y, target_x = held_y, held_x  # fixed share counts while the trade is open
        else:
            target_y, target_x = s * wy[i], s * wx[i]
        traded = abs(target_y - held_y) + abs(target_x - held_x)
        rows.append((y.index[i], ret, traded, int(s)))
        held_y, held_x = target_y, target_x
        if bad:
            break
    return rows, stopped


def run():
    closes = _closes()
    ind = industries()
    years = range(FIRST_YEAR, closes.index.max().year + 1)
    daily = {variant_id(v, t): {} for v in VARIANTS for t in TAKES}
    per_pair, trades_out = [], []
    for year in years:
        pairs = select(closes, year, ind)
        if len(pairs) < MIN_PAIRS:  # early years: too few stocks with history for a book
            continue
        span = closes[(closes.index.year == year - 1) | (closes.index.year == year)]
        trading_days = span.index[span.index.year == year]
        for base in VARIANTS:
            method, lag = base.split("-")[0], 1 if base.endswith("-next") else 0
            books = {t: pd.DataFrame(0.0, index=trading_days, columns=["ret", "turnover", "long", "short", "open"])
                     for t in TAKES}
            for pair in pairs:
                both = span[[pair["y"], pair["x"]]].dropna()
                mask = (both.index.year == year)
                if mask.sum() == 0:
                    continue
                rows, stopped = _trade(method, lag, both[pair["y"]], both[pair["x"]], pair, mask)
                takes = [t for t, n in TAKES.items() if n is None or pair["rank"] <= n]
                prev, gross, turnover, trades, days_open, current = 0, 0.0, 0.0, 0, 0, None
                for day, ret, traded, sig in rows:
                    for t in takes:
                        b = books[t]
                        b.at[day, "ret"] += ret
                        b.at[day, "turnover"] += traded
                        if prev > 0:
                            b.at[day, "long"] += ret
                        elif prev < 0:
                            b.at[day, "short"] += ret
                        if sig:
                            b.at[day, "open"] += 1
                    if current is not None:  # the open trade earns today's P&L
                        current["ret"] += ret
                        current["turnover"] += (traded if sig == 0 else traded / 2) if sig != prev else 0.0
                        if sig != prev:  # closed (or flipped) at today's close
                            current["exit"], current["days"] = day.date(), current["days"] + 1
                            trades_out.append(current)
                            current = None
                        else:
                            current["days"] += 1
                    if sig and sig != prev:
                        trades += 1
                        current = {"base": base, "year": year, "y": pair["y"], "x": pair["x"], "rank": pair["rank"],
                                   "side": "long" if sig > 0 else "short", "entry": day.date(), "exit": None, "days": 0,
                                   "ret": 0.0, "turnover": traded if prev == 0 else traded / 2}
                    if sig:
                        days_open += 1
                    gross += ret
                    turnover += traded
                    prev = sig
                if current is not None:  # stopped for bad data while open
                    current["exit"] = rows[-1][0].date()
                    trades_out.append(current)
                per_pair.append((base, year, pair["rank"], pair["y"], pair["x"], pair["industry"], pair["hedge"],
                                 pair["tstat"], pair["half_life"], trades, days_open, float(gross), float(turnover), stopped))
            for take, book in books.items():
                n = len(pairs) if TAKES[take] is None else min(TAKES[take], len(pairs))
                for day, r in book.iterrows():
                    daily[variant_id(base, take)][day.date()] = (
                        float(r["ret"] / n), float(r["turnover"] / n), float(r["long"] / n), float(r["short"] / n),
                        int(r["open"]))
    return daily, per_pair, trades_out


def run_all():
    daily, per_pair, trades = run()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_table(cursor)
        cursor.execute("DELETE FROM bt_portfolio WHERE model = %s", (MODEL,))
        cursor.execute("DROP TABLE IF EXISTS bt_pairs")  # schema changed while building; cheap to recreate
        cursor.execute("DROP TABLE IF EXISTS bt_pair_trades")
        _ensure_table(cursor)
        for variant, days in daily.items():
            execute_values(cursor, "INSERT INTO bt_portfolio (model, variant, dataset, day, gross_ret, turnover, "
                                   "long_ret, short_ret, stocks) VALUES %s",
                           [(MODEL, variant, DATASET, d, *v) for d, v in sorted(days.items())], page_size=5000)
        execute_values(cursor, "INSERT INTO bt_pairs (variant, year, rank, y, x, industry, hedge, tstat, half_life, trades, "
                               "days_open, gross_ret, turnover, stopped) VALUES %s", per_pair, page_size=5000)
        execute_values(cursor, "INSERT INTO bt_pair_trades (variant, year, rank, y, x, side, entry_day, exit_day, days, "
                               "gross_ret, turnover) VALUES %s",
                       [(t["base"], t["year"], t["rank"], t["y"], t["x"], t["side"], t["entry"], t["exit"], t["days"],
                         float(t["ret"]), float(t["turnover"])) for t in trades], page_size=5000)
        conn.commit()
    return {v: len(d) for v, d in daily.items()}, len(per_pair)


def _take_n(take):
    return TAKES[take] or 10**9


def results(variant, slippage=0.0002):
    """The page: portfolio results plus, per year, how many pairs were traded and how they did."""
    base, take = parse_variant(variant)
    out = xsmr.results(variant, DATASET, slippage, model=MODEL)
    cost = xsmr.cost_per_side(slippage)
    with connect() as conn:
        f = pd.read_sql("SELECT year, gross_ret, turnover, trades FROM bt_pairs WHERE variant = %s AND rank <= %s",
                        conn, params=[base, _take_n(take)])
    f["net"] = f["gross_ret"] - f["turnover"] * cost
    out["pair_years"] = [{"year": int(y), "pairs": int(len(g)), "traded": int((g["trades"] > 0).sum()),
                          "green": int((g["net"] > 0).sum()), "trades": int(g["trades"].sum())}
                         for y, g in f.groupby("year")]
    out["take_n"] = TAKES[take]
    return out


def pairs_year(variant, year, slippage=0.0002):
    """The pairs traded in one year, best first: formation stats and the year's result on the pair's capital."""
    base, take = parse_variant(variant)
    cost = xsmr.cost_per_side(slippage)
    with connect() as conn:
        f = pd.read_sql("SELECT rank, y, x, industry, hedge, tstat, half_life, trades, days_open, gross_ret, turnover, "
                        "stopped FROM bt_pairs WHERE variant = %s AND year = %s AND rank <= %s ORDER BY rank",
                        conn, params=[base, year, _take_n(take)])
    return [{"rank": int(r.rank), "y": r.y, "x": r.x, "industry": r.industry, "hedge": round(r.hedge, 3),
             "tstat": round(r.tstat, 2), "half_life": round(r.half_life, 1), "trades": int(r.trades),
             "days_open": int(r.days_open), "gross_pct": round(100 * r.gross_ret, 2),
             "net_pct": round(100 * (r.gross_ret - r.turnover * cost), 2),
             "stopped": r.stopped.isoformat() if r.stopped is not None and pd.notna(r.stopped) else None}
            for r in f.itertuples()]


def month_trades(variant, month, slippage=0.0002):
    """Trades closed in one month (YYYY-MM). net_pct is on the pair's capital; book_pct is the
    trade's share of the whole book (pair capital = book / number of pairs that year)."""
    base, take = parse_variant(variant)
    cost = xsmr.cost_per_side(slippage)
    with connect() as conn:
        f = pd.read_sql(
            """SELECT t.*, (SELECT count(*) FROM bt_pairs p WHERE p.variant = t.variant AND p.year = t.year
                            AND p.rank <= %(n)s) AS pairs
               FROM bt_pair_trades t WHERE t.variant = %(v)s AND t.rank <= %(n)s
               AND to_char(t.exit_day, 'YYYY-MM') = %(m)s ORDER BY t.exit_day, t.y""",
            conn, params={"v": base, "n": _take_n(take), "m": month})
    return [{"y": r.y, "x": r.x, "rank": int(r.rank), "side": r.side, "entry": r.entry_day.isoformat(),
             "exit": r.exit_day.isoformat(), "days": int(r.days), "gross_pct": round(100 * r.gross_ret, 2),
             "net_pct": round(100 * (r.gross_ret - r.turnover * cost), 2),
             "book_pct": round(100 * (r.gross_ret - r.turnover * cost) / r.pairs, 3)} for r in f.itertuples()]


def compare(slippage=0.0002, take="all"):
    rows = []
    for base, meta in VARIANTS.items():
        f = xsmr._load(variant_id(base, take), DATASET, slippage, model=MODEL)
        if not f.empty:
            rows.append({"variant": variant_id(base, take), "label": meta["label"], "book": base in BOOK, **xsmr._stats(f)})
    return rows
