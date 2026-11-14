"""Volatility breakout (Larry Williams, Long-Term Secrets to Short-Term Trading, 2nd ed. 2011), long
only, on the F&O indices (the book is about index futures) and the F&O stocks.

- Signal: a buy stop at today's 09:15 open + k x yesterday's range (high - low). Williams works with
  fractions from about half the range to the whole range, so both k = 0.5 and k = 1.0 are shown
  rather than one picked. Filled at the stop level (or the 15m candle's open if it opened above it)
  the first time a 15m candle from 09:15 to 15:00 reaches it.
- Exit (book): Williams' "first profitable open": sold at the first 09:15 open above the buy
  price, at most 5 trading days later (otherwise at the 5th day's open). No stop. "intraday" sells
  at 15:15 the same day instead: a check (it loses everywhere).
- Long only: the short mirror lost in every test (intraday and swing).
- Book: at most N positions open at once ("-max<N>"), each 1/N of capital; one per instrument at a
  time. A slot freed at an open can be filled by a later breakout that day. When more instruments
  break out than slots are free, the earliest breakouts fill first (as real stop orders would).

Computed on request from the 15m candles (2015 on) and cached. Returns: % of capital, marked at
15:15 each day, summed at a fixed size. Costs: NSE futures charges + slippage on the buy and the
sale (xsmr.cost_per_side); the futures roll is not charged. Data hygiene as in Buy on gap: the
first 15m open within 1% of the daily open, the 15:15 price within the day's range, no move over
20%. Muhurat sessions are not days. Caveat: the "first profitable open" exit flatters every long
entry (stocks have drifted up overnight); against a baseline that buys every 09:15 open with the
same exit, the breakout adds about 0.15% a trade on stocks and 0.2% on the indices.
"""

import threading
import time
from datetime import timedelta

import numpy as np
import pandas as pd

import backtest
import xsmr
from db import connect, stored_lot_sizes

MODEL = "vbo"
DATASETS = ("indices", "fno")
KS = {"k0.5": 0.5, "k1": 1.0}
EXITS = {"swing": "first profitable open, max 5 days (book)", "intraday": "sell at 15:15 the same day"}
MAX_OPEN = tuple(range(1, 11))
SWING_DAYS = 5
BARS = 24  # 09:15 .. 15:00
INDEX_LOTS = {"NIFTY 50": "NIFTY", "NIFTY BANK": "BANKNIFTY", "NIFTY FIN SERVICE": "FINNIFTY",
              "NIFTY MID SELECT": "MIDCPNIFTY", "NIFTY NEXT 50": "NIFTYNXT50"}
VARIANTS = {f"{k}-{e}-max{m}": {"label": f"k = {v:g} x range · {EXITS[e]} · max {m} open", "k": v, "exit": e, "max_open": m}
            for k, v in KS.items() for e in EXITS for m in MAX_OPEN}
BOOK = tuple(f"{k}-swing-max{m}" for k in KS for m in MAX_OPEN)
TAKES = {"all": None}
DEFAULT_OPEN = {"indices": 5, "fno": 5}


def variant_id(base, take="all"):
    return base


def parse_variant(variant):
    if variant not in VARIANTS:
        raise ValueError(f"unknown variant {variant}")
    return variant, "all"


