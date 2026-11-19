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

Lots: every position is also sized as one F&O lot (v2margin: today's lots and margin rates). Each
row gets qty, contract value, margin and its rupee P&L after costs; each day its margin and net in
rupees and as % of that margin; the summary the capital required (the peak day's margin) and the
totals in rupees and as % of it. The % fields above stay for the backtest-style view.
"""

from datetime import date

import capped
import gapwatch
import priority
import realfill
import v2common
import v2margin
import v2meta
import xsmr
import xsmrwatch

TOP = gapwatch.TOP


def _times(day, rows):
    """Each row's entry_at / exit_at: in at the open (the live snapshot's time when recorded), out at 15:15
    or during the day at the stop (its time isn't recorded), or still open."""
    for r in rows:
        r["entry_at"] = f"{day} {r.get('live_at') or '09:15'}"
        reason = str(r.get("reason") or "")
        r["exit_at"] = (f"{day} {v2common.STOP_INTRADAY}" if reason.startswith("stop") else
                        f"{day} 15:15" if r.get("closed") else f"{day} open")
    return rows


def _slipped(r):
    """The trade book's slippage view of a sized row: the slippage rate on each side (the model's + a thin
    future's extra; a capped fill's entry is its real price, so none there), the prices after it, the rupees it
    cost, and the net at the paper price (charges only) next to the net after slippage (net_rs)."""
    if "slip_model_pct" not in r or not r.get("lot"):
        return
    sign = 1 if r["side"] == "long" else -1
    s_in = (r["slip_model_pct"] + (r.get("slip_in_pct") or 0)) / 100
    s_out = (r["slip_model_pct"] + (r.get("slip_out_pct") or 0)) / 100
    entry, exit_px = r["entry"], r.get("exit")
    slip_rs = r["lot"] * (entry * s_in + (exit_px * s_out if exit_px else 0))
    r.update(slip_rate_in_pct=round(100 * s_in, 3), slip_rate_out_pct=round(100 * s_out, 3) if exit_px else None,
             entry_slipped=round(entry * (1 + sign * s_in), 2), exit_slipped=round(exit_px * (1 - sign * s_out), 2) if exit_px else None,
             slip_rs=round(slip_rs, 2), net_paper_rs=round(r["net_rs"] + slip_rs, 2) if r.get("net_rs") is not None else None)
    r["net_paper_value_pct"] = v2margin.margin_pct(r["net_paper_rs"], r.get("contract_rs"))


def _lots(rows, lots, cps):
    """Add one-lot sizing to a day's rows; returns the day's rupee totals."""
    for r in rows:
        r.update(v2margin.size(lots, r["symbol"], r["side"], r["entry"], r.get("exit"), cps,
                               (r.get("slip_in_pct") or 0) / 100, (r.get("slip_out_pct") or 0) / 100))
        _slipped(r)
        r["net_margin_pct"] = v2margin.margin_pct(r["net_rs"], r["margin_rs"])
        r["net_value_pct"] = v2margin.margin_pct(r["net_rs"], r["contract_rs"])
    margin = sum(r["margin_rs"] or 0 for r in rows)
    contract = sum(r["contract_rs"] or 0 for r in rows)
    net = sum(r["net_rs"] or 0 for r in rows)
    return {"margin_rs": round(margin), "contract_rs": round(contract),
            "net_rs": round(net, 2), "cost_rs": round(sum(r["cost_rs"] or 0 for r in rows), 2),
            "net_margin_pct": v2margin.margin_pct(net, margin), "net_value_pct": v2margin.margin_pct(net, contract),
            "unsized": [r["symbol"] for r in rows if r["lot"] is None]}


def _lot_summary(days, lots):
    """Rupee totals over the closed days; capital required = the biggest day's margin (open days too)."""
    closed = [d for d in days if d["status"] == "closed"]
    capital = max((d["margin_rs"] for d in days), default=0)
    value = max((d["contract_rs"] for d in days), default=0)
    net = sum(d["net_rs"] for d in closed)
    cost = sum(d["cost_rs"] for d in closed)
    trades = [p for d in closed for p in d["picks"] if p["net_rs"] is not None]
    return {"capital_rs": capital, "contract_peak_rs": max((d["contract_rs"] for d in days), default=0),
            "net_rs": round(net, 2), "cost_rs": round(sum(d["cost_rs"] for d in closed), 2),
            "avg_day_rs": round(net / len(closed), 2) if closed else None,
            "net_margin_pct": v2margin.margin_pct(net, capital),
            "avg_day_margin_pct": v2margin.margin_pct(net / len(closed), capital) if closed else None,
            "cost_margin_pct": v2margin.margin_pct(cost, capital),
            "net_value_pct": v2margin.margin_pct(net, value),
            "avg_day_value_pct": v2margin.margin_pct(net / len(closed), value) if closed else None,
            "cost_value_pct": v2margin.margin_pct(cost, value),
            "win_rate_lots": round(100 * sum(p["net_rs"] > 0 for p in trades) / len(trades), 1) if trades else None,
            "win_days_lots": round(100 * sum(d["net_rs"] > 0 for d in closed) / len(closed)) if closed else None,
            "margins_as_of": v2margin.as_of(lots)}


def _ranges(ds, picks):
    """The closed rows' day ranges for the disaster stop: the future's daily candle for a row traded on the
    future, the share's for the older share rows."""
    closed = [p for p in picks if p["status"] == "closed"]
    day = lambda p: p["day"] if isinstance(p["day"], str) else p["day"].isoformat()
    import futsig
    out = ds.day_ranges([(p["symbol"], day(p)) for p in closed if not p.get("fut")])
    fut = futsig.fut_ranges([(p["symbol"], day(p)) for p in closed if p.get("fut")])
    return {**out, **fut} if fut else out


def apply_row(r, fills, cps):
    """A row's costs: charges + the model's slippage on both sides (cps), plus the extra slippage its
    recorded order book showed (realfill), as slip_in_pct / slip_out_pct (each % of that side's price);
    then its net. Expects _k (the fills keys), _w (book weight), _ret (gross return, a fraction)."""
    k_in, k_out = r.pop("_k", (None, None))
    w, ret = r.pop("_w"), r.pop("_ret")
    x_in = r.pop("_x_in") if "_x_in" in r else fills.extra(k_in) if k_in is not None else 0.0
    x_out = r.pop("_x_out") if "_x_out" in r else fills.extra(k_out) if k_out is not None else 0.0
    m_in = fills.measured(k_in) if k_in is not None else None
    m_out = fills.measured(k_out) if k_out is not None else None
    ratio = r["exit"] / r["entry"] if r.get("exit") and r.get("entry") else 1
    cost = (1 + ratio) * cps + x_in + x_out * ratio
    r.update({"slip_in_pct": round(100 * x_in, 3), "slip_out_pct": round(100 * x_out, 3), "slip_model_pct": round(100 * fills.slip, 4),
              "book_in_pct": round(100 * m_in, 3) if m_in is not None else None,
              "book_out_pct": round(100 * m_out, 3) if m_out is not None else None,
              "thin": bool(x_in or x_out),
              "ret_pct": round(100 * ret, 3) if ret is not None else None,
              "net_pct": round(100 * (ret - cost), 3) if ret is not None else None,
              "book_net_pct": round(100 * w * (ret - cost), 4) if ret is not None else 0.0,
              "book_cost_pct": round(100 * w * cost, 4)})
    return r


def _capped_prepare(model, inputs, fills, slippage):
    """The capped-limit version's days from each day's ranked rows (before the costs are applied).
    inputs: [(day, rows in rank order, {group: slots}, group of a row)]."""
    out, misses = [], []
    for day, rows, slots, group in inputs:
        d = date.fromisoformat(str(day))
        skip = priority.skipped(model, d)  # one stock, one intraday book (priority.py): the next candidate instead
        cands = [{"symbol": r["symbol"], "side": r["side"], "entry": r["entry"], "group": group(r), "row": dict(r)} for r in rows
                 if r["symbol"] not in skip]
        misses += [{"day": str(day), "symbol": r["symbol"], "side": r["side"], "rank": r.get("rank"), "open": r["entry"],
                    "reason": f"skipped: {skip[r['symbol']]}", "skipped": True, "_row": dict(r)} for r in rows if r["symbol"] in skip]
        res = capped.open_entries(d, cands, slots, capped.CAP[model])
        if res is None:  # no tick log that day (before 19 Nov 2026)
            continue
        got, missed, ended = res
        unpaired = []
        if model == "xsmr":  # a pair trades only if both sides fill: the unmatched fills are sold straight back
            longs = sorted([g for g in got if g[0]["side"] == "long"], key=lambda g: g[0]["row"]["rank"])
            shorts = sorted([g for g in got if g[0]["side"] == "short"], key=lambda g: g[0]["row"]["rank"])
            n = min(len(longs), len(shorts))
            got, unpaired = longs[:n] + shorts[:n], longs[n:] + shorts[n:]
        picks = []
        for c, ts, px in got:
            r = dict(c["row"])
            sign = 1 if r["side"] == "long" else -1
            r.update(paper_entry=r["entry"], entry=round(px, 2), filled_at=ts.strftime("%H:%M:%S"), entry_at=f"{day} {ts:%H:%M:%S}",
                     _k=(None, r["_k"][1]), _x_in=-slippage)  # the fill is the real price: charges only on the way in
            if r["closed"] and r.get("exit") and "stop" not in str(r.get("reason")):  # the 15:15 exit at the real bid / ask
                out = capped.market_exit(d, r["symbol"], r["side"], realfill.at_close(d))
                if out:
                    r.update(paper_exit=r["exit"], exit=round(out[1], 2), exit_at=f"{day} {out[0]:%H:%M:%S}", exit_tick=True,
                             _k=(None, None), _x_out=-slippage)
            r["_ret"] = sign * (r["exit"] / px - 1) if r.get("exit") else None
            picks.append(r)
        for c, ts, px in unpaired:
            r = dict(c["row"])
            sign = 1 if r["side"] == "long" else -1
            back = capped.unwind(d, r["symbol"], r["side"], ended)
            out_px = back[1] if back else px
            r.update(paper_entry=r["entry"], entry=round(px, 2), filled_at=ts.strftime("%H:%M:%S"), entry_at=f"{day} {ts:%H:%M:%S}",
                     exit=round(out_px, 2), closed=True, reason="no pair: sold back", unpaired=True,
                     exit_at=f"{day} {back[0]:%H:%M:%S}" if back else f"{day} {ended:%H:%M:%S}",
                     _ret=sign * (out_px / px - 1), _k=(None, None), _x_in=-slippage, _x_out=-slippage)  # both real prices: charges only
            picks.append(r)
        out.append({"day": str(day), "status": "closed" if all(r["closed"] for r in picks) else "open", "picks": picks})
        misses += [{"day": str(day), "symbol": c["symbol"], "side": c["side"], "rank": c["row"].get("rank"), "open": c["entry"],
                    "reason": why, "_row": dict(c["row"])} for c, why in missed]
    return out, misses


def _capped_finish(model, days, misses, fills, cps, lots, market_days):
    """Costs on the capped days, what each missed pick made in the market version, and the market version's
    totals over the same days (a fair side by side)."""
    _apply_fills(days, fills, cps, lots)
    for m in misses:
        r = apply_row(m.pop("_row"), fills, cps)
        sized = v2margin.size(lots, r["symbol"], r["side"], r["entry"], r.get("exit"), cps,
                              (r.get("slip_in_pct") or 0) / 100, (r.get("slip_out_pct") or 0) / 100)
        m.update(closed=r["closed"], market_net_pct=r["net_pct"], market_net_rs=sized["net_rs"], exit=r.get("exit"))
    same = {d["day"] for d in days}
    market = [d for d in market_days if d["day"] in same]
    def totals(ds):
        open_days = [d for d in ds if d["status"] == "open"]
        return {**_summary(ds), **_lot_summary(ds, lots), "open_net_rs": round(sum(d["net_rs"] for d in open_days), 2),
                "open_trades": sum(len(d["picks"]) for d in open_days)}
    closed_misses = [m for m in misses if m["closed"] and m["market_net_rs"] is not None]
    return {"days": days, "summary": totals(days), "market_same_days": totals(market),
            "missed_net_rs": round(sum(m["market_net_rs"] for m in closed_misses), 2),
            "missed_winners": sum(m["market_net_rs"] > 0 for m in closed_misses), "missed_closed": len(closed_misses),
            "misses": misses, "cap_pct": round(100 * capped.CAP[model], 2), "wait_s": capped.WAIT,
            "from": min(same) if same else None}


def tick_book(days, cap):
    """The book filled tick by tick: each day the tick log covers takes the tick-filled (capped-limit) day in
    place of the printed-price one; other days (none since 19 Nov 2026, or today before the log is saved at
    about 09:17) keep the printed price, marked fill = "printed"."""
    if not cap:
        for d in days:
            d["fill"] = "printed"
        return days
    tick = {d["day"]: d for d in cap["days"]}
    out = []
    for d in days:
        t = tick.get(d["day"])
        out.append({**t, "fill": "tick"} if t is not None else {**d, "fill": "printed"})
    have = {d["day"] for d in days}
    out += [{**t, "fill": "tick"} for day, t in tick.items() if day not in have]  # a day only the tick fills have
    return sorted(out, key=lambda d: d["day"], reverse=True)


def _apply_fills(days, fills, cps, lots):
    for d in days:
        for r in d["picks"]:
            apply_row(r, fills, cps)
        d.update(net_pct=round(sum(r["book_net_pct"] for r in d["picks"]), 4), **_lots(d["picks"], lots, cps))


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


def gap(side="long", stop="none", max_open=5, slippage=0.0002, disaster="off"):
    import disaster as ds
    data = gapwatch.paper(slippage)
    cps = xsmr.cost_per_side(slippage)
    lots = v2margin.table()
    dpct = ds.PCT if disaster == "on" else None  # the 10% disaster stop (switch on the page)
    ranges = _ranges(ds, data["picks"])
    fills = realfill.Fills(slippage)
    cap_in = []
    by_day = {}
    for p in data["picks"]:
        if side == "long" and p["side"] != "long":
            continue
        by_day.setdefault(p["day"], []).append(p)
    days = []
    for day, picks in sorted(by_day.items(), reverse=True):
        picks.sort(key=lambda p: -abs(p["gap_pct"]))
        n = max_open or TOP
        w = 1.0 / max_open if max_open else 1.0 / len(picks[:n])
        rows = []
        for i, p in enumerate(picks):  # every candidate (the capped version's replacements come from the rest)
            closed = p["status"] == "closed"
            exit_px = (p.get("exit_stop") if stop == "1sd" else p.get("exit")) if closed else p.get("ltp")
            reason = (p.get("exit_reason_stop") if stop == "1sd" else p.get("exit_reason")) if closed else ("live" if exit_px else "open")
            lo, hi = ranges.get((p["symbol"], p["day"]), (None, None)) if closed else (None, None)
            hit, level = ds.apply(p["side"], p["entry"], lo, hi, None if closed else exit_px, dpct)
            if hit:
                exit_px, reason = level, "disaster stop"
            sign = 1 if p["side"] == "long" else -1
            ret = sign * (exit_px / p["entry"] - 1) if exit_px else None
            d = date.fromisoformat(day)
            k_in = fills.want(d, p["symbol"], "buy" if sign == 1 else "sell", realfill.at_open(d), p["entry"]) if p.get("fut") else None
            k_out = (fills.want(d, p["symbol"], "sell" if sign == 1 else "buy", realfill.at_close(d), exit_px)
                     if p.get("fut") and closed and "stop" not in str(reason) else None)
            rows.append({"symbol": p["symbol"], "fut": p.get("fut"), "side": p["side"], "rank": i + 1, "gap_pct": p["gap_pct"],
                         "_k": (k_in, k_out),
                         "sigma_pct": p.get("sigma_pct"), "entry": p["entry"], "entry_live": p.get("entry_live"),
                         "live_at": p.get("live_at"), "stop": p["stop"], "exit": exit_px, "reason": reason, "closed": closed,
                         "weight_pct": round(100 * w, 3), "_w": w, "_ret": ret})
        _times(day, rows)
        cap_in.append((day, rows, {"all": n}, lambda r: "all"))
        rows = rows[:n]
        status = "closed" if all(r["closed"] for r in rows) else "open"
        days.append({"day": day, "status": status, "picks": rows})
    cap_days, cap_miss = _capped_prepare("gap", cap_in, fills, slippage)
    _apply_fills(days, fills.load(), cps, lots)
    cap = _capped_finish("gap", cap_days, cap_miss, fills, cps, lots, days)
    days = tick_book(days, cap)
    watch = data["watchlist"]
    if side == "long":
        watch = [z for z in watch if z.get("buy_below")]
    return {"now": data["now"], "today": data["today"], "session": data["session"], "market_open": data["market_open"],
            "today_recorded": data["today_recorded"], "last_recorded": data["last_recorded"], "ltp_at": data["ltp_at"],
            "daily_as_of": data["daily_as_of"], "watchlist": watch, "days": days, "summary": {**_summary(days), **_lot_summary(days, lots)},
            "cost_per_side_bps": round(10000 * cps, 2), "disaster_stop_pct": dpct, "capped": cap}


def _meta(data, days, cps):
    """Meta-sizing (v2meta): each day's lots a position (2 on a predicted-good day, else 1) from the
    recorded 5 + 5 book, applied to the page's positions; the sized totals for the summary."""
    book = {}
    for p in data["positions"]:
        if p["ret_pct"] is None:
            continue
        exit_px = p.get("exit") if p["status"] == "closed" else p.get("ltp")
        cost = (1 + (exit_px / p["entry"] if exit_px else 1)) * cps
        book[p["day"]] = book.get(p["day"], 0.0) + xsmrwatch.WEIGHT * (p["ret_pct"] - 100 * cost)
    try:
        sized, info = v2meta.sizes([{"day": d, "net_pct": n} for d, n in book.items()])
    except Exception as error:
        print("Meta-sizing failed:", error)
        return {"error": str(error)}
    closed = [d for d in days if d["status"] == "closed"]
    for d in days:
        m = sized.get(d["day"])
        d["meta"] = m and {**m, "net_rs": round(d["net_rs"] * m["size"], 2), "margin_rs": round(d["margin_rs"] * m["size"])}
    net = sum(d["meta"]["net_rs"] for d in closed if d.get("meta"))
    capital = max((d["meta"]["margin_rs"] for d in days if d.get("meta")), default=0)
    return {**info, "net_rs": round(net, 2), "capital_rs": capital, "days": sum(1 for d in closed if d.get("meta")),
            "big_days": sum(1 for d in closed if d.get("meta") and d["meta"]["size"] == v2meta.BIG),
            "net_margin_pct": v2margin.margin_pct(net, capital), "big": v2meta.BIG, "small": v2meta.SMALL}


def xsmr_(pairs=5, stop="none", max_open=10, slippage=0.0002, disaster="off"):
    import disaster as ds
    data = xsmrwatch.paper(slippage, stop=stop == "1sd")
    cps = xsmr.cost_per_side(slippage)
    dpct = ds.PCT if disaster == "on" else None  # the 10% disaster stop (switch on the page)
    ranges = _ranges(ds, data["positions"])
    lots = v2margin.table()
    fills = realfill.Fills(slippage)
    k = max(1, min(int(pairs or 1), xsmrwatch.PER_SIDE, (max_open // 2) if max_open else xsmrwatch.PER_SIDE))
    w = 1.0 / max_open if max_open else xsmrwatch.WEIGHT
    cap_in = []
    by_day = {}
    for p in data["positions"]:
        by_day.setdefault(p["day"], []).append(p)  # every recorded rank (the capped version's replacements)
    days = []
    for day, picks in sorted(by_day.items(), reverse=True):
        rows = []
        for p in picks:
            ret = p["ret_pct"]
            exit_px = p.get("exit") if p["status"] == "closed" else p.get("ltp")
            reason = p.get("exit_reason") or ("live" if exit_px else "open")
            closed = p["status"] == "closed"
            lo, hi = ranges.get((p["symbol"], p["day"]), (None, None)) if closed else (None, None)
            hit, level = ds.apply(p["side"], p["entry"], lo, hi, None if closed else exit_px, dpct)
            if hit:
                exit_px, reason = level, "disaster stop"
                ret = round(100 * (1 if p["side"] == "long" else -1) * (level / p["entry"] - 1), 3)
            sign = 1 if p["side"] == "long" else -1
            d = date.fromisoformat(day) if isinstance(day, str) else day
            k_in = fills.want(d, p["symbol"], "buy" if sign == 1 else "sell", realfill.at_open(d), p["entry"]) if p.get("fut") else None
            k_out = (fills.want(d, p["symbol"], "sell" if sign == 1 else "buy", realfill.at_close(d), exit_px)
                     if p.get("fut") and closed and "stop" not in str(reason) else None)
            rows.append({"symbol": p["symbol"], "fut": p.get("fut"), "side": p["side"], "rank": p["rank"], "signal_pct": p.get("signal_pct"),
                         "_k": (k_in, k_out), "_w": w, "_ret": ret / 100 if ret is not None else None,
                         "entry": p["entry"], "entry_live": p.get("entry_live"), "live_at": p.get("live_at"), "stop": p.get("stop"),
                         "exit": exit_px, "reason": reason,
                         "closed": p["status"] == "closed", "weight_pct": round(100 * w, 3)})
        rows.sort(key=lambda r: (r["side"] != "long", r["rank"]))
        _times(day, rows)
        cap_in.append((day, rows, {"long": k, "short": k}, lambda r: r["side"]))
        rows = [r for r in rows if r["rank"] <= k]
        days.append({"day": day, "status": "closed" if all(r["closed"] for r in rows) else "open", "picks": rows})
    cap_days, cap_miss = _capped_prepare("xsmr", cap_in, fills, slippage)
    _apply_fills(days, fills.load(), cps, lots)
    cap = _capped_finish("xsmr", cap_days, cap_miss, fills, cps, lots, days)
    days = tick_book(days, cap)
    meta = _meta(data, days, cps)
    return {"now": data["now"], "today": data["today"], "market_open": data["market_open"], "meta": meta,
            "today_recorded": data["today_recorded"], "ltp_at": data["ltp_at"], "days": days, "summary": {**_summary(days), **_lot_summary(days, lots)},
            "per_side": k, "recorded_per_side": xsmrwatch.PER_SIDE, "backtest": data["backtest"],
            "cost_per_side_bps": round(10000 * cps, 2), "disaster_stop_pct": dpct, "capped": cap}
