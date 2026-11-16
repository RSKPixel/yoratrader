"""Short-term mean reversion paper trading (Connors & Sen; the backtest page's defaults): 2-day RSI
below 10 in an F&O stock (or a Nifty 50 one: the universe setting) above its 200-day average, hold 5 trading days, at most N open (3 by
default; set from the paper page, read at each run), equal capital each, no stop. Each trade stores
the slot count it was bought under, so it counts 1/N of its net in the book.

record() runs once each trading day at 15:15:01, from gapwatch's production scheduler:
1. Sell every position on its 5th trading day at the price now.
2. Signal: the backtest's own code (connors.live_signals) on official closes to yesterday plus the
   price now as today's close.
3. Buy the most oversold signals not already held, into the free slots, at the price now.

Prices are the stocks' last traded prices. Each trade also records the future it would be done in
(the nearest one expiring at least 10 days after the buy, so the 5-day hold doesn't cross expiry),
bought and sold at the same moment, so the log shows what futures would have made. Nothing here
places orders. The backtest ("rsi2-5d-max3-close") trades at the official close; live, 15:15 is
the closest tradable moment (within a few points a year of the close from 2015).
"""

from datetime import timedelta
from datetime import time as clock

from psycopg2.extras import execute_values

import backtest
import connors
import gapwatch
import kite_auth
import xsmr
import db
import v2margin
from db import connect

MAX_OPEN, HOLD = 3, 5  # MAX_OPEN: the default; max_open() is what the scheduler uses
MAX_OPEN_LIMIT = 10
MAX_OPEN_KEY = "CONNORS_PAPER_MAX_OPEN"
UNIVERSE_KEY = "CONNORS_PAPER_UNIVERSE"
UNIVERSES = connors.DATASETS  # "fno" (F&O stocks, the default) or "stocks" (Nifty 50, all in F&O)


def universe():
    u = db.get_settings([UNIVERSE_KEY]).get(UNIVERSE_KEY, "fno")
    return u if u in UNIVERSES else "fno"


def set_universe(u):
    if u not in UNIVERSES:
        raise ValueError(f"Universe must be one of {', '.join(UNIVERSES)}.")
    db.set_settings({UNIVERSE_KEY: u})
    return u


def max_open():
    try:
        return min(MAX_OPEN_LIMIT, max(1, int(db.get_settings([MAX_OPEN_KEY]).get(MAX_OPEN_KEY, MAX_OPEN))))
    except (TypeError, ValueError):
        return MAX_OPEN


def set_max_open(n):
    n = int(n)
    if not 1 <= n <= MAX_OPEN_LIMIT:
        raise ValueError(f"Max open must be 1 to {MAX_OPEN_LIMIT}.")
    db.set_settings({MAX_OPEN_KEY: str(n)})
    return n


def backtest_variant(n):
    return f"rsi2-5d-max{n}-close"
RECORD_AT, RECORD_UNTIL = clock(15, 15), clock(15, 30)  # the scheduler wakes at hh:mm:01: 15:15:01
MIN_EXPIRY_DAYS = 10
STALE_DAYS = 6  # yesterday's closes must be stored (refreshed daily at 15:45)
_futures = {"day": None, "map": {}}