def _load(dataset):
    """Day x symbol matrices: 09:15 open, 15:15 price, each 15m candle's open/high, yesterday's range."""
    with connect() as conn:
        bars = pd.read_sql(
            """
            SELECT symbol, (datetime AT TIME ZONE 'Asia/Kolkata')::date AS day,
                   ((extract(hour FROM datetime AT TIME ZONE 'Asia/Kolkata') * 60
                     + extract(minute FROM datetime AT TIME ZONE 'Asia/Kolkata') - 555) / 15)::int AS slot,
                   open, high, low, close
            FROM bt_15m WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = %s)
              AND (datetime AT TIME ZONE 'Asia/Kolkata')::time <= '15:00'
            """, conn, params=[dataset])
        daily = pd.read_sql("SELECT symbol, day, open, high, low, close FROM bt_daily WHERE close > 0 AND symbol IN "
                            "(SELECT symbol FROM bt_symbols WHERE dataset = %s)", conn, params=[dataset])
    daily["day"] = pd.to_datetime(daily["day"])
    count = daily.groupby("day").size()
    keep = count[count >= 0.8 * count.rolling(21, center=True, min_periods=1).median()].index
    daily = daily[daily["day"].isin(keep)].sort_values(["symbol", "day"])
    g = daily.groupby("symbol")
    daily["range"] = g["high"].shift(1) - g["low"].shift(1)
    daily["prev_close"] = g["close"].shift(1)
    dv = {c: daily.pivot(index="day", columns="symbol", values=c) for c in ("open", "high", "low", "range", "prev_close")}

    bars["day"] = pd.to_datetime(bars["day"])
    bars = bars[(bars["slot"] >= 0) & (bars["slot"] < BARS) & bars["day"].isin(keep)]
    days = sorted(set(bars["day"]) & set(dv["open"].index))
    syms = sorted(set(bars["symbol"]) & set(dv["open"].columns))
    di = {d: i for i, d in enumerate(days)}
    si = {s: i for i, s in enumerate(syms)}
    shape = (len(days), len(syms), BARS)
    bo, bh = np.full(shape, np.nan), np.full(shape, np.nan)
    bc = np.full(shape, np.nan)
    b = bars[bars["symbol"].isin(si)]
    r, c, k = b["day"].map(di).to_numpy(), b["symbol"].map(si).to_numpy(), b["slot"].to_numpy()
    bo[r, c, k], bh[r, c, k], bc[r, c, k] = b["open"].to_numpy(), b["high"].to_numpy(), b["close"].to_numpy()

    D = pd.DatetimeIndex(days)
    al = lambda x: x.reindex(index=D, columns=syms).to_numpy(dtype=float)
    d_open, d_high, d_low, rng, pc = map(al, (dv["open"], dv["high"], dv["low"], dv["range"], dv["prev_close"]))
    o915, x1515 = bo[:, :, 0], bc[:, :, BARS - 1]
    ok = (np.abs(o915 / d_open - 1) <= backtest.GAP_OPEN_TOLERANCE) & (np.abs(o915 / pc - 1) <= xsmr.MAX_MOVE)
    ok &= (rng > 0) & (rng / pc <= xsmr.MAX_MOVE)
    x_ok = (x1515 >= d_low * (1 - xsmr.RANGE_TOLERANCE)) & (x1515 <= d_high * (1 + xsmr.RANGE_TOLERANCE))
    x1515 = np.where(x_ok, x1515, np.nan)
    o_clean = np.where(np.abs(o915 / d_open - 1) <= backtest.GAP_OPEN_TOLERANCE, o915, np.nan)
    return {"days": D, "syms": syms, "o915": o_clean, "x1515": x1515, "bo": bo, "bh": bh, "rng": rng, "ok": ok}


def _signals(d, k):
    """Per day and symbol: the 15m slot of the first breakout (-1 if none) and the fill price."""
    level = d["o915"] + k * d["rng"]
    with np.errstate(invalid="ignore"):
        hit = d["bh"] >= level[:, :, None]
    any_hit = hit.any(axis=2) & d["ok"] & np.isfinite(level)
    slot = np.where(any_hit, hit.argmax(axis=2), -1)
    bar_open = np.take_along_axis(d["bo"], np.maximum(slot, 0)[:, :, None], axis=2)[:, :, 0]
    fill = np.where(any_hit, np.fmax(level, bar_open), np.nan)
    return slot, fill


