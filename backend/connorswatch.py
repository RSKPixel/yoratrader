"""Short-term mean reversion paper trading (Connors), two books side by side, recorded at the same
15:15 by gapwatch's production scheduler (record()):

- "rsi2" (the backtest page's book): 2-day RSI below 10 in a stock above its 200-day average, sold on
  its 5th trading day. Tables connors_paper / connors_paper_days.
- "cum" (Connors & Alvarez's cumulative RSI): today's + yesterday's 2-day RSI below 35 above the
  200-day average; sold on strength, at the first 15:15 its 2-day RSI is above 65, or on the 5th
  trading day at the latest. Tables connors_paper_cum / connors_paper_cum_days.

Each book has its own universe (F&O stocks or Nifty 50) and max open (1-10, set from its paper page,
read at each run); equal capital each, no stop. Each trade stores the slot count it was bought under,
so it counts 1/N of its net in the book.

At 15:15:01 every trading day, for each book: sell what is due at the price now; signal with the
backtest's own code (connors.live_signals: official closes to yesterday plus the price now as today's
close); buy the most extreme signals not already held into the free slots, at the price now. Each
trade also records the future it would be done in (the nearest one expiring at least 10 days after the
buy), bought and sold at the same moment. Nothing here places orders.
"""

import time
from datetime import timedelta
from datetime import time as clock

import pandas as pd

from psycopg2.extras import execute_values

import backtest
import connors
import gapwatch
import kite_auth
import xsmom
import xsmr
import db
import v2margin
from db import connect

MAX_OPEN, HOLD = 3, 5  # MAX_OPEN: the default; max_open() is what the scheduler uses
MAX_OPEN_LIMIT = 10
UNIVERSES = connors.DATASETS  # "fno" (F&O stocks, the default) or "stocks" (Nifty 50, all in F&O)
BOOKS = {
    "rsi2": {"label": "RSI(2) below 10, hold 5", "trades": "connors_paper", "days": "connors_paper_days",
             "max_key": "CONNORS_PAPER_MAX_OPEN", "uni_key": "CONNORS_PAPER_UNIVERSE", "exit": "hold", "max_days": HOLD,
             "variant": "rsi2-5d-max{n}-close"},
    "cum": {"label": "Cumulative RSI(2) below 35, out on strength", "trades": "connors_paper_cum", "days": "connors_paper_cum_days",
            "max_key": "CONNORS_PAPER_CUM_MAX_OPEN", "uni_key": "CONNORS_PAPER_CUM_UNIVERSE", "exit": "strength",
            "max_days": connors.STRENGTH_MAX_DAYS, "variant": "cumrsi2-0d-max{n}-close"},
}
MAX_OPEN_KEY = BOOKS["rsi2"]["max_key"]
UNIVERSE_KEY = BOOKS["rsi2"]["uni_key"]


def _book(book):
    if book not in BOOKS:
        raise ValueError(f"Unknown book: {book}")
    return BOOKS[book]


def universe(book="rsi2"):
    key = _book(book)["uni_key"]
    u = db.get_settings([key]).get(key, "fno")
    return u if u in UNIVERSES else "fno"


def set_universe(u, book="rsi2"):
    if u not in UNIVERSES:
        raise ValueError(f"Universe must be one of {', '.join(UNIVERSES)}.")
    db.set_settings({_book(book)["uni_key"]: u})
    return u


def max_open(book="rsi2"):
    key = _book(book)["max_key"]
    try:
        return min(MAX_OPEN_LIMIT, max(1, int(db.get_settings([key]).get(key, MAX_OPEN))))
    except (TypeError, ValueError):
        return MAX_OPEN


def set_max_open(n, book="rsi2"):
    n = int(n)
    if not 1 <= n <= MAX_OPEN_LIMIT:
        raise ValueError(f"Max open must be 1 to {MAX_OPEN_LIMIT}.")
    db.set_settings({_book(book)["max_key"]: str(n)})
    return n


def backtest_variant(n, book="rsi2"):
    return _book(book)["variant"].format(n=n)

RECORD_AT, RECORD_UNTIL = clock(15, 15), clock(15, 30)  # the scheduler wakes at hh:mm:01: 15:15:01
MIN_EXPIRY_DAYS = 10
STALE_DAYS = 6  # yesterday's closes must be stored (refreshed daily at 15:45)
_futures = {"day": None, "map": {}}



