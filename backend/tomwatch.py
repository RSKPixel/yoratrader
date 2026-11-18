"""Turn of the month paper trading (Larry Williams; the v2 backtest's book: Nifty, the last 4 trading days of the
month to the 3rd of the next), on the Nifty FUTURE: one lot, bought at 15:15 on the month's 5th-last trading day
and sold at 15:15 on the next month's 3rd trading day (the closest live stand-in for the backtest's closes).

The contract is the nearest Nifty future expiring after the sale day, so the position never crosses an expiry
(no roll). The buy and sell days come from v2tom's calendar (NSE's holiday list). Run by gapwatch's production
scheduler at 15:15:01; nothing here places orders. The live page trades an in-the-money call as a stand-in for
this future.
"""

from datetime import date, datetime
from datetime import time as clock

import gapwatch
import kite_auth
import v2tom
import xsmr
from db import connect, schema_once

RECORD_AT, RECORD_UNTIL = clock(15, 15), clock(15, 30)
from slip import SLIPPAGE as _SL
SLIPPAGE = _SL["tom"]


@schema_once
def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS tom_paper (
            buy_day DATE PRIMARY KEY, sell_plan DATE NOT NULL, fut TEXT NOT NULL, lot INTEGER NOT NULL,
            buy DOUBLE PRECISION NOT NULL, buy_at TIMESTAMPTZ NOT NULL, spot_buy DOUBLE PRECISION,
            sell_day DATE, sell DOUBLE PRECISION, sell_at TIMESTAMPTZ, spot_sell DOUBLE PRECISION
        );
        """
    )


def _contract(kite, after):
    """The nearest Nifty future expiring after `after`: (tradingsymbol, expiry, lot size)."""
    futs = [r for r in kite.instruments("NFO") if r["name"] == "NIFTY" and r["instrument_type"] == "FUT" and r["expiry"] > after]
    f = min(futs, key=lambda r: r["expiry"])
    return f["tradingsymbol"], f["expiry"], int(f["lot_size"])


def record(force=False):
    """15:15: on the buy day, buy one lot of the Nifty future; on the sell day, sell the open position."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or not (RECORD_AT <= now.time() < RECORD_UNTIL or force):
        return {"recorded": False, "reason": "not 15:15"}
    plan = v2tom.plan(today, live=False)
    buy, sell = date.fromisoformat(plan["buy"]), date.fromisoformat(plan["sell"])
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT buy_day, fut, sell_plan FROM tom_paper WHERE sell_day IS NULL")
        open_rows = cursor.fetchall()
        cursor.execute("SELECT 1 FROM tom_paper WHERE buy_day = %s", (today,))
        bought_today = cursor.fetchone() is not None
    due = [(d, f) for d, f, sp in open_rows if today >= sp and d < today]  # its own sale day (a missed one: the next run)
    if today != buy and not due:
        return {"recorded": False, "reason": "not a buy or sell day"}
    kite = kite_auth.trading_client()
    out = {"recorded": True}
    with connect() as conn, conn.cursor() as cursor:
        for d, f in due:
            q = kite.ltp([f"NFO:{f}", "NSE:NIFTY 50"])
            cursor.execute("UPDATE tom_paper SET sell_day = %s, sell = %s, sell_at = %s, spot_sell = %s WHERE buy_day = %s",
                           (today, q[f"NFO:{f}"]["last_price"], now, q["NSE:NIFTY 50"]["last_price"], d))
            out["sold"] = f
        if today == buy and not bought_today and not open_rows:
            fut, _, lot = _contract(kite, sell)
            q = kite.ltp([f"NFO:{fut}", "NSE:NIFTY 50"])
            cursor.execute("INSERT INTO tom_paper (buy_day, sell_plan, fut, lot, buy, buy_at, spot_buy) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                           (today, sell, fut, lot, q[f"NFO:{fut}"]["last_price"], now, q["NSE:NIFTY 50"]["last_price"]))
            out["bought"] = fut
        conn.commit()
    return out


def paper(slippage=SLIPPAGE):
    """The book: this cycle's dates, the open position (marked now when Kite is connected), closed trades and totals,
    one lot each, after futures charges and slippage on the buy and the sale."""
    cps = xsmr.cost_per_side(slippage)
    today = gapwatch._now().date()
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT buy_day, sell_plan, fut, lot, buy, buy_at, spot_buy, sell_day, sell, sell_at, spot_sell "
                       "FROM tom_paper ORDER BY buy_day DESC")
        rows = cursor.fetchall()
    trades = []
    for bd, sp, fut, lot, b, bat, sb, sd, s, sat, ss in rows:
        t = {"buy_day": bd.isoformat(), "sell_plan": sp.isoformat(), "fut": fut, "lot": lot, "buy": b,
             "entry_at": bat.astimezone(gapwatch.IST).strftime("%Y-%m-%d %H:%M:%S"), "spot_buy": sb,
             "sell_day": sd.isoformat() if sd else None, "sell": s,
             "exit_at": sat.astimezone(gapwatch.IST).strftime("%Y-%m-%d %H:%M:%S") if sat else None, "spot_sell": ss,
             "closed": sd is not None}
        trades.append(t)
    open_ = [t for t in trades if not t["closed"]]
    if open_ and kite_auth.status().get("connected"):
        try:
            q = kite_auth.trading_client().ltp([f"NFO:{t['fut']}" for t in open_])
            for t in open_:
                t["ltp"] = (q.get(f"NFO:{t['fut']}") or {}).get("last_price")
        except Exception as error:
            print("Turn of the month paper: live price failed:", error)
    for t in trades:
        end = t["sell"] if t["closed"] else t.get("ltp")
        value = t["buy"] * t["lot"]
        t["contract_rs"] = round(value)
        if end:
            cost = cps * (value + end * t["lot"])
            t["pnl_rs"] = round((end - t["buy"]) * t["lot"], 2)
            t["cost_rs"] = round(cost, 2)
            t["net_rs"] = round(t["pnl_rs"] - cost, 2)
            t["net_pct"] = round(100 * t["net_rs"] / value, 3)
        else:
            t["pnl_rs"] = t["cost_rs"] = t["net_rs"] = t["net_pct"] = None
    closed = [t for t in trades if t["closed"] and t["net_rs"] is not None]
    plan = v2tom.plan(today, live=False)
    return {"plan": {k: plan.get(k) for k in ("buy", "sell", "state", "days_to_buy")}, "trades": trades,
            "open": open_, "closed": closed,
            "summary": {"trades": len(closed), "net_rs": round(sum(t["net_rs"] for t in closed), 2),
                        "win_rate": round(100 * sum(t["net_rs"] > 0 for t in closed) / len(closed), 1) if closed else None,
                        "open_net_rs": round(sum(t["net_rs"] or 0 for t in open_), 2) if open_ else None,
                        "capital_rs": max((t["contract_rs"] for t in trades), default=None),
                        "cost_per_side_bps": round(10000 * cps, 2)}}