def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS connors_paper (
            symbol TEXT NOT NULL, buy_day DATE NOT NULL, buy_at TIMESTAMPTZ NOT NULL,
            rsi DOUBLE PRECISION NOT NULL, buy DOUBLE PRECISION NOT NULL,
            fut TEXT, fut_buy DOUBLE PRECISION,
            sell_day DATE, sell_at TIMESTAMPTZ, sell DOUBLE PRECISION, fut_sell DOUBLE PRECISION,
            PRIMARY KEY (symbol, buy_day)
        );
        CREATE TABLE IF NOT EXISTS connors_paper_days (
            day DATE PRIMARY KEY, recorded_at TIMESTAMPTZ NOT NULL,
            rankable INTEGER, above_average INTEGER, signals INTEGER, bought INTEGER, sold INTEGER,
            note TEXT
        );
        ALTER TABLE connors_paper ADD COLUMN IF NOT EXISTS slots INTEGER NOT NULL DEFAULT 3;
        ALTER TABLE connors_paper_days ADD COLUMN IF NOT EXISTS universe TEXT;
        """
    )


def _futures_for(kite, today):
    """{stock: (future tradingsymbol, expiry)}: the nearest future expiring at least MIN_EXPIRY_DAYS on."""
    if _futures["day"] != today:
        stocks = set(gapwatch._symbols())
        best = {}
        for r in kite.instruments("NFO"):
            if r["instrument_type"] != "FUT" or r["name"] not in stocks or r["expiry"] < today + timedelta(days=MIN_EXPIRY_DAYS):
                continue
            if r["name"] not in best or r["expiry"] < best[r["name"]]["expiry"]:
                best[r["name"]] = r
        _futures["day"], _futures["map"] = today, {k: (v["tradingsymbol"], v["expiry"]) for k, v in best.items()}
    return _futures["map"]


def _trading_days_between(cursor, after, before):
    """Regular sessions strictly between two days. Weekend special sessions (Muhurat trading, an
    evening hour) and sparse ones aren't counted: there's no 15:15 to trade in them."""
    cursor.execute("SELECT count(*) FROM (SELECT day FROM bt_daily WHERE day > %s AND day < %s "
                   "AND extract(isodow FROM day) < 6 GROUP BY day HAVING count(*) >= 50) x", (after, before))
    return cursor.fetchone()[0]


def record(force=False):
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or not (RECORD_AT <= now.time() < RECORD_UNTIL or force):
        return {"recorded": False, "reason": "not 15:15"}
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT 1 FROM connors_paper_days WHERE day = %s", (today,))
        if cursor.fetchone() and not force:
            return {"recorded": False, "reason": "already recorded"}
        cursor.execute("SELECT max(day) FROM bt_daily WHERE day < %s AND symbol IN "
                       "(SELECT symbol FROM bt_symbols WHERE dataset = 'fno')", (today,))
        last = cursor.fetchone()[0]
        if last is None or (today - last).days > STALE_DAYS:
            note = f"daily closes not up to date (last {last})"
            cursor.execute("INSERT INTO connors_paper_days (day, recorded_at, note) VALUES (%s, %s, %s) "
                           "ON CONFLICT (day) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, note = EXCLUDED.note",
                           (today, now, note))
            conn.commit()
            return {"recorded": False, "reason": note}
        cursor.execute("SELECT symbol, buy_day, fut FROM connors_paper WHERE sell_day IS NULL")
        open_rows = cursor.fetchall()

    kite = kite_auth.trading_client()
    quotes = gapwatch._quotes(kite, gapwatch._symbols())
    stamp = gapwatch._now()
    prices = {s: float(q["last_price"]) for s, q in quotes.items() if q.get("last_price")}
    # A weekday holiday (or a Muhurat-only day): Kite still returns the last prices. Trade only if most
    # stocks have traded today.
    traded_today = sum(1 for q in quotes.values() if q.get("last_trade_time") and q["last_trade_time"].date() == today)
    if traded_today < 0.5 * max(1, len(quotes)):
        note = f"market closed (only {traded_today} of {len(quotes)} stocks traded today)"
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO connors_paper_days (day, recorded_at, note) VALUES (%s, %s, %s) "
                           "ON CONFLICT (day) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, note = EXCLUDED.note",
                           (today, stamp, note))
            conn.commit()
        return {"recorded": False, "reason": note}

    with connect() as conn, conn.cursor() as cursor:
        to_sell = [(s, b, f) for s, b, f in open_rows if _trading_days_between(cursor, b, today) + 1 >= HOLD and s in prices]
    held = {s for s, _, _ in open_rows} - {s for s, _, _ in to_sell}
    uni = universe()
    live = connors.live_signals(prices, today, uni)
    signals = [x for x in live["stocks"] if x["signal"] and x["symbol"] not in held]
    slots = max_open()
    buys = signals[:max(0, slots - len(held))]
    futures = _futures_for(kite, today)
    fut_keys = {f"NFO:{f}" for _, _, f in to_sell if f} | {f"NFO:{futures[b['symbol']][0]}" for b in buys if b["symbol"] in futures}
    fut_quotes = kite.quote(list(fut_keys)) if fut_keys else {}
    fut_price = lambda f: float(fut_quotes[f"NFO:{f}"]["last_price"]) if f and f"NFO:{f}" in fut_quotes else None

    with connect() as conn, conn.cursor() as cursor:
        for symbol, buy_day, fut in to_sell:
            cursor.execute("UPDATE connors_paper SET sell_day = %s, sell_at = %s, sell = %s, fut_sell = %s "
                           "WHERE symbol = %s AND buy_day = %s", (today, stamp, prices[symbol], fut_price(fut), symbol, buy_day))
        rows = []
        for b in buys:
            fut = futures.get(b["symbol"], (None, None))[0]
            rows.append((b["symbol"], today, stamp, b["rsi"], prices[b["symbol"]], fut, fut_price(fut), slots))
        if rows:
            execute_values(cursor, "INSERT INTO connors_paper (symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, slots) VALUES %s "
                                   "ON CONFLICT (symbol, buy_day) DO NOTHING", rows)
        late = stamp.time() > clock(15, 20)
        cursor.execute(
            "INSERT INTO connors_paper_days (day, recorded_at, rankable, above_average, signals, bought, sold, note, universe) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, "
            "rankable = EXCLUDED.rankable, above_average = EXCLUDED.above_average, signals = EXCLUDED.signals, "
            "bought = EXCLUDED.bought, sold = EXCLUDED.sold, note = EXCLUDED.note, universe = EXCLUDED.universe",
            (today, stamp, live["rankable"], len(live["stocks"]), sum(x["signal"] for x in live["stocks"]), len(rows),
             len(to_sell), f"prices taken at {stamp.time():%H:%M:%S}" + (" (late)" if late else ""), uni))
        conn.commit()
    return {"recorded": True, "sold": len(to_sell), "bought": [b["symbol"] for b in buys], "signals": len(signals)}


def _lot_sizing(out_open, out_closed, cost, today):
    """One F&O lot a position (today's lots and margin rates), at the stock and at the futures prices:
    each trade gets stock_* and fut_* rupee fields; the result, for each price set, the capital
    required (the peak margin of the positions held on any day) and the closed trades' totals."""
    rows = v2margin.table()
    out = {"margins_as_of": v2margin.as_of(rows),
           "avg_lot_margin_rs": round(sum(r["margin"] for r in rows.values()) / len(rows)) if rows else None}
    for key, buy, sell in (("stock", "buy", "sell"), ("fut", "fut_buy", "fut_sell")):
        held = []
        for t in out_open + out_closed:
            z = v2margin.size(rows, t["symbol"], "long", t.get(buy), t.get(sell), cost)
            z["net_margin_pct"] = v2margin.margin_pct(z["net_rs"], z["margin_rs"])
            t.update({f"{key}_{k}": v for k, v in z.items()})
            if z["margin_rs"]:
                held.append((t["buy_day"], t.get("sell_day") or "9999-12-31", z["margin_rs"]))  # open: held to now
        # Sells come before buys at the same 15:15, so a day's holdings are those bought by it and not
        # yet sold on it; the capital required is the most margin held on any day.
        peak = max((sum(m for b, e, m in held if b <= d < e) for d in {b for b, _, _ in held}), default=0)
        closed = [t for t in out_closed if t.get(f"{key}_net_rs") is not None]
        net = sum(t[f"{key}_net_rs"] for t in closed)
        out[key] = {"capital_rs": round(peak), "net_rs": round(net, 2), "cost_rs": round(sum(t[f"{key}_cost_rs"] for t in closed), 2),
                    "net_margin_pct": v2margin.margin_pct(net, peak), "trades": len(closed),
                    "win_rate": round(100 * sum(t[f"{key}_net_rs"] > 0 for t in closed) / len(closed), 1) if closed else None}
    return out


def paper(slippage=0.0002):
    """The log: open positions, closed trades (stock and futures, net of costs on both sides), the
    days, and totals. A position is 1/N of capital (N = the max open it was bought under), so a trade
    adds 1/N of its net to the book."""
    cost = xsmr.cost_per_side(slippage)
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, sell_day, sell_at, sell, fut_sell, slots "
                       "FROM connors_paper ORDER BY buy_day DESC, symbol")
        trades = cursor.fetchall()
        cursor.execute("SELECT day, recorded_at, rankable, above_average, signals, bought, sold, note, universe "
                       "FROM connors_paper_days ORDER BY day DESC LIMIT 60")
        days = cursor.fetchall()
        today = gapwatch._now().date()
        open_days = {(t[0], t[1]): _trading_days_between(cursor, t[1], today) + 1 for t in trades if t[7] is None}
    out_open, out_closed = [], []
    for symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, sell_day, sell_at, sell, fut_sell, slots in trades:
        row = {"symbol": symbol, "buy_day": buy_day.isoformat(), "buy_at": buy_at.astimezone(backtest.IST).strftime("%H:%M:%S"), "slots": slots,
               "rsi": round(rsi, 1), "buy": round(buy, 2), "fut": fut, "fut_buy": round(fut_buy, 2) if fut_buy else None}
        if sell_day is None:
            row["day_of_hold"] = min(open_days[(symbol, buy_day)], HOLD)
            out_open.append(row)
            continue
        gross = sell / buy - 1
        net = gross - cost * (1 + sell / buy)
        row.update({"sell_day": sell_day.isoformat(), "sell": round(sell, 2), "fut_sell": round(fut_sell, 2) if fut_sell else None,
                    "gross_pct": round(100 * gross, 2), "net_pct": round(100 * net, 2)})
        if fut_buy and fut_sell:
            fg = fut_sell / fut_buy - 1
            row.update({"fut_gross_pct": round(100 * fg, 2), "fut_net_pct": round(100 * (fg - cost * (1 + fut_sell / fut_buy)), 2)})
        out_closed.append(row)
    nets = [t["net_pct"] for t in out_closed]
    fnets = [t["fut_net_pct"] for t in out_closed if "fut_net_pct" in t]
    n = max_open()
    lots = _lot_sizing(out_open, out_closed, cost, today)
    summary = {"trades": len(out_closed), "open": len(out_open),
               "win_rate": round(100 * sum(n > 0 for n in nets) / len(nets), 1) if nets else None,
               "avg_net_pct": round(sum(nets) / len(nets), 2) if nets else None,
               "book_net_pct": round(sum(t["net_pct"] / t["slots"] for t in out_closed), 2),
               "fut_book_net_pct": round(sum(t["fut_net_pct"] / t["slots"] for t in out_closed if "fut_net_pct" in t), 2) if fnets else None,
               "cost_per_side_bps": round(10000 * cost, 2)}
    return {"open": out_open, "closed": out_closed, "summary": summary, "max_open": n, "max_open_limit": MAX_OPEN_LIMIT, "hold": HOLD,
            "universe": universe(), "universes": list(UNIVERSES), "lots": lots,
            "backtest_variant": backtest_variant(n),
            "days": [{"day": d.isoformat(), "recorded_at": r.astimezone(backtest.IST).strftime("%H:%M:%S"), "rankable": rk,
                      "above_average": aa, "signals": sg, "bought": bo, "sold": so, "note": nt, "universe": un}
                     for d, r, rk, aa, sg, bo, so, nt, un in days]}