def _ensure_tables(cursor):
    for b in BOOKS.values():
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {b["trades"]} (
                symbol TEXT NOT NULL, buy_day DATE NOT NULL, buy_at TIMESTAMPTZ NOT NULL,
                rsi DOUBLE PRECISION NOT NULL, buy DOUBLE PRECISION NOT NULL,
                fut TEXT, fut_buy DOUBLE PRECISION,
                sell_day DATE, sell_at TIMESTAMPTZ, sell DOUBLE PRECISION, fut_sell DOUBLE PRECISION,
                PRIMARY KEY (symbol, buy_day)
            );
            CREATE TABLE IF NOT EXISTS {b["days"]} (
                day DATE PRIMARY KEY, recorded_at TIMESTAMPTZ NOT NULL,
                rankable INTEGER, above_average INTEGER, signals INTEGER, bought INTEGER, sold INTEGER,
                note TEXT
            );
            ALTER TABLE {b["trades"]} ADD COLUMN IF NOT EXISTS slots INTEGER NOT NULL DEFAULT 3;
            ALTER TABLE {b["trades"]} ADD COLUMN IF NOT EXISTS reason TEXT;  -- "time" / "strength"
            ALTER TABLE {b["days"]} ADD COLUMN IF NOT EXISTS universe TEXT;
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



def _note(book, today, stamp, note):
    t = _book(book)["days"]
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute(f"INSERT INTO {t} (day, recorded_at, note) VALUES (%s, %s, %s) "
                       "ON CONFLICT (day) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, note = EXCLUDED.note",
                       (today, stamp, note))
        conn.commit()


