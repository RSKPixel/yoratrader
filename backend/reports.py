"""Reports: the intraday paper books' fills against their signals (Reports page).

For every trade of the tick-filled books (Oops, Buy/Sell on gap, Cross-sectional): the signal price (the open, or
for Oops yesterday's low) and the price really paid, and on the way out the printed exit price (15:15, the next
open) and the price really got, the slippage on each side (% and rupees, one lot; positive = worse than the signal),
charges, P&L and net; every missed order with why; and the analytics per book and overall for the days chosen.
Read-only: worked out from the paper books as the pages show them (the saved paper settings).
"""

import statistics

import oopswatch
import priority
import v2paper
from slip import SLIPPAGE as SL

BOOKS = (("oops", "Oops gap reversal"), ("gap", "Buy/Sell on gap"), ("xsmr", "Cross-sectional mean reversion"))


def _book(model, cfg):
    if model == "oops":
        return oopswatch.paper(SL["oops"])
    if model == "gap":
        return v2paper.gap(cfg["gap_side"], "none", cfg["gap_open"], SL["gap"])
    return v2paper.xsmr_(cfg["xs_k"], "none", 2 * cfg["xs_k"], SL["xsmr"])


def _pct(a, b, sign):
    """How much worse a (the price got) is than b (the signal), in %: positive = worse."""
    return round(100 * sign * (a - b) / b, 3) if a and b else None


def _row(model, name, day, fill, p):
    sign = 1 if p["side"] == "long" else -1
    qty = p.get("qty") or p.get("lot") or 0
    sig_in = p.get("paper_entry") or p["entry"]
    sig_out = p.get("paper_exit") or p.get("exit")
    tick_in = fill == "tick" and p.get("paper_entry") is not None
    tick_out = bool(p.get("exit_tick")) or (fill == "tick" and p.get("unpaired"))
    buy_in = _pct(p["entry"], sig_in, sign) if tick_in else p.get("slip_rate_in_pct")
    out = None
    if p.get("closed") and p.get("exit"):
        out = _pct(sig_out, p["exit"], sign) if tick_out and sig_out else p.get("slip_rate_out_pct")
    rs = lambda pct, px: round(qty * px * pct / 100, 2) if pct is not None and px and qty else None
    return {
        "book": model, "book_name": name, "day": day, "symbol": p["symbol"], "side": p["side"], "qty": qty or None,
        "status": "closed" if p.get("closed") else "open", "reason": p.get("reason"),
        "signal_in": round(sig_in, 2) if sig_in else None, "price_in": p["entry"], "at_in": p.get("filled_at"),
        "slip_in_pct": buy_in, "slip_in_rs": rs(buy_in, sig_in), "in_source": "tick" if tick_in else "fixed",
        "signal_out": round(sig_out, 2) if (sig_out and p.get("closed")) else None, "price_out": p.get("exit") if p.get("closed") else None,
        "at_out": p.get("exit_at"), "slip_out_pct": out, "slip_out_rs": rs(out, sig_out),
        "out_source": "tick" if tick_out else "fixed" if p.get("closed") else None,
        "ltp": p.get("exit") if not p.get("closed") else None,
        "pnl_rs": p.get("pnl_rs"), "charges_rs": p.get("cost_rs"), "net_rs": p.get("net_rs"), "thin": bool(p.get("thin")),
        "unpaired": bool(p.get("unpaired")),
    }


def _stats(rows, misses):
    closed = [r for r in rows if r["status"] == "closed"]
    ins = [r["slip_in_pct"] for r in rows if r["slip_in_pct"] is not None and r["in_source"] == "tick"]
    outs = [r["slip_out_pct"] for r in closed if r["slip_out_pct"] is not None and r["out_source"] == "tick"]
    slip_rs = sum((r["slip_in_rs"] or 0) + (r["slip_out_rs"] or 0) for r in rows)
    tried = len(rows) + len([m for m in misses if not m.get("skipped")])

    def dist(v):
        return {"avg": round(statistics.mean(v), 3), "median": round(statistics.median(v), 3), "max": round(max(v), 3),
                "min": round(min(v), 3), "n": len(v)} if v else None
    pnl = sum(r["pnl_rs"] or 0 for r in closed)
    gross = pnl + sum((r["slip_in_rs"] or 0) + (r["slip_out_rs"] or 0) for r in closed)  # at the signal prices
    return {
        "trades": len(rows), "closed": len(closed), "open": len(rows) - len(closed), "missed": len(misses),
        "fill_rate_pct": round(100 * len(rows) / tried, 1) if tried else None,
        "slip_in": dist(ins), "slip_out": dist(outs),
        "slip_rs": round(slip_rs, 2), "charges_rs": round(sum(r["charges_rs"] or 0 for r in closed), 2),
        "pnl_rs": round(pnl, 2), "net_rs": round(sum(r["net_rs"] or 0 for r in closed), 2),
        "at_signal_rs": round(gross, 2),
        "slip_share_pct": round(100 * sum((r["slip_in_rs"] or 0) + (r["slip_out_rs"] or 0) for r in closed) / abs(gross), 1) if gross else None,
        "thin": sum(r["thin"] for r in rows), "unpaired": sum(r["unpaired"] for r in rows),
        "win_rate_pct": round(100 * sum((r["net_rs"] or 0) > 0 for r in closed) / len(closed), 1) if closed else None,
    }


def paper_fills(day_from=None, day_to=None):
    """The report for days in [day_from, day_to] (ISO dates; default: every tick-filled day)."""
    cfg = priority._settings()
    rows, misses, by_book, days = [], [], {}, set()
    for model, name in BOOKS:
        try:
            data = _book(model, cfg)
        except Exception as error:
            by_book[model] = {"name": name, "error": str(error)}
            continue
        keep = lambda d: (not day_from or d >= day_from) and (not day_to or d <= day_to)
        b_rows = [_row(model, name, d["day"], d.get("fill"), p) for d in data["days"] if keep(d["day"]) for p in d["picks"]]
        cap = data.get("capped") or {}
        b_miss = [{"book": model, "book_name": name, "day": m["day"], "symbol": m["symbol"], "side": m["side"],
                   "signal": m.get("open") or m.get("prev_low"), "at": m.get("triggered_at"), "reason": m["reason"],
                   "skipped": bool(m.get("skipped")), "would_net_rs": m.get("market_net_rs"), "closed": m.get("closed")}
                  for m in cap.get("misses", []) if keep(m["day"])]
        rows += b_rows
        misses += b_miss
        days |= {r["day"] for r in b_rows}
        by_book[model] = {"name": name, **_stats(b_rows, b_miss)}
    rows.sort(key=lambda r: (r["day"], r["book"], r["symbol"]), reverse=True)
    worst = sorted([r for r in rows if r["slip_in_pct"] is not None], key=lambda r: -(r["slip_in_pct"] + (r["slip_out_pct"] or 0)))[:5]
    return {"from": day_from or (min(days) if days else None), "to": day_to or (max(days) if days else None),
            "days": sorted(days, reverse=True), "overall": _stats(rows, misses), "books": by_book,
            "trades": rows, "misses": misses, "worst": worst,
            "missed_winners": sum(1 for m in misses if m["closed"] and (m["would_net_rs"] or 0) > 0),
            "missed_closed": sum(1 for m in misses if m["closed"] and m["would_net_rs"] is not None),
            "missed_net_rs": round(sum(m["would_net_rs"] or 0 for m in misses if m["closed"]), 2)}
