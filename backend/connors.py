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

Computed on request (see _run), not stored. Costs: NSE futures charges + slippage on every rupee
traded (xsmr.cost_per_side), including the futures roll: a trade held through a month end (standing
in for expiry) is sold and bought again in next month's contract. Data hygiene: 200 straight closes and no move over 20% in the window to qualify;
a day's move over 20% earns nothing. Survivorship bias: today's F&O list is used for every year,
which flatters every long position. The "every" setup is the control: with take "all" it buys
every stock above its 200-day average (the baseline); with "top5"/"top3" it buys the day's 5 / 3
lowest 2-day RSIs without the below-10 threshold, which shows what the threshold adds.
"""

from datetime import timedelta

import numpy as np
import pandas as pd
import threading
import time

import xsmom
import xsmr
from db import connect

MODEL = "connors"
DATASETS = ("fno", "stocks", "fnopit", "cash500")  # fnopit: survivorship-free F&O (pit.py); cash500: top 500 in cash (cash500.py); both at the close only
SMA_DAYS, RSI_MAX, LOW_DAYS, DOWN_DAYS = 200, 10.0, 10, 3
MIN_HISTORY = 0.9  # share of the last 200 closes a stock needs, not counting days most stocks are missing
MIN_STOCKS = xsmr.MIN_STOCKS
MAX_MOVE = xsmr.MAX_MOVE
SETUPS = {"rsi2": "2-day RSI below 10 (book)", "low10": "New 10-day low", "down3": "3 down days",
          "every": "Any stock above the 200-day average (no RSI threshold)",
          "cumrsi2": "Cumulative RSI(2): today's + yesterday's below 35 (Connors & Alvarez)"}
# hold 0 = exit on strength: out at the first close the 2-day RSI is above EXIT_RSI (below 100 - it for
# a short), STRENGTH_MAX_DAYS at most
HOLDS = {5: "hold 5 days (book)", 2: "hold 2 days", 0: "out when RSI(2) > 65"}
CUM_RSI_MAX, EXIT_RSI, STRENGTH_MAX_DAYS = 35.0, 65.0, 5  # 5 days at most: the book's hold, a fixed rule
# "-max<N>": at most N trades open at once (for a margin budget: each futures lot ties up its own
# margin). Each trade gets 1/N of capital (one lot in one-lot mode). A new trade starts only when a
# slot is free: the most oversold qualifying stocks not already held, from that 15:15 on (a slot
# freed by a sale at 15:15 can be refilled at the same 15:15). The take doesn't apply. Without it
# (the book) every day's picks share a fifth of capital and a stock picked again while held is
# bought again (another slice; another lot in one-lot mode).
MAX_OPEN = tuple(range(1, 11))
# Stop (not in the book; Connors argues stops hurt mean reversion): "-1sd" / "-2sd" puts it 1 / 2
# standard deviations of the stock's last 90 daily returns below the buy price (1σ is Buy on gap's
# stop); "-3pc" / "-5pc" / "-7pc" / "-10pc" a fixed % below the buy price. Checked on the daily low for
# the days in between (out at the open if the stock gaps through it) and on the 15m lows up to 15:15
# on the sell day; out at the stop price.
STOPS = {"": None, "-1sd": ("sd", 1.0), "-2sd": ("sd", 2.0),
         "-3pc": ("pct", 0.03), "-5pc": ("pct", 0.05), "-7pc": ("pct", 0.07), "-10pc": ("pct", 0.10)}


def _stop_label(k):
    return "" if not k else f" · {k[1]:g}σ stop" if k[0] == "sd" else f" · {100 * k[1]:g}% stop"
# Prices: "" = the live 15:15 version (15m candles, from 2015); "-close" = official closes for the
# signal, the buy and the sale (daily candles, from 2004). The close is a 30-minute average on NSE,
# so it can't be traded exactly; it's the long-history check, and the two can be compared from 2015.
TIMINGS = {"": "15:15", "-close": "close"}
# Side: "" = long (the book); "-short" = the mirror image: below the 200-day average, short-term
# overbought (2-day RSI above 90, a new 10-day high, 3 up days), sold short and bought back `hold`
# days later (a stop above the entry); "-both" = either, ranked together by how extreme they are.
SIDES = {"": "long", "-short": "short", "-both": "both"}
VARIANTS = {f"{s}-{h}d{f'-max{m}' if m else ''}{st}{tm}{sd}": {
                "label": f"{SETUPS[s]} · {HOLDS[h]}{f' · max {m} open' if m else ''}{_stop_label(k)}"
                         f"{' · at the close' if tm else ''}{f' · {SIDES[sd]}' if sd else ''}",
                "setup": s, "hold": h, "max_open": m, "stop": k, "timing": TIMINGS[tm], "side": SIDES[sd]}
            for s in SETUPS for h in HOLDS for m in (None, *MAX_OPEN) for st, k in STOPS.items() for tm in TIMINGS
            for sd in SIDES}
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


def _data(dataset, start=None, end=None, timing="15:15", closes=None):
    """Prices and setups. 15:15: computed live at 15:15 (closes to yesterday + today's 15:15 price),
    traded at 15:15. close: computed from and traded at the official closes (or `closes`, for the
    live signal: yesterday's closes plus today's prices)."""
    c = xsmom._closes(dataset) if closes is None else closes
    c = c[c.index.dayofweek < 5]  # weekend special sessions (Muhurat: an evening hour) aren't trading days here
    if start is not None:
        c = c[c.index >= pd.Timestamp(start) - timedelta(days=500)]
    if end is not None:
        c = c[c.index <= pd.Timestamp(end)]
    if timing == "close":
        p = None
        px = c[c.index >= pd.Timestamp(start)] if start is not None else c
    else:
        p = xsmr._prices(dataset, start, end)
        px = p["px1515"]
        # Sparse special sessions (Muhurat trading: an hour in the evening, no 15:15 price) aren't days.
        count = px.notna().sum(axis=1)
        px = px[count >= 0.8 * count.rolling(21, center=True, min_periods=1).median()]
    r = c / c.shift(1) - 1
    # Kite's daily history has holes (24 May - 22 Jun 2004: most stocks missing), so a stock needs 90%
    # of the last 200 closes, not all of them, and the split check looks across a hole.
    cf = c.ffill()
    jump = (cf / cf.shift(1) - 1).abs() > MAX_MOVE
    bad = (r.abs() > MAX_MOVE) | (jump & c.notna())
    priced = c.notna().sum(axis=1)
    hole = priced < 0.5 * priced.rolling(121, center=True, min_periods=20).median()  # days most stocks are missing
    need = MIN_HISTORY * (SMA_DAYS - hole.rolling(SMA_DAYS, min_periods=1).sum())
    ok = c.rolling(SMA_DAYS).count().ge(need, axis=0) & ~bad.rolling(SMA_DAYS).max().fillna(1).astype(bool)
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
    sma = (y(c.rolling(SMA_DAYS - 1, min_periods=1).sum()) + px) / (y(c.rolling(SMA_DAYS - 1, min_periods=1).count()) + 1)
    up = 0.5 * y(au) + 0.5 * (px - prev).clip(lower=0)
    dn = 0.5 * y(ad) + 0.5 * (prev - px).clip(lower=0)
    rsi = 100 - 100 / (1 + up / dn)
    cum = rsi + rsi.shift(1)
    setups = {"rsi2": rsi < RSI_MAX, "low10": px <= y(c.rolling(LOW_DAYS - 1).min()),
              "down3": (move < 0) & (y(r) < 0) & (y(r.shift(1)) < 0),
              "every": pd.DataFrame(True, index=idx, columns=cols), "cumrsi2": cum < CUM_RSI_MAX}
    eligible = qualified & (px > sma)
    eligible_short = qualified & (px < sma)
    import pit
    src = pit.source(dataset)
    if src:  # survivorship-free: only what was in the list at the previous month-end can be bought
        member = src.member_mask(idx, cols)
        if hasattr(src, "tradable_mask"):  # no buy at the close of a day locked at a circuit
            member = member & src.tradable_mask(idx, cols)
        eligible, eligible_short = eligible & member, eligible_short & member
    setups_short = {"rsi2": rsi > 100 - RSI_MAX, "low10": px >= y(c.rolling(LOW_DAYS - 1).max()),
                    "down3": (move > 0) & (y(r) > 0) & (y(r.shift(1)) > 0),
                    "every": pd.DataFrame(True, index=idx, columns=cols), "cumrsi2": cum > 200 - CUM_RSI_MAX}
    # Daily 15:15 -> 15:15 returns for holding; a missing 15:15 price carries the last one (up to 3 days).
    pxf = px.ffill(limit=3)
    ret = pxf / pxf.shift(1) - 1
    ret = ret.where(ret.abs() <= MAX_MOVE, 0.0).fillna(0.0)
    if src:
        f = src.frame()
        f = f[(f["day"] >= idx[0]) & (f["day"] <= idx[-1])]
    else:
        with connect() as conn:
            f = pd.read_sql("SELECT symbol, day, open, high, low FROM bt_daily WHERE close > 0 AND symbol IN "
                            "(SELECT symbol FROM bt_symbols WHERE dataset = %s) AND day >= %s AND day <= %s",
                            conn, params=[dataset, idx[0].date(), idx[-1].date()])
        f["day"] = pd.to_datetime(f["day"])
    day_open = f.pivot(index="day", columns="symbol", values="open").reindex(index=idx, columns=cols)
    day_low = f.pivot(index="day", columns="symbol", values="low").reindex(index=idx, columns=cols)
    day_high = f.pivot(index="day", columns="symbol", values="high").reindex(index=idx, columns=cols)
    day_open = day_open.where((day_open >= day_low * 0.995) & (day_open <= day_high * 1.005))  # bad early prints
    if timing == "close":  # the stop on the sell day uses the whole day's low / high; σ from the daily closes
        low_exit, high_exit = day_low, day_high
        sigma = r.rolling(90).std().shift(1).reindex(index=idx, columns=cols)
    else:
        low_exit = p["low1515"].reindex(index=idx, columns=cols)
        high_exit = p["high1515"].reindex(index=idx, columns=cols)
        sigma = p["sigma"].reindex(index=idx, columns=cols)
    return {"px": pxf, "rsi": rsi, "cumrsi": cum, "eligible": eligible, "setups": setups, "r": ret,
            "eligible_short": eligible_short, "setups_short": setups_short,
            "rankable": qualified.sum(axis=1), "open": day_open, "low": day_low, "high": day_high,
            "low1515": low_exit, "high1515": high_exit, "sigma": sigma}


def live_signals(prices, today, dataset="fno"):
    """Today's setup, live: the backtest's own signal code on official closes to yesterday plus
    `prices` ({symbol: price now}) as today's close. Returns how many stocks qualified for the trend
    filter; every stock above its 200-day average with its 2-day RSI, the cumulative (today's +
    yesterday's) and whether each setup signals (RSI below 10; cumulative below 35); and every priced
    stock's 2-day RSI now (rsi_all: the exit on strength of a held stock)."""
    ts = pd.Timestamp(today)
    c = xsmom._closes(dataset)
    c = c[c.index < ts].iloc[-450:].copy()
    c.loc[ts] = pd.Series(prices, dtype=float).reindex(c.columns)
    d = _data(dataset, timing="close", closes=c)
    if d["px"].index[-1] != ts:
        return {"rankable": 0, "stocks": [], "rsi_all": {}}
    rsi, cum, eligible = d["rsi"].loc[ts], d["cumrsi"].loc[ts], d["eligible"].loc[ts]
    stocks = [{"symbol": s_, "rsi": round(float(rsi[s_]), 2), "signal": bool(rsi[s_] < RSI_MAX),
               "cum": round(float(cum[s_]), 2) if pd.notna(cum[s_]) else None,
               "signal_cum": bool(pd.notna(cum[s_]) and cum[s_] < CUM_RSI_MAX)}
              for s_ in eligible.index[eligible.to_numpy()] if pd.notna(rsi[s_])]
    return {"rankable": int(d["rankable"][ts]), "last_close": c.index[-2].date().isoformat(),
            "stocks": sorted(stocks, key=lambda x: x["rsi"]),
            "rsi_all": {s_: float(v) for s_, v in rsi.items() if pd.notna(v)}}


def _simulate(d, variant, lot=None):
    """Trade by trade. Each day at 15:15: the day's picks (setup, above the 200-day average, the
    take's lowest RSIs, skipping stocks still held under "1 open per stock") share 1/hold of capital
    and are bought at the 15:15 price; each is sold at the 15:15 price `hold` days later, or at the
    stop. Returns daily rows (% of capital), one-lot rows (rupees: one lot per trade, today's lot
    sizes) and the trades."""
    base, take = parse_variant(variant)
    meta = VARIANTS[base]
    hold, top, k, cap = meta["hold"], TAKES[take], meta["stop"], meta["max_open"]
    strength = hold == 0  # exit on strength, STRENGTH_MAX_DAYS at most
    horizon = STRENGTH_MAX_DAYS if strength else hold
    idx, cols = d["px"].index, d["px"].columns
    side = meta.get("side", "long")
    enough = (d["rankable"] >= MIN_STOCKS).to_numpy()[:, None]
    hit = ((d["setups"][meta["setup"]] & d["eligible"]).fillna(False) & enough).to_numpy()
    hit_short = ((d["setups_short"][meta["setup"]] & d["eligible_short"]).fillna(False) & enough).to_numpy()
    if side == "short":
        hit = np.zeros_like(hit)
    if side == "long":
        hit_short = np.zeros_like(hit_short)
    px, rsi = d["px"].to_numpy(), d["rsi"].to_numpy()
    score = d["cumrsi"].to_numpy() / 2 if meta["setup"] == "cumrsi2" else rsi  # ranking: the most extreme first
    op, lo, lo15, sd = (d[x].to_numpy() for x in ("open", "low", "low1515", "sigma"))
    hi, hi15 = d["high"].to_numpy(), d["high1515"].to_numpy()
    lots = (lot.reindex(cols).to_numpy() if lot is not None else np.full(len(cols), np.nan))
    n = len(idx)
    gross, turn, held = np.zeros(n), np.zeros(n), np.zeros(n, dtype=int)
    long_r, short_r = np.zeros(n), np.zeros(n)
    g_rs, t_rs, not_rs, held_lots = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n, dtype=int)
    open_trades, trades = [], []
    month_end = xsmr.month_ends(idx).to_numpy()
    for i in range(n):
        still = []
        for tr in open_trades:  # each open trade's move from yesterday's 15:15 to today's
            s_ = tr["s"]
            prev = tr["last"]
            last_day = i == tr["sell_i"]
            if strength and not last_day and i > tr["buy_i"] and pd.notna(rsi[i, s_]):
                if (tr["sign"] > 0 and rsi[i, s_] > EXIT_RSI) or (tr["sign"] < 0 and rsi[i, s_] < 100 - EXIT_RSI):
                    last_day, tr["sell_i"], tr["strong"] = True, i, True
            price = px[i, s_]
            exit_px = reason = None
            if tr["stop"] is not None:
                o = op[i, s_]
                if tr["sign"] > 0:
                    low = lo15[i, s_] if last_day else lo[i, s_]
                    if pd.notna(o) and o <= tr["stop"] and not last_day:
                        exit_px, reason = float(o), "stop (gap)"
                    elif pd.notna(low) and low <= tr["stop"]:
                        exit_px, reason = tr["stop"], "stop"
                else:  # a short: the stop is above the entry
                    high = hi15[i, s_] if last_day else hi[i, s_]
                    if pd.notna(o) and o >= tr["stop"] and not last_day:
                        exit_px, reason = float(o), "stop (gap)"
                    elif pd.notna(high) and high >= tr["stop"]:
                        exit_px, reason = tr["stop"], "stop"
            if exit_px is None and last_day:
                exit_px, reason = (float(price) if pd.notna(price) else prev), "strength" if tr.get("strong") else "time"
            now = exit_px if exit_px is not None else (float(price) if pd.notna(price) else prev)
            ret = now / prev - 1
            if abs(ret) > MAX_MOVE:  # a split or bad print: earns nothing
                ret, now = 0.0, prev
            held[i] += 1
            gross[i] += tr["w"] * tr["sign"] * ret
            (long_r if tr["sign"] > 0 else short_r)[i] += tr["w"] * tr["sign"] * ret
            if tr["lot"]:
                held_lots[i] += 1
                g_rs[i] += tr["sign"] * tr["lot"] * (now - prev)
                not_rs[i] += tr["lot"] * prev
            tr["last"] = now
            if exit_px is not None:
                turn[i] += tr["w"] * now / tr["buy"]
                if tr["lot"]:
                    t_rs[i] += tr["lot"] * now
                tr.update(sell_i=i, sell=now, reason=reason)
                trades.append(tr)
            else:
                still.append(tr)
        open_trades = still
        if month_end[i]:  # futures roll: trades held through the month end are sold and bought again
            for tr in open_trades:
                turn[i] += 2 * tr["w"] * tr["last"] / tr["buy"]
                tr["roll"] = tr.get("roll", 0.0) + 2 * tr["last"] / tr["buy"]
                if tr["lot"]:
                    t_rs[i] += 2 * tr["lot"] * tr["last"]
        # candidates: (stock, +1 long / -1 short), ranked by how extreme the RSI is (the most
        # oversold longs and the most overbought shorts first)
        cand = [(c, 1) for c in np.flatnonzero(hit[i])] + [(c, -1) for c in np.flatnonzero(hit_short[i])]
        if cap:  # free slots only, stocks not already held
            held_now = {tr["s"] for tr in open_trades}
            cand = [x for x in cand if x[0] not in held_now]
            top = cap - len(open_trades)
        extreme = lambda x: score[i, x[0]] if x[1] > 0 else 100 - score[i, x[0]]
        if top is not None and len(cand) > top:
            cand = sorted(cand, key=extreme)[:max(top, 0)]
        if len(cand):
            w = 1.0 / cap if cap else 1.0 / (horizon * len(cand))
            for s_, sign in cand:
                buy = float(px[i, s_])
                if not k:
                    stop = None
                elif k[0] == "pct":
                    stop = buy * (1 - sign * k[1])
                else:
                    stop = buy * (1 - sign * k[1] * sd[i, s_]) if pd.notna(sd[i, s_]) else None
                size = float(lots[s_]) if pd.notna(lots[s_]) else 0.0
                tr = {"s": s_, "buy_i": i, "sell_i": min(i + horizon, n - 1) if i + horizon < n else None, "buy": buy,
                      "last": buy, "w": w, "stop": stop, "lot": size, "rsi": float(rsi[i, s_]), "sign": sign}
                if tr["sell_i"] is None:
                    tr["sell_i"] = n + 10**6  # past the data: still open
                turn[i] += w
                t_rs[i] += size * buy
                open_trades.append(tr)
    trades += [dict(tr, sell=None, reason="open") for tr in open_trades]
    rows = [(idx[i].date(), float(gross[i]), float(turn[i]), float(long_r[i]), float(short_r[i]), int(held[i])) for i in range(n)]
    lot_rows = [(idx[i].date(), float(g_rs[i]), float(t_rs[i]), float(g_rs[i]), 0.0, float(not_rs[i]), int(held_lots[i]))
                for i in range(n)]
    return rows, lot_rows, trades


# Computed on request, not stored: with every setting (setups x holds x max open 1-10 x stops x
# prices x takes) there are ~600 books, too many to keep in the shared database. The prices and
# setups are loaded once per dataset and timing and kept for CACHE_SECONDS; one book takes ~0.2 s.
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
        if len(_cache) > 80:  # drop the oldest books, keep the data
            books = sorted((t, k) for k, (t, _) in _cache.items() if k[0] == "book")
            for _, k in books[: len(_cache) - 80]:
                _cache.pop(k, None)
    return value


def _dataset(dataset, timing):
    return _cached(("data", dataset, timing), lambda: _data(dataset, timing=timing))


def _run(variant, dataset):
    """(daily frame with costs left to the caller, closed and open trades, data) for one book."""
    meta = VARIANTS[parse_variant(variant)[0]]
    d = _dataset(dataset, meta["timing"])

    def build():
        rows, _, trades = _simulate(d, variant)
        f = pd.DataFrame(rows, columns=["day", "gross_ret", "turnover", "long_ret", "short_ret", "stocks"])
        f = f[f["turnover"].cumsum() > 0].reset_index(drop=True)
        return f, trades
    f, trades = _cached(("book", dataset, variant), build)
    return f.copy(), trades, d


def _frame(variant, dataset, slippage):
    f, _, _ = _run(variant, dataset)
    return xsmr.with_costs(f, slippage)


def results(variant, dataset, slippage=0.0002, lots=False):
    """The page, with the per-trade cards and the month grid's trades / win rate from the closed trades.
    A trade's result is its share of the book: weight x (return - costs on the buy and the sale)."""
    f, trades, d = _run(variant, dataset)
    out = xsmr.results_from(xsmr.with_costs(f, slippage), slippage)
    closed = [t for t in trades if t["sell"] is not None]
    if not out["summary"] or not closed:
        return out
    idx = d["px"].index
    t = pd.DataFrame({"sell_day": [idx[x["sell_i"]] for x in closed], "w": [x["w"] for x in closed],
                      "buy": [x["buy"] for x in closed], "sell": [x["sell"] for x in closed],
                      "reason": [x["reason"] for x in closed], "roll": [x.get("roll", 0.0) for x in closed],
                      "sign": [x.get("sign", 1) for x in closed]})
    cost = xsmr.cost_per_side(slippage)
    t["gross"] = t["w"] * t["sign"] * (t["sell"] / t["buy"] - 1)
    t["cost"] = t["w"] * (1 + t["sell"] / t["buy"] + t["roll"]) * cost  # buy, sale and any futures roll
    t["net"] = t["gross"] - t["cost"]
    wins, losses = t.loc[t["net"] > 0, "net"].sum(), -t.loc[t["net"] < 0, "net"].sum()
    out["summary"].update({
        "trades": int(len(t)), "win_rate": round(float(100 * (t["net"] > 0).mean()), 1),
        "win_rate_gross": round(float(100 * (t["gross"] > 0).mean()), 1),
        "avg_cost_pct": round(float(100 * t["cost"].mean()), 4), "avg_net_pct": round(float(100 * t["net"].mean()), 4),
        "profit_factor": round(float(wins / losses), 2) if losses > 0 else None,
        "stopped_pct": round(float(100 * t["reason"].str.startswith("stop").mean()), 1),
        "avg_trade_pct": round(float(100 * (t["sign"] * (t["sell"] / t["buy"] - 1)).mean()), 3),
    })
    for key, fmt in (("years", "%Y"), ("months", "%Y-%m")):
        g = t.groupby(t["sell_day"].dt.strftime(fmt))["net"]
        counts, rate = g.size(), g.apply(lambda x: (x > 0).mean())
        label = "year" if key == "years" else "month"
        for row in out[key]:
            k = str(row[label])
            row["trades"] = int(counts.get(k, 0))
            row["win_rate"] = round(float(100 * rate[k]), 1) if k in rate.index else None
    return out


def compare(dataset, slippage=0.0002, take="all", lots=False, variant=None):
    """Every setup and hold, with the max open, stop and prices of `variant` (the page's selection)."""
    rows = []
    want = VARIANTS[parse_variant(variant)[0]] if variant else VARIANTS[BOOK[0]]
    if want["max_open"]:
        take = "all"  # a fixed number of slots: the take doesn't apply
    for base, meta in VARIANTS.items():
        if any(meta[k] != want[k] for k in ("max_open", "stop", "timing", "side")):
            continue
        f = _frame(variant_id(base, take), dataset, slippage)
        if not f.empty:
            rows.append({"variant": variant_id(base, take), "label": meta["label"], "book": base in BOOK, **xsmr._stats(f)})
    return rows


def month_days(variant, dataset, month, slippage=0.0002, lots=False):
    return xsmr.month_days_from(_frame(variant, dataset, slippage), month)


def day_trades(variant, dataset, day):
    """Every position held into one day's close (15:15 or the official close), one row per purchase:
    when it was bought, at what 2-day RSI and price, when and how it was sold (time or stop), the
    whole trade's result, and the day's move and its share of the book."""
    ts = pd.Timestamp(day)
    _, trades, d = _run(variant, dataset)
    idx = d["px"].index
    if ts not in idx:
        return []
    i = idx.get_loc(ts)
    hold = VARIANTS[parse_variant(variant)[0]]["hold"]
    cols = d["px"].columns
    lot = xsmr.lot_series(cols)
    rows = []
    for tr in trades:
        if not (tr["buy_i"] < i <= min(tr["sell_i"], len(idx) - 1)) or tr["buy_i"] < i - (hold or STRENGTH_MAX_DAYS):
            continue
        s_ = tr["s"]
        symbol = cols[s_]
        prev = d["px"].iat[i - 1, s_]
        today = tr["sell"] if tr["sell_i"] == i else d["px"].iat[i, s_]
        move = float(today / prev - 1) if pd.notna(prev) and pd.notna(today) else 0.0
        sold = tr["sell"] is not None
        size = lot.get(symbol)
        rows.append({"symbol": symbol, "side": "long" if tr.get("sign", 1) > 0 else "short", "weight_pct": round(100 * tr["w"], 3),
                     "signal_pct": round(tr["rsi"], 1), "bought": idx[tr["buy_i"]].date().isoformat(),
                     "buy": round(tr["buy"], 2),
                     "stop": round(tr["stop"], 2) if tr["stop"] is not None else None,
                     "sold": idx[tr["sell_i"]].date().isoformat() if sold else None,
                     "sell": round(tr["sell"], 2) if sold else None, "reason": tr["reason"],
                     "trade_pct": round(100 * tr.get("sign", 1) * (tr["sell"] / tr["buy"] - 1), 2) if sold else None,
                     "day_of_hold": i - tr["buy_i"], "hold": hold,
                     "move_pct": round(100 * move, 2), "contribution_bps": round(10000 * tr["w"] * tr.get("sign", 1) * move, 2),
                     "lot_size": int(size) if pd.notna(size) else None,
                     "trade_rs": round(tr.get("sign", 1) * size * (tr["sell"] - tr["buy"])) if sold and pd.notna(size) else None})
    return sorted(rows, key=lambda x: (x["bought"], x["symbol"]))