def record(force=False):
    """Both books at 15:15. Prices are taken once and shared."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or not (RECORD_AT <= now.time() < RECORD_UNTIL or force):
        return {"recorded": False, "reason": "not 15:15"}
    todo = []
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        for book, b in BOOKS.items():
            cursor.execute(f"SELECT 1 FROM {b['days']} WHERE day = %s", (today,))
            if not cursor.fetchone() or force:
                todo.append(book)
        if not todo:
            return {"recorded": False, "reason": "already recorded"}
        cursor.execute("SELECT max(day) FROM bt_daily WHERE day < %s AND symbol IN "
                       "(SELECT symbol FROM bt_symbols WHERE dataset = 'fno')", (today,))
        last = cursor.fetchone()[0]
    if last is None or (today - last).days > STALE_DAYS:
        note = f"daily closes not up to date (last {last})"
        for book in todo:
            _note(book, today, now, note)
        return {"recorded": False, "reason": note}

    kite = kite_auth.trading_client()
    quotes = gapwatch._quotes(kite, gapwatch._symbols())
    stamp = gapwatch._now()
    prices = {s: float(q["last_price"]) for s, q in quotes.items() if q.get("last_price")}
    # A weekday holiday (or a Muhurat-only day): Kite still returns the last prices. Trade only if most
    # stocks have traded today.
    traded_today = sum(1 for q in quotes.values() if q.get("last_trade_time") and q["last_trade_time"].date() == today)
    if traded_today < 0.5 * max(1, len(quotes)):
        note = f"market closed (only {traded_today} of {len(quotes)} stocks traded today)"
        for book in todo:
            _note(book, today, stamp, note)
        return {"recorded": False, "reason": note}
    futures = _futures_for(kite, today)
    live = {}
    out = {}
    for book in todo:
        uni = universe(book)
        if uni not in live:
            live[uni] = connors.live_signals(prices, today, uni)
        out[book] = _record_book(book, kite, today, stamp, prices, live[uni], uni, futures)
    return {"recorded": True, **out}


def _record_book(book, kite, today, stamp, prices, live, uni, futures):
    b = _book(book)
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute(f"SELECT symbol, buy_day, fut FROM {b['trades']} WHERE sell_day IS NULL")
        open_rows = cursor.fetchall()
        age = {(s, d): _trading_days_between(cursor, d, today) + 1 for s, d, _ in open_rows}
    rsi_now = live.get("rsi_all", {})
    to_sell = []
    for s, d, f in open_rows:
        if s not in prices:
            continue
        if age[(s, d)] >= b["max_days"]:
            to_sell.append((s, d, f, "time"))
        elif b["exit"] == "strength" and rsi_now.get(s) is not None and rsi_now[s] > connors.EXIT_RSI:
            to_sell.append((s, d, f, "strength"))
    held = {s for s, _, _ in open_rows} - {s for s, _, _, _ in to_sell}
    if b["exit"] == "strength":  # the cumulative-RSI book: today's + yesterday's 2-day RSI below 35, lowest first
        signals = sorted((x for x in live["stocks"] if x["signal_cum"] and x["symbol"] not in held), key=lambda x: x["cum"])
        score = "cum"
        n_signals = sum(x["signal_cum"] for x in live["stocks"])
    else:
        signals = [x for x in live["stocks"] if x["signal"] and x["symbol"] not in held]
        score = "rsi"
        n_signals = sum(x["signal"] for x in live["stocks"])
    slots = max_open(book)
    buys = signals[:max(0, slots - len(held))]
    fut_keys = {f"NFO:{f}" for _, _, f, _ in to_sell if f} | {f"NFO:{futures[x['symbol']][0]}" for x in buys if x["symbol"] in futures}
    fut_quotes = kite.quote(list(fut_keys)) if fut_keys else {}
    fut_price = lambda f: float(fut_quotes[f"NFO:{f}"]["last_price"]) if f and f"NFO:{f}" in fut_quotes else None

    with connect() as conn, conn.cursor() as cursor:
        for symbol, buy_day, fut, reason in to_sell:
            cursor.execute(f"UPDATE {b['trades']} SET sell_day = %s, sell_at = %s, sell = %s, fut_sell = %s, reason = %s "
                           "WHERE symbol = %s AND buy_day = %s",
                           (today, stamp, prices[symbol], fut_price(fut), reason, symbol, buy_day))
        rows = []
        for x in buys:
            fut = futures.get(x["symbol"], (None, None))[0]
            rows.append((x["symbol"], today, stamp, x[score], prices[x["symbol"]], fut, fut_price(fut), slots))
        if rows:
            execute_values(cursor, f"INSERT INTO {b['trades']} (symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, slots) VALUES %s "
                                   "ON CONFLICT (symbol, buy_day) DO NOTHING", rows)
        late = stamp.time() > clock(15, 20)
        cursor.execute(
            f"INSERT INTO {b['days']} (day, recorded_at, rankable, above_average, signals, bought, sold, note, universe) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, "
            "rankable = EXCLUDED.rankable, above_average = EXCLUDED.above_average, signals = EXCLUDED.signals, "
            "bought = EXCLUDED.bought, sold = EXCLUDED.sold, note = EXCLUDED.note, universe = EXCLUDED.universe",
            (today, stamp, live["rankable"], len(live["stocks"]), n_signals, len(rows),
             len(to_sell), f"prices taken at {stamp.time():%H:%M:%S}" + (" (late)" if late else ""), uni))
        conn.commit()
    return {"sold": len(to_sell), "bought": [x["symbol"] for x in buys], "signals": len(signals)}


_watch = {}
WATCH_TTL = 30


def watchlist(book="rsi2"):
    """Today's candidates for a book, live: every stock in its universe above its 200-day average (with
    the price now as today's close, as the 15:15 run computes it), its 2-day RSI, the cumulative (today's
    + yesterday's) and whether it signals for this book. Sorted most extreme first: the first free
    slots' worth would be bought if 15:15 were now. Cached 30 s."""
    b = _book(book)
    hit = _watch.get(book)
    if hit and time.time() - hit[0] < WATCH_TTL:
        return hit[1]
    now = gapwatch._now()
    today = now.date()
    uni = universe(book)
    cum = b["exit"] == "strength"
    out = {"book": book, "universe": uni, "at": now.strftime("%H:%M:%S"), "stocks": [], "rsi_max": connors.RSI_MAX,
           "cum_max": connors.CUM_RSI_MAX, "exit_rsi": connors.EXIT_RSI, "setup": "cumrsi2" if cum else "rsi2", "sma_days": connors.SMA_DAYS}
    if not kite_auth.status().get("connected"):
        out["note"] = "Kite not connected: no live prices"
        return out
    symbols = gapwatch._symbols()
    q = kite_auth.trading_client().ltp([f"NSE:{s}" for s in symbols])
    prices = {s: float(q[f"NSE:{s}"]["last_price"]) for s in symbols if q.get(f"NSE:{s}", {}).get("last_price")}
    live = connors.live_signals(prices, today, uni)
    if not live["stocks"]:
        out["note"] = "No session today (weekend or holiday): candidates are computed on trading days"
    else:
        closes = xsmom._closes(uni)
        last = closes[closes.index < pd.Timestamp(today)].iloc[-(connors.SMA_DAYS - 1):]
        stocks = sorted(live["stocks"], key=lambda x: x["cum"] if cum else x["rsi"])
        for x in stocks:
            s_ = x["symbol"]
            px, prev = prices.get(s_), last[s_].dropna().iloc[-1] if s_ in last and last[s_].notna().any() else None
            sma = (last[s_].sum() + px) / (last[s_].count() + 1) if px else None
            out["stocks"].append({**x, "signal": x["signal_cum"] if cum else x["signal"], "price": px,
                                  "prev_close": round(float(prev), 2) if prev else None,
                                  "change_pct": round(float(100 * (px / prev - 1)), 2) if px and prev else None,
                                  "sma200": round(float(sma), 2) if sma else None,
                                  "above_pct": round(float(100 * (px / sma - 1)), 2) if px and sma else None})
        out["above"] = len(live["stocks"])
        out["signals"] = sum(x["signal"] for x in out["stocks"])
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute(f"SELECT symbol FROM {b['trades']} WHERE sell_day IS NULL")
        out["held"] = [r[0] for r in cursor.fetchall()]
    if cum:  # what the held positions' RSI is now: above EXIT_RSI = sold on strength at 15:15
        out["held_rsi"] = {s: round(float(v), 1) for s, v in live.get("rsi_all", {}).items() if s in out["held"]}
    out["free_slots"] = max(0, max_open(book) - len(out["held"]))
    _watch[book] = (time.time(), out)
    return out


