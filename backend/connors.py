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

Computed on request (see _run), not stored. Costs: NSE futures charges + slippage on every rupee traded (xsmr.cost_per_side); the futures roll
is not charged. Data hygiene: 200 straight closes and no move over 20% in the window to qualify;
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
DATASETS = ("fno", "stocks")
SMA_DAYS, RSI_MAX, LOW_DAYS, DOWN_DAYS = 200, 10.0, 10, 3
MIN_STOCKS = xsmr.MIN_STOCKS
MAX_MOVE = xsmr.MAX_MOVE
SETUPS = {"rsi2": "2-day RSI below 10 (book)", "low10": "New 10-day low", "down3": "3 down days",
          "every": "Any stock above the 200-day average (no RSI threshold)"}
HOLDS = {5: "hold 5 days (book)", 2: "hold 2 days"}
# "-max<N>": at most N trades open at once (for a margin budget: each futures lot ties up its own
# margin). Each trade gets 1/N of capital (one lot in one-lot mode). A new trade starts only when a
# slot is free: the most oversold qualifying stocks not already held, from that 15:15 on (a slot
# freed by a sale at 15:15 can be refilled at the same 15:15). The take doesn't apply. Without it
# (the book) every day's picks share a fifth of capital and a stock picked again while held is
# bought again (another slice; another lot in one-lot mode).
MAX_OPEN = tuple(range(1, 11))
# Stop (not in the book; Connors argues stops hurt mean reversion): "-1sd" / "-2sd" puts it 1 / 2
# standard deviations of the stock's last 90 daily returns below the buy price (1σ is Buy on gap's
# stop). Checked on the daily low for the days in between (out at the open if the stock gaps
# through it) and on the 15m lows up to 15:15 on the sell day; out at the stop price.
STOPS = {"": None, "-1sd": 1.0, "-2sd": 2.0}
# Prices: "" = the live 15:15 version (15m candles, from 2015); "-close" = official closes for the
# signal, the buy and the sale (daily candles, from 2004). The close is a 30-minute average on NSE,
# so it can't be traded exactly; it's the long-history check, and the two can be compared from 2015.
TIMINGS = {"": "15:15", "-close": "close"}
VARIANTS = {f"{s}-{h}d{f'-max{m}' if m else ''}{st}{tm}": {
                "label": f"{SETUPS[s]} · {HOLDS[h]}{f' · max {m} open' if m else ''}{f' · {k:g}σ stop' if k else ''}"
                         f"{' · at the close' if tm else ''}",
                "setup": s, "hold": h, "max_open": m, "stop": k, "timing": TIMINGS[tm]}
            for s in SETUPS for h in HOLDS for m in (None, *MAX_OPEN) for st, k in STOPS.items() for tm in TIMINGS}
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


def _data(dataset, start=None, end=None, timing="15:15"):
    """Prices and setups. 15:15: computed live at 15:15 (closes to yesterday + today's 15:15 price),
    traded at 15:15. close: computed from and traded at the official closes."""
    c = xsmom._closes(dataset)
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
    with connect() as conn:
        f = pd.read_sql("SELECT symbol, day, open, high, low FROM bt_daily WHERE close > 0 AND symbol IN "
                        "(SELECT symbol FROM bt_symbols WHERE dataset = %s) AND day >= %s AND day <= %s",
                        conn, params=[dataset, idx[0].date(), idx[-1].date()])
    f["day"] = pd.to_datetime(f["day"])
    day_open = f.pivot(index="day", columns="symbol", values="open").reindex(index=idx, columns=cols)
    day_low = f.pivot(index="day", columns="symbol", values="low").reindex(index=idx, columns=cols)
    day_high = f.pivot(index="day", columns="symbol", values="high").reindex(index=idx, columns=cols)
    day_open = day_open.where((day_open >= day_low * 0.995) & (day_open <= day_high * 1.005))  # bad early prints
    if timing == "close":  # the stop on the sell day uses the whole day's low; σ from the daily closes
        low_exit = day_low
        sigma = r.rolling(90).std().shift(1).reindex(index=idx, columns=cols)
    else:
        low_exit = p["low1515"].reindex(index=idx, columns=cols)
        sigma = p["sigma"].reindex(index=idx, columns=cols)
    return {"px": pxf, "rsi": rsi, "eligible": eligible, "setups": setups, "r": ret,
            "rankable": qualified.sum(axis=1), "open": day_open, "low": day_low,
            "low1515": low_exit, "sigma": sigma}


