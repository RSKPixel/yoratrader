"""Paper trading for the v2 pages: the recorded paper trades (gapwatch, xsmrwatch) re-sized to the
page's parameters, as fractions of capital (the page turns them into rupees). Nothing here records or
places orders; the production scheduler records.

- Buy/Sell on gap: every qualifying stock is recorded at the 09:15 open. Max open N = the day's N
  biggest gaps (long only, or both sides), capital / N each; as per model = the book, the top 10 with
  capital split across the day's picks. Exit at 15:15 (or the 1σ stop); open picks use the last price.
- Cross-sectional mean reversion: 5 long + 5 short are recorded each day (ranked by how far each
  stock's open moved from the day's average). Pairs k (2k <= max open) = the top k of each side,
  capital / max open each; as per model = the recorded 5 + 5, a tenth of capital each.

Costs: NSE futures charges + slippage on the buy and the sale (xsmr.cost_per_side).
"""

import gapwatch
import xsmr
import xsmrwatch

TOP = gapwatch.TOP


def _summary(days):
    closed = [d for d in days if d["status"] == "closed"]
    nets = [d["net_pct"] for d in closed]
    trades = [p for d in closed for p in d["picks"]]
    return {"days": len(closed), "trades": len(trades),
            "win_days": round(100 * sum(n > 0 for n in nets) / len(nets)) if nets else None,
            "win_rate": round(100 * sum(p["net_pct"] > 0 for p in trades) / len(trades), 1) if trades else None,
            "net_pct": round(sum(nets), 4) if nets else 0.0,
            "avg_day_pct": round(sum(nets) / len(nets), 4) if nets else None,
            "avg_trade_pct": round(sum(p["book_net_pct"] for p in trades) / len(trades), 4) if trades else None,
            "cost_pct": round(sum(p["book_cost_pct"] for p in trades), 4) if trades else 0.0}


def gap(side="long", stop="none", max_open=5, slippage=0.0002):
    data = gapwatch.paper(slippage)
    cps = xsmr.cost_per_side(slippage)
    by_day = {}
    for p in data["picks"]:
        if side == "long" and p["side"] != "long":
            continue
        by_day.setdefault(p["day"], []).append(p)
    days = []
    for day, picks in sorted(by_day.items(), reverse=True):
        picks.sort(key=lambda p: -abs(p["gap_pct"]))
        picks = picks[: (max_open or TOP)]
        w = 1.0 / max_open if max_open else 1.0 / len(picks)
        rows = []
        for i, p in enumerate(picks):
            closed = p["status"] == "closed"
            exit_px = (p.get("exit_stop") if stop == "1sd" else p.get("exit")) if closed else p.get("ltp")
            reason = (p.get("exit_reason_stop") if stop == "1sd" else p.get("exit_reason")) if closed else ("live" if exit_px else "open")
            sign = 1 if p["side"] == "long" else -1
            ret = sign * (exit_px / p["entry"] - 1) if exit_px else None
            cost = (1 + (exit_px / p["entry"] if exit_px else 1)) * cps
            rows.append({"symbol": p["symbol"], "side": p["side"], "rank": i + 1, "gap_pct": p["gap_pct"],
                         "sigma_pct": p.get("sigma_pct"), "entry": p["entry"], "entry_live": p.get("entry_live"),
                         "live_at": p.get("live_at"), "stop": p["stop"], "exit": exit_px, "reason": reason, "closed": closed,
                         "weight_pct": round(100 * w, 3), "ret_pct": round(100 * ret, 3) if ret is not None else None,
                         "net_pct": round(100 * (ret - cost), 3) if ret is not None else None,
                         "book_net_pct": round(100 * w * (ret - cost), 4) if ret is not None else 0.0,
                         "book_cost_pct": round(100 * w * cost, 4)})
        status = "closed" if all(r["closed"] for r in rows) else "open"
        days.append({"day": day, "status": status, "picks": rows,
                     "net_pct": round(sum(r["book_net_pct"] for r in rows), 4)})
    watch = data["watchlist"]
    if side == "long":
        watch = [z for z in watch if z.get("buy_below")]
    return {"now": data["now"], "today": data["today"], "session": data["session"], "market_open": data["market_open"],
            "today_recorded": data["today_recorded"], "last_recorded": data["last_recorded"], "ltp_at": data["ltp_at"],
            "daily_as_of": data["daily_as_of"], "watchlist": watch, "days": days, "summary": _summary(days),
            "cost_per_side_bps": round(10000 * cps, 2)}


def xsmr_(pairs=5, stop="none", max_open=10, slippage=0.0002):
    data = xsmrwatch.paper(slippage, stop=stop == "1sd")
    cps = xsmr.cost_per_side(slippage)
    k = max(1, min(int(pairs or 1), xsmrwatch.PER_SIDE, (max_open // 2) if max_open else xsmrwatch.PER_SIDE))
    w = 1.0 / max_open if max_open else xsmrwatch.WEIGHT
    by_day = {}
    for p in data["positions"]:
        if p["rank"] <= k:
            by_day.setdefault(p["day"], []).append(p)
    days = []
    for day, picks in sorted(by_day.items(), reverse=True):
        rows = []
        for p in picks:
            ret = p["ret_pct"]
            exit_px = p.get("exit") if p["status"] == "closed" else p.get("ltp")
            cost = (1 + (exit_px / p["entry"] if exit_px else 1)) * cps
            rows.append({"symbol": p["symbol"], "side": p["side"], "rank": p["rank"], "signal_pct": p.get("signal_pct"),
                         "entry": p["entry"], "entry_live": p.get("entry_live"), "live_at": p.get("live_at"), "stop": p.get("stop"),
                         "exit": exit_px, "reason": p.get("exit_reason") or ("live" if exit_px else "open"),
                         "closed": p["status"] == "closed", "weight_pct": round(100 * w, 3),
                         "ret_pct": ret, "net_pct": round(ret - 100 * cost, 3) if ret is not None else None,
                         "book_net_pct": round(w * (ret - 100 * cost), 4) if ret is not None else 0.0,
                         "book_cost_pct": round(100 * w * cost, 4)})
        rows.sort(key=lambda r: (r["side"] != "long", r["rank"]))
        days.append({"day": day, "status": "closed" if all(r["closed"] for r in rows) else "open", "picks": rows,
                     "net_pct": round(sum(r["book_net_pct"] for r in rows), 4)})
    return {"now": data["now"], "today": data["today"], "market_open": data["market_open"],
            "today_recorded": data["today_recorded"], "ltp_at": data["ltp_at"], "days": days, "summary": _summary(days),
            "per_side": k, "recorded_per_side": xsmrwatch.PER_SIDE, "backtest": data["backtest"],
            "cost_per_side_bps": round(10000 * cps, 2)}
