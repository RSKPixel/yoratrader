"""Paper vs backtest: for each paper book, its closed paper trades against the backtest's trades over the
same entry days, at the same settings (the paper landing page's max open for gap and cross-sectional;
Oops at max 3 and the next-open exit; the RSI(2) books at their paper max open, futures prices).

Per book: the trades, win rate and average net per trade (each trade on its own value, after costs) on
both sides, and how many of the paper's (day, stock) picks the backtest also took. The window is the
paper's first day up to the last day the backtest has data for (the backtest store is topped up after the
close, so the latest paper days wait a day). A multi-day book compares trades bought up to a week before
the backtest's last day, so the backtest has sold them too.

Why it matters: a model whose paper results stay well below its backtest over enough trades is the sign
that the backtest was too good (fills a real order misses, prices it can't get, curve fitting).
"""

import pandas as pd

import connorswatch
import oopswatch
import v2connors
import v2gap
import v2oops
import v2paper
import v2xsmr
from slip import SLIPPAGE as SL

MIN_TRADES = 30  # fewer paper trades than this: too early to read anything into the difference


def _stats(nets):
    nets = [x for x in nets if x is not None]
    if not nets:
        return {"trades": 0, "win_rate": None, "avg_net_pct": None}
    return {"trades": len(nets), "win_rate": round(100 * sum(x > 0 for x in nets) / len(nets), 1),
            "avg_net_pct": round(sum(nets) / len(nets), 3)}


def _row(key, label, link, paper, bt, until):
    """paper: [(day iso, symbol, net %)] closed; bt: DataFrame entry day, symbol, net (fraction)."""
    since = min((d for d, _, _ in paper), default=None)
    row = {"key": key, "label": label, "link": link, "since": since, "until": until}
    if since is None:
        return {**row, "status": "no closed paper trades yet", "paper": _stats([]), "backtest": _stats([])}
    paper = [p for p in paper if until and p[0] <= until]
    b = bt[(bt["entry"] >= pd.Timestamp(since)) & (bt["entry"] <= pd.Timestamp(until))] if until else bt.iloc[0:0]
    pk = {(d, s) for d, s, _ in paper}
    bk = {(d.date().isoformat(), s) for d, s in zip(b["entry"], b["symbol"])}
    ps, bs = _stats([n for _, _, n in paper]), _stats(list(100 * b["net"]))
    same = round(100 * len(pk & bk) / len(pk), 1) if pk else None
    if ps["trades"] == 0:
        status = "waiting for the backtest to reach the paper days"
    elif ps["trades"] < MIN_TRADES:
        status = f"too early ({ps['trades']} of {MIN_TRADES} trades)"
    elif bs["avg_net_pct"] is None:
        status = "no backtest trades on these days"
    else:
        gap = ps["avg_net_pct"] - bs["avg_net_pct"]
        status = "in line" if gap >= -0.5 * abs(bs["avg_net_pct"]) or gap >= -0.05 else "behind the backtest"
    return {**row, "paper": ps, "backtest": bs, "same_picks_pct": same, "status": status,
            "diff_pct": round(ps["avg_net_pct"] - bs["avg_net_pct"], 3) if ps["avg_net_pct"] is not None and bs["avg_net_pct"] is not None else None}


def _last(days):
    return days.max().date().isoformat() if len(days) else None


def compare(gap_max_open=5, xsmr_max_open=10):
    rows = []
    # Buy/Sell on gap (long)
    try:
        g = v2paper.gap("long", "none", gap_max_open, SL["gap"], "on")
        paper = [(d["day"], p["symbol"], p["net_pct"]) for d in g["days"] for p in d["picks"] if p["closed"]]
        t, days = v2gap._sized("fno", "long", "none", gap_max_open, SL["gap"], "gap", "on")
        bt = pd.DataFrame({"entry": pd.to_datetime(t["day"]), "symbol": t["symbol"], "net": t["net"]})
        rows.append(_row("gap", "Buy/Sell on gap", "/v2/paper/buy-on-gap", paper, bt, _last(pd.DatetimeIndex(days))))
    except Exception as error:
        rows.append({"key": "gap", "label": "Buy/Sell on gap", "error": str(error)})
    # Cross-sectional mean reversion
    try:
        pairs = min(5, xsmr_max_open // 2) if xsmr_max_open else 5
        x = v2paper.xsmr_(pairs, "none", xsmr_max_open, SL["xsmr"], "off")
        paper = [(d["day"], p["symbol"], p["net_pct"]) for d in x["days"] for p in d["picks"] if p["closed"]]
        t, days = v2xsmr._sized("fno", "intraday", "0915", "none", xsmr_max_open, pairs, SL["xsmr"], "off")
        bt = pd.DataFrame({"entry": pd.to_datetime(t["day"]), "symbol": t["symbol"], "net": t["net"]})
        rows.append(_row("xsmr", "Cross-sectional mean reversion", "/v2/paper/xs-mean-reversion", paper, bt, _last(pd.DatetimeIndex(days))))
    except Exception as error:
        rows.append({"key": "xsmr", "label": "Cross-sectional mean reversion", "error": str(error)})
    # Oops (next-open exit: the backtest's trades are listed once the next day's open is stored)
    try:
        o = oopswatch.paper(SL["oops"])
        paper = [(d["day"], p["symbol"], p["net_pct"]) for d in o["days"] for p in d["picks"] if p["closed"]]
        t, days = v2oops._sized("none", "any", o.get("max_open") or 3, SL["oops"], "nextopen", "on")
        bt = pd.DataFrame({"entry": pd.to_datetime(t["day"]), "symbol": t["symbol"], "net": t["net"]})
        days = pd.DatetimeIndex(days)
        until = days[-2].date().isoformat() if len(days) > 1 else None  # the last day's buys sell at the next open
        rows.append(_row("oops", "Oops gap reversal", "/v2/paper/oops", paper, bt, until))
    except Exception as error:
        rows.append({"key": "oops", "label": "Oops gap reversal", "error": str(error)})
    # Short-term mean reversion books (futures prices), held up to 5 days
    for key, book, label, link in (("rsi2", "rsi2", "Short-term mean reversion (RSI)", "/v2/paper/short-term-reversion"),
                                   ("cum", "cum", "Short-term mean reversion (C-RSI)", "/v2/paper/cumulative-rsi")):
        try:
            c = connorswatch.paper(SL["connors"], book=book)
            pr = connorswatch.price(book)  # the backtest on the book's prices now; each paper trade on its own
            paper = [(t["buy_day"], t["symbol"], t.get("book_net_pct")) for t in c["closed"]]
            setup = "cumrsi2" if book == "cum" else "rsi2"
            hold = "0d" if connorswatch.exit_mode(book) == "strength" else "5d"
            t, days, _ = v2connors._sized("fno", setup, hold, c["max_open"], "10pc" if c.get("disaster") == "on" else "none",
                                          c.get("trade_at") or "close", "all", SL["connors"], "long", "futures" if pr == "futures" else "cash")
            bt = pd.DataFrame({"entry": pd.to_datetime(t["entry_day"]), "symbol": t["symbol"], "net": t["net"]})
            days = pd.DatetimeIndex(days)
            until = days[-6].date().isoformat() if len(days) > 6 else None  # bought at least 5 trading days before the last: sold in the backtest too
            rows.append(_row(key, label, link, paper, bt, until))
        except Exception as error:
            rows.append({"key": key, "label": label, "error": str(error)})
    return {"rows": rows, "min_trades": MIN_TRADES}