def _simulate(d, variant, lot=None):
    """Trade by trade. Each day at 15:15: the day's picks (setup, above the 200-day average, the
    take's lowest RSIs, skipping stocks still held under "1 open per stock") share 1/hold of capital
    and are bought at the 15:15 price; each is sold at the 15:15 price `hold` days later, or at the
    stop. Returns daily rows (% of capital), one-lot rows (rupees: one lot per trade, today's lot
    sizes) and the trades."""
    base, take = parse_variant(variant)
    meta = VARIANTS[base]
    hold, top, k, cap = meta["hold"], TAKES[take], meta["stop"], meta["max_open"]
    idx, cols = d["px"].index, d["px"].columns
    hit = ((d["setups"][meta["setup"]] & d["eligible"]).fillna(False)
           & (d["rankable"] >= MIN_STOCKS).to_numpy()[:, None]).to_numpy()
    px, rsi = d["px"].to_numpy(), d["rsi"].to_numpy()
    op, lo, lo15, sd = (d[x].to_numpy() for x in ("open", "low", "low1515", "sigma"))
    lots = (lot.reindex(cols).to_numpy() if lot is not None else np.full(len(cols), np.nan))
    n = len(idx)
    gross, turn, held = np.zeros(n), np.zeros(n), np.zeros(n, dtype=int)
    g_rs, t_rs, not_rs, held_lots = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n, dtype=int)
    open_trades, trades = [], []
    for i in range(n):
        still = []
        for tr in open_trades:  # each open trade's move from yesterday's 15:15 to today's
            s_ = tr["s"]
            prev = tr["last"]
            last_day = i == tr["sell_i"]
            price = px[i, s_]
            exit_px = reason = None
            if tr["stop"] is not None:
                o = op[i, s_]
                low = lo15[i, s_] if last_day else lo[i, s_]
                if pd.notna(o) and o <= tr["stop"] and not last_day:
                    exit_px, reason = float(o), "stop (gap)"
                elif pd.notna(low) and low <= tr["stop"]:
                    exit_px, reason = tr["stop"], "stop"
            if exit_px is None and last_day:
                exit_px, reason = (float(price) if pd.notna(price) else prev), "time"
            now = exit_px if exit_px is not None else (float(price) if pd.notna(price) else prev)
            ret = now / prev - 1
            if abs(ret) > MAX_MOVE:  # a split or bad print: earns nothing
                ret, now = 0.0, prev
            held[i] += 1
            gross[i] += tr["w"] * ret
            if tr["lot"]:
                held_lots[i] += 1
                g_rs[i] += tr["lot"] * (now - prev)
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
        cand = np.flatnonzero(hit[i])
        if cap:  # free slots only, stocks not already held
            held_now = {tr["s"] for tr in open_trades}
            cand = np.array([c for c in cand if c not in held_now], dtype=int)
            top = cap - len(open_trades)
        if top is not None and len(cand) > top:
            cand = cand[np.argsort(rsi[i, cand], kind="stable")[:max(top, 0)]]
        if len(cand):
            w = 1.0 / cap if cap else 1.0 / (hold * len(cand))
            for s_ in cand:
                buy = float(px[i, s_])
                stop = buy * (1 - k * sd[i, s_]) if k and pd.notna(sd[i, s_]) else None
                size = float(lots[s_]) if pd.notna(lots[s_]) else 0.0
                tr = {"s": s_, "buy_i": i, "sell_i": min(i + hold, n - 1) if i + hold < n else None, "buy": buy,
                      "last": buy, "w": w, "stop": stop, "lot": size, "rsi": float(rsi[i, s_])}
                if tr["sell_i"] is None:
                    tr["sell_i"] = n + 10**6  # past the data: still open
                turn[i] += w
                t_rs[i] += size * buy
                open_trades.append(tr)
    trades += [dict(tr, sell=None, reason="open") for tr in open_trades]
    rows = [(idx[i].date(), float(gross[i]), float(turn[i]), float(gross[i]), 0.0, int(held[i])) for i in range(n)]
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
                      "reason": [x["reason"] for x in closed]})
    cost = xsmr.cost_per_side(slippage)
    t["gross"] = t["w"] * (t["sell"] / t["buy"] - 1)
    t["cost"] = t["w"] * (1 + t["sell"] / t["buy"]) * cost
    t["net"] = t["gross"] - t["cost"]
    wins, losses = t.loc[t["net"] > 0, "net"].sum(), -t.loc[t["net"] < 0, "net"].sum()
    out["summary"].update({
        "trades": int(len(t)), "win_rate": round(float(100 * (t["net"] > 0).mean()), 1),
        "win_rate_gross": round(float(100 * (t["gross"] > 0).mean()), 1),
        "avg_cost_pct": round(float(100 * t["cost"].mean()), 4), "avg_net_pct": round(float(100 * t["net"].mean()), 4),
        "profit_factor": round(float(wins / losses), 2) if losses > 0 else None,
        "stopped_pct": round(float(100 * t["reason"].str.startswith("stop").mean()), 1),
        "avg_trade_pct": round(float(100 * (t["sell"] / t["buy"] - 1).mean()), 3),
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
        if any(meta[k] != want[k] for k in ("max_open", "stop", "timing")):
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
        if not (tr["buy_i"] < i <= min(tr["sell_i"], len(idx) - 1)) or tr["buy_i"] < i - hold:
            continue
        s_ = tr["s"]
        symbol = cols[s_]
        prev = d["px"].iat[i - 1, s_]
        today = tr["sell"] if tr["sell_i"] == i else d["px"].iat[i, s_]
        move = float(today / prev - 1) if pd.notna(prev) and pd.notna(today) else 0.0
        sold = tr["sell"] is not None
        size = lot.get(symbol)
        rows.append({"symbol": symbol, "side": "long", "weight_pct": round(100 * tr["w"], 3),
                     "signal_pct": round(tr["rsi"], 1), "bought": idx[tr["buy_i"]].date().isoformat(),
                     "buy": round(tr["buy"], 2),
                     "stop": round(tr["stop"], 2) if tr["stop"] is not None else None,
                     "sold": idx[tr["sell_i"]].date().isoformat() if sold else None,
                     "sell": round(tr["sell"], 2) if sold else None, "reason": tr["reason"],
                     "trade_pct": round(100 * (tr["sell"] / tr["buy"] - 1), 2) if sold else None,
                     "day_of_hold": i - tr["buy_i"], "hold": hold,
                     "move_pct": round(100 * move, 2), "contribution_bps": round(10000 * tr["w"] * move, 2),
                     "lot_size": int(size) if pd.notna(size) else None,
                     "trade_rs": round(size * (tr["sell"] - tr["buy"])) if sold and pd.notna(size) else None})
    return sorted(rows, key=lambda x: (x["bought"], x["symbol"]))