def _simulate(d, variant):
    meta = VARIANTS[variant]
    slot, fill = _signals(d, meta["k"])
    days, o, x = d["days"], d["o915"], d["x1515"]
    n, cap = len(days), meta["max_open"]
    w = 1.0 / cap
    gross, turn, held = np.zeros(n), np.zeros(n), np.zeros(n, dtype=int)
    open_trades, trades = [], []
    for i in range(n):
        still = []
        for tr in open_trades:  # swing trades: sold at this open if it shows a profit, or on the last day
            s = tr["s"]
            gap_days = (days[i] - days[tr["buy_i"]]).days
            age = i - tr["buy_i"]
            if gap_days > 12 or np.isnan(o[i, s]):
                if age >= SWING_DAYS or gap_days > 12:  # no usable open: out at the last mark
                    tr.update(sell_i=i - 1, sell=tr["last"], reason="no open")
                    turn[i - 1] += w * tr["sell"] / tr["buy"]
                    trades.append(tr)
                else:
                    still.append(tr)
                continue
            if o[i, s] > tr["buy"] or age >= SWING_DAYS:
                gross[i] += w * (o[i, s] / tr["last"] - 1)
                turn[i] += w * o[i, s] / tr["buy"]
                tr.update(sell_i=i, sell=float(o[i, s]), reason="profitable open" if o[i, s] > tr["buy"] else f"day {SWING_DAYS} open")
                trades.append(tr)
            else:
                still.append(tr)
        open_trades = still
        held_syms = {tr["s"] for tr in open_trades}
        free = cap - len(open_trades)
        cand = [s for s in np.flatnonzero(slot[i] >= 0) if s not in held_syms]
        cand.sort(key=lambda s: (slot[i, s], s))
        for s in cand[:max(free, 0)]:
            tr = {"s": int(s), "buy_i": i, "slot": int(slot[i, s]), "buy": float(fill[i, s]), "last": float(fill[i, s]), "w": w}
            turn[i] += w
            open_trades.append(tr)
        still = []
        for tr in open_trades:  # mark at 15:15; intraday trades are sold there
            s = tr["s"]
            if not np.isnan(x[i, s]):
                gross[i] += w * (x[i, s] / tr["last"] - 1)
                tr["last"] = float(x[i, s])
            held[i] += 1
            if meta["exit"] == "intraday" and tr["buy_i"] == i:
                turn[i] += w * tr["last"] / tr["buy"]
                tr.update(sell_i=i, sell=tr["last"], reason="15:15")
                trades.append(tr)
            else:
                still.append(tr)
        open_trades = still
    trades += [dict(tr, sell_i=None, sell=None, reason="open") for tr in open_trades]
    f = pd.DataFrame({"day": [t.date() for t in days], "gross_ret": gross, "turnover": turn, "long_ret": gross,
                      "short_ret": 0.0, "stocks": held})
    return f[f["turnover"].cumsum() > 0].reset_index(drop=True), trades


CACHE_SECONDS = 3600
_cache, _lock = {}, threading.Lock()


def _cached(key, build):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = build()
    with _lock:
        _cache[key] = (time.time(), value)
        books = sorted((t, k) for k, (t, _) in _cache.items() if k[0] == "book")
        for _, k in books[: max(0, len(books) - 60)]:
            _cache.pop(k, None)
    return value


def _run(variant, dataset):
    parse_variant(variant)
    d = _cached(("data", dataset), lambda: _load(dataset))
    f, trades = _cached(("book", dataset, variant), lambda: _simulate(d, variant))
    return f.copy(), trades, d


def _frame(variant, dataset, slippage):
    f, _, _ = _run(variant, dataset)
    return xsmr.with_costs(f, slippage)


def _lots(d):
    sizes = stored_lot_sizes()
    return [sizes.get(("NSE", INDEX_LOTS.get(s, s))) for s in d["syms"]]