def _live_prices(out_open):
    """The open positions' last prices (stock and future) from Kite, when connected; returns the time."""
    if not out_open or not kite_auth.status().get("connected"):
        return None
    try:
        keys = [f"NSE:{t['symbol']}" for t in out_open] + [f"NFO:{t['fut']}" for t in out_open if t.get("fut")]
        q = kite_auth.trading_client().ltp(keys)
    except Exception as error:
        print("Short-term mean reversion paper: live prices failed:", error)
        return None
    for t in out_open:
        t["ltp"] = (q.get(f"NSE:{t['symbol']}") or {}).get("last_price")
        t["fut_ltp"] = (q.get(f"NFO:{t['fut']}") or {}).get("last_price") if t.get("fut") else None
    return gapwatch._now().strftime("%H:%M:%S")


def _lot_sizing(out_open, out_closed, cost, today):
    """One F&O lot a position (today's lots and margin rates), at the stock and at the futures prices:
    each trade gets stock_* and fut_* rupee fields; the result, for each price set, the capital
    required (the peak margin of the positions held on any day) and the closed trades' totals."""
    rows = v2margin.table()
    out = {"margins_as_of": v2margin.as_of(rows),
           "avg_lot_margin_rs": round(sum(r["margin"] for r in rows.values()) / len(rows)) if rows else None}
    for key, buy, sell, live in (("stock", "buy", "sell", "ltp"), ("fut", "fut_buy", "fut_sell", "fut_ltp")):
        held = []
        for t in out_open + out_closed:
            z = v2margin.size(rows, t["symbol"], "long", t.get(buy), t.get(sell) or t.get(live), cost)
            z["net_margin_pct"] = v2margin.margin_pct(z["net_rs"], z["margin_rs"])
            z["net_value_pct"] = v2margin.margin_pct(z["net_rs"], z["contract_rs"])
            t.update({f"{key}_{k}": v for k, v in z.items()})
            if z["margin_rs"]:
                held.append((t["buy_day"], t.get("sell_day") or "9999-12-31", z["margin_rs"], z["contract_rs"]))  # open: held to now
        # Sells come before buys at the same 15:15, so a day's holdings are those bought by it and not
        # yet sold on it; the capital required is the most margin held on any day.
        starts = {h[0] for h in held}
        peak = max((sum(h[2] for h in held if h[0] <= d < h[1]) for d in starts), default=0)
        peak_value = max((sum(h[3] for h in held if h[0] <= d < h[1]) for d in starts), default=0)
        closed = [t for t in out_closed if t.get(f"{key}_net_rs") is not None]
        net = sum(t[f"{key}_net_rs"] for t in closed)
        cost_rs = sum(t[f"{key}_cost_rs"] for t in closed)
        out[key] = {"capital_rs": round(peak), "value_rs": round(peak_value), "net_rs": round(net, 2), "cost_rs": round(cost_rs, 2),
                    "net_margin_pct": v2margin.margin_pct(net, peak), "net_value_pct": v2margin.margin_pct(net, peak_value),
                    "cost_value_pct": v2margin.margin_pct(cost_rs, peak_value), "trades": len(closed),
                    "win_rate": round(100 * sum(t[f"{key}_net_rs"] > 0 for t in closed) / len(closed), 1) if closed else None}
    return out


def paper(slippage=0.0002, book="rsi2"):
    """The log: open positions, closed trades (stock and futures, net of costs on both sides), the
    days, and totals. A position is 1/N of capital (N = the max open it was bought under), so a trade
    adds 1/N of its net to the book."""
    b = _book(book)
    cost = xsmr.cost_per_side(slippage)
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, sell_day, sell_at, sell, fut_sell, slots, reason "
                       f"FROM {b['trades']} ORDER BY buy_day DESC, symbol")
        trades = cursor.fetchall()
        cursor.execute("SELECT day, recorded_at, rankable, above_average, signals, bought, sold, note, universe "
                       f"FROM {b['days']} ORDER BY day DESC LIMIT 60")
        days = cursor.fetchall()
        today = gapwatch._now().date()
        open_days = {(t[0], t[1]): _trading_days_between(cursor, t[1], today) + 1 for t in trades if t[7] is None}
    out_open, out_closed = [], []
    for symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, sell_day, sell_at, sell, fut_sell, slots, reason in trades:
        row = {"symbol": symbol, "buy_day": buy_day.isoformat(), "buy_at": buy_at.astimezone(backtest.IST).strftime("%H:%M:%S"), "slots": slots,
               "rsi": round(rsi, 1), "buy": round(buy, 2), "fut": fut, "fut_buy": round(fut_buy, 2) if fut_buy else None}
        if sell_day is None:
            row["day_of_hold"] = min(open_days[(symbol, buy_day)], b["max_days"])
            out_open.append(row)
            continue
        gross = sell / buy - 1
        net = gross - cost * (1 + sell / buy)
        row.update({"sell_day": sell_day.isoformat(), "sell": round(sell, 2), "reason": reason or "time", "fut_sell": round(fut_sell, 2) if fut_sell else None,
                    "gross_pct": round(100 * gross, 2), "net_pct": round(100 * net, 2)})
        if fut_buy and fut_sell:
            fg = fut_sell / fut_buy - 1
            row.update({"fut_gross_pct": round(100 * fg, 2), "fut_net_pct": round(100 * (fg - cost * (1 + fut_sell / fut_buy)), 2)})
        out_closed.append(row)
    ltp_at = _live_prices(out_open)
    nets = [t["net_pct"] for t in out_closed]
    fnets = [t["fut_net_pct"] for t in out_closed if "fut_net_pct" in t]
    n = max_open(book)
    lots = _lot_sizing(out_open, out_closed, cost, today)
    summary = {"trades": len(out_closed), "open": len(out_open),
               "win_rate": round(100 * sum(n > 0 for n in nets) / len(nets), 1) if nets else None,
               "avg_net_pct": round(sum(nets) / len(nets), 2) if nets else None,
               "book_net_pct": round(sum(t["net_pct"] / t["slots"] for t in out_closed), 2),
               "fut_book_net_pct": round(sum(t["fut_net_pct"] / t["slots"] for t in out_closed if "fut_net_pct" in t), 2) if fnets else None,
               "cost_per_side_bps": round(10000 * cost, 2)}
    return {"open": out_open, "closed": out_closed, "summary": summary, "max_open": n, "max_open_limit": MAX_OPEN_LIMIT,
            "hold": b["max_days"], "exit": b["exit"], "exit_rsi": connors.EXIT_RSI, "book": book, "book_label": b["label"],
            "universe": universe(book), "universes": list(UNIVERSES), "lots": lots, "ltp_at": ltp_at,
            "backtest_variant": backtest_variant(n, book),
            "days": [{"day": d.isoformat(), "recorded_at": r.astimezone(backtest.IST).strftime("%H:%M:%S"), "rankable": rk,
                      "above_average": aa, "signals": sg, "bought": bo, "sold": so, "note": nt, "universe": un}
                     for d, r, rk, aa, sg, bo, so, nt, un in days]}