def results(variant, dataset, slippage=0.0002, lots=False):
    """The page: the daily book, with the cards and month grid counting closed trades (each trade's
    share of the book: weight x (return - costs on the buy and the sale))."""
    f, trades, d = _run(variant, dataset)
    out = xsmr.results_from(xsmr.with_costs(f, slippage), slippage)
    closed = [t for t in trades if t["sell"] is not None]
    if not out["summary"] or not closed:
        return out
    days = d["days"]
    t = pd.DataFrame({"sell_day": [days[x["sell_i"]] for x in closed], "w": [x["w"] for x in closed],
                      "buy": [x["buy"] for x in closed], "sell": [x["sell"] for x in closed],
                      "held": [x["sell_i"] - x["buy_i"] for x in closed], "reason": [x["reason"] for x in closed]})
    cost = xsmr.cost_per_side(slippage)
    t["ret"] = t["sell"] / t["buy"] - 1
    t["gross"], t["cost"] = t["w"] * t["ret"], t["w"] * (1 + t["sell"] / t["buy"]) * cost
    t["net"] = t["gross"] - t["cost"]
    wins, losses = t.loc[t["net"] > 0, "net"].sum(), -t.loc[t["net"] < 0, "net"].sum()
    out["summary"].update({
        "trades": int(len(t)), "win_rate": round(float(100 * (t["net"] > 0).mean()), 1),
        "win_rate_gross": round(float(100 * (t["gross"] > 0).mean()), 1),
        "avg_cost_pct": round(float(100 * t["cost"].mean()), 4), "avg_net_pct": round(float(100 * t["net"].mean()), 4),
        "profit_factor": round(float(wins / losses), 2) if losses > 0 else None,
        "avg_trade_pct": round(float(100 * t["ret"].mean()), 3),
        "avg_trade_net_pct": round(float(100 * (t["ret"] - (1 + t["sell"] / t["buy"]) * cost).mean()), 3),
        "avg_held_days": round(float(t["held"].mean()), 2),
        "forced_pct": round(float(100 * (t["reason"] != "profitable open").mean()), 1),
    })
    for key, fmt in (("years", "%Y"), ("months", "%Y-%m")):
        g = t.groupby(t["sell_day"].dt.strftime(fmt))["net"]
        counts, rate = g.size(), g.apply(lambda v: (v > 0).mean())
        label = "year" if key == "years" else "month"
        for row in out[key]:
            k = str(row[label])
            row["trades"] = int(counts.get(k, 0))
            row["win_rate"] = round(float(100 * rate[k]), 1) if k in rate.index else None
    return out


def compare(dataset, slippage=0.0002, take="all", lots=False, variant=None):
    """Both k values and both exits, at the max open of `variant`."""
    m = VARIANTS[variant]["max_open"] if variant else DEFAULT_OPEN[dataset]
    rows = []
    for base, meta in VARIANTS.items():
        if meta["max_open"] != m:
            continue
        f = _frame(base, dataset, slippage)
        if not f.empty:
            rows.append({"variant": base, "label": meta["label"], "book": base in BOOK, **xsmr._stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, lots=False):
    return xsmr.month_days_from(_frame(variant, dataset, slippage), month)


def day_trades(variant, dataset, day):
    """Every position held on one day, one row per trade: buy time and price, the breakout level's k,
    when and why it was sold, the whole trade's result, and the day's move and share of the book."""
    ts = pd.Timestamp(day)
    _, trades, d = _run(variant, dataset)
    days = d["days"]
    if ts not in days:
        return []
    i = days.get_loc(ts)
    lots = _lots(d)
    rows = []
    for tr in trades:
        last_i = tr["sell_i"] if tr["sell_i"] is not None else len(days) - 1
        if not (tr["buy_i"] <= i <= last_i):
            continue
        s = tr["s"]
        sold = tr["sell"] is not None
        mins = 555 + 15 * tr["slot"]
        size = lots[s]
        rows.append({"symbol": d["syms"][s], "side": "long", "weight_pct": round(100 * tr["w"], 3),
                     "bought": days[tr["buy_i"]].date().isoformat(), "buy_time": f"{mins // 60:02d}:{mins % 60:02d}",
                     "buy": round(tr["buy"], 2),
                     "sold": days[tr["sell_i"]].date().isoformat() if sold else None,
                     "sell": round(tr["sell"], 2) if sold else None, "reason": tr["reason"],
                     "trade_pct": round(100 * (tr["sell"] / tr["buy"] - 1), 2) if sold else None,
                     "day_of_hold": i - tr["buy_i"], "lot_size": int(size) if size else None,
                     "trade_rs": round(size * (tr["sell"] - tr["buy"])) if sold and size else None})
    return sorted(rows, key=lambda r: (r["bought"], r["buy_time"], r["symbol"]))
