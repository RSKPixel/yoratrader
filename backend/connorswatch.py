"""Short-term mean reversion paper trading (Connors), two books side by side, recorded at the same
15:15 by gapwatch's production scheduler (record()):

- "rsi2" (the backtest page's book): 2-day RSI below 10 in a stock above its 200-day average.
  Tables connors_paper / connors_paper_days.
- "cum" (Connors & Alvarez's cumulative RSI): today's + yesterday's 2-day RSI below 35 above the
  200-day average. Tables connors_paper_cum / connors_paper_cum_days.

Each book's exit is a setting (exit_mode, from its paper page): sold on the 5th trading day ("hold",
rsi2's default), or on strength, at the first 15:15 its 2-day RSI is above 65, the 5th trading day at
the latest ("strength", cum's default).

Each book trades F&O stocks (the Nifty 50 universe is off) and has its own max open (1-10, set from its paper page,
read at each run); equal capital each, no stop. Each trade stores the slot count it was bought under,
so it counts 1/N of its net in the book.

At 15:15:01 every trading day, for each book: sell what is due at the price now; signal with the
backtest's own code (connors.live_signals: official closes to yesterday plus the price now as today's
close); buy the most extreme signals not already held into the free slots, at the price now. Each
trade also records the future it would be done in (the nearest one expiring at least 10 days after the
buy), bought and sold at the same moment. Nothing here places orders.
"""

import time
from datetime import datetime, timedelta
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
from db import connect, schema_once

MAX_OPEN, HOLD = 3, 5  # MAX_OPEN: the default; max_open() is what the scheduler uses
MAX_OPEN_LIMIT = 10
UNIVERSES = ("fno",)  # F&O stocks only: the Nifty 50 universe is switched off for both books
BOOKS = {
    "rsi2": {"label": "RSI(2) below 10", "setup": "rsi2", "trades": "connors_paper", "days": "connors_paper_days",
             "max_key": "CONNORS_PAPER_MAX_OPEN", "uni_key": "CONNORS_PAPER_UNIVERSE", "exit_key": "CONNORS_PAPER_EXIT", "exit": "hold",
             "price_key": "CONNORS_PAPER_PRICE", "at_key": "CONNORS_PAPER_TRADE_AT", "dis_key": "CONNORS_PAPER_DISASTER",
             "cap_key": "CONNORS_PAPER_CAPITAL"},
    "cum": {"label": "Cumulative RSI(2) below 35", "setup": "cumrsi2", "trades": "connors_paper_cum", "days": "connors_paper_cum_days",
            "max_key": "CONNORS_PAPER_CUM_MAX_OPEN", "uni_key": "CONNORS_PAPER_CUM_UNIVERSE", "exit_key": "CONNORS_PAPER_CUM_EXIT", "exit": "strength",
            "price_key": "CONNORS_PAPER_CUM_PRICE", "at_key": "CONNORS_PAPER_CUM_TRADE_AT", "dis_key": "CONNORS_PAPER_CUM_DISASTER",
            "cap_key": "CONNORS_PAPER_CUM_CAPITAL"},
}
# The setup is fixed per book; the exit is a setting (each book's "exit" above is its default):
# "hold": sold on the 5th trading day; "strength": at the first 15:15 the 2-day RSI is above 65, the 5th day at the latest.
EXITS = ("hold", "strength")
MAX_DAYS = HOLD  # both exits: out on the 5th trading day at the latest (connors.STRENGTH_MAX_DAYS is also 5)
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


def exit_mode(book="rsi2"):
    b = _book(book)
    e = db.get_settings([b["exit_key"]]).get(b["exit_key"], b["exit"])
    return e if e in EXITS else b["exit"]


def set_exit_mode(e, book="rsi2"):
    if e not in EXITS:
        raise ValueError(f"Exit must be one of {', '.join(EXITS)}.")
    db.set_settings({_book(book)["exit_key"]: e})
    return e


# Prices (a setting per book, for new buys; each trade keeps the one it was bought under):
# "spot": the signal from the share's closes and the share's price now, the trade judged on the share's prices;
# "futures": the signal from the roll-adjusted futures closes and the future's price now (connors.live_signals_fut),
# the trade judged on its future's prices. Both prices are recorded on every trade either way.
PRICES = ("spot", "futures")


def price(book="rsi2"):
    k = _book(book)["price_key"]
    v = db.get_settings([k]).get(k, "spot")
    return v if v in PRICES else "spot"


def set_price(v, book="rsi2"):
    if v not in PRICES:
        raise ValueError("Prices must be spot or futures.")
    db.set_settings({_book(book)["price_key"]: v})
    return v


# Trade at (a setting per book, read by the runs): "close": the 15:15 run decides and trades at the price then
# (the closest live stand-in for the close); "nextopen": decided after the close on the official closes
# (decide(), from DECIDE_AT), stored as orders, and filled at the next session's open (execute_orders(), 09:15:01).
# "closeopen": the 15:15 run buys at the price then, and its sales (the exit chosen) are queued as orders for the
# next session's open (execute_orders).
TRADE_ATS = ("close", "nextopen", "closeopen")
DISASTERS = ("off", "on")  # the 10% disaster stop (disaster.py) on new buys: out 10% under the buy if the day's low reaches it
DECIDE_AT = clock(16, 15)  # after the official closes are stored (spot 15:45, futures 15:50)


def _setting(book, key, allowed, default):
    k = _book(book)[key]
    v = db.get_settings([k]).get(k, default)
    return v if v in allowed else default


def trade_at(book="rsi2"):
    return _setting(book, "at_key", TRADE_ATS, "close")


def set_trade_at(v, book="rsi2"):
    if v not in TRADE_ATS:
        raise ValueError("Trade at must be close, nextopen or closeopen.")
    db.set_settings({_book(book)["at_key"]: v})
    return v


def disaster(book="rsi2"):
    return _setting(book, "dis_key", DISASTERS, "off")


def set_disaster(v, book="rsi2"):
    if v not in DISASTERS:
        raise ValueError("Disaster stop must be on or off.")
    db.set_settings({_book(book)["dis_key"]: v})
    return v


CAPITAL_DEFAULT, CAPITAL_MIN, CAPITAL_MAX = 2_500_000, 50_000, 100_000_000


def capital(book="rsi2"):
    """The capital of a spot book (a setting): each spot position is capital / max open (the max open it was
    bought under), in whole shares. Futures positions stay one lot each."""
    k = _book(book)["cap_key"]
    try:
        return min(CAPITAL_MAX, max(CAPITAL_MIN, int(float(db.get_settings([k]).get(k, CAPITAL_DEFAULT)))))
    except (TypeError, ValueError):
        return CAPITAL_DEFAULT


def set_capital(v, book="rsi2"):
    v = int(float(v))
    if not CAPITAL_MIN <= v <= CAPITAL_MAX:
        raise ValueError(f"Capital must be between {CAPITAL_MIN:,} and {CAPITAL_MAX:,}.")
    db.set_settings({_book(book)["cap_key"]: str(v)})
    return v


def _spot_size(cap, slots, entry, exit_px, cps):
    """A spot position: capital / slots in whole shares, delivery (cash: the full value is the capital used)."""
    if not entry or not slots:
        return {"lot": None, "qty": None, "contract_rs": None, "margin_rs": None, "pnl_rs": None, "cost_rs": None, "net_rs": None}
    qty = int(cap / slots // entry)
    value = qty * entry
    out = {"lot": None, "qty": qty, "contract_rs": round(value), "margin_rs": round(value), "pnl_rs": None,
           "cost_rs": round(cps * value * 2), "net_rs": None}
    if exit_px and qty:
        pnl, cost = qty * (exit_px - entry), cps * qty * (entry + exit_px)
        out.update(pnl_rs=round(pnl, 2), cost_rs=round(cost, 2), net_rs=round(pnl - cost, 2))
    return out


def backtest_variant(n, book="rsi2"):
    return (f"{_book(book)['setup']}-{'0d' if exit_mode(book) == 'strength' else '5d'}-max{n}"
            f"{'-10pc' if disaster(book) == 'on' else ''}-{trade_at(book)}")

RECORD_AT, RECORD_UNTIL = clock(15, 15), clock(15, 30)  # the scheduler wakes at hh:mm:01: 15:15:01
MIN_EXPIRY_DAYS = 10
STALE_DAYS = 6  # yesterday's closes must be stored (refreshed daily at 15:45)
_futures = {"day": None, "map": {}}



@schema_once
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
            -- "spot" / "futures": the prices the trade was picked and is judged on (NULL: before the setting, spot)
            ALTER TABLE {b["trades"]} ADD COLUMN IF NOT EXISTS priced TEXT;
            ALTER TABLE {b["trades"]} ADD COLUMN IF NOT EXISTS trade_at TEXT;  -- "close" / "nextopen" (NULL: close)
            ALTER TABLE {b["trades"]} ADD COLUMN IF NOT EXISTS stop DOUBLE PRECISION;  -- the disaster stop, on the trade's own prices
            -- Next open: what the after-close run decided, filled at the next session's open
            CREATE TABLE IF NOT EXISTS {b["trades"]}_orders (
                day DATE NOT NULL, symbol TEXT NOT NULL, action TEXT NOT NULL, rsi DOUBLE PRECISION, reason TEXT,
                priced TEXT, slots INTEGER, buy_day DATE, done_day DATE, note TEXT,
                PRIMARY KEY (day, symbol, action)
            );
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
            if trade_at(book) == "nextopen":
                continue  # next open: decided after the close (decide), filled at the next open (execute_orders)
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
        uni, pr = universe(book), price(book)
        if (uni, pr) not in live:
            live[(uni, pr)] = connors.live_signals_fut(_fut_moves(kite, futures), today, uni) if pr == "futures" \
                else connors.live_signals(prices, today, uni)
        out[book] = _record_book(book, kite, today, stamp, prices, live[(uni, pr)], uni, futures, pr, spot_q=quotes)
    return {"recorded": True, **out}


def _fut_moves(kite, futures):
    """{stock: its future's price now / that contract's previous close}: today's move for the futures signal."""
    keys = [f"NFO:{f}" for f, _ in futures.values()]
    q = {}
    for i in range(0, len(keys), 400):
        q.update(kite.quote(keys[i:i + 400]))
    out = {}
    for s_, (f, _) in futures.items():
        x = q.get(f"NFO:{f}") or {}
        prev, last = (x.get("ohlc") or {}).get("close"), x.get("last_price")
        if prev and last:
            out[s_] = float(last) / float(prev)
    return out


def _ohlc(q):
    o = q.get("ohlc") or {}
    return o.get("open"), o.get("low")


def _disaster(open_rows, spot_q, fut_q, today, skip_today=False):
    """{(symbol, buy_day): (exit price on the trade's own prices, reason)} for open trades with a disaster stop
    whose day reached it: an open at or below it sells at the open ("stop (gap)"), else a low at or below it at
    the stop. spot_q: {symbol: quote}, fut_q: {future: quote} (today's ohlc). skip_today: a trade bought at
    today's open isn't checked on its buy day (as the backtest's next-open version)."""
    out = {}
    for s_, d, f, priced, stop in open_rows:
        if stop is None or (skip_today and d == today):
            continue
        q = fut_q.get(f) if priced == "futures" else spot_q.get(s_)
        if not q:
            continue
        o, lo = _ohlc(q)
        if o and o <= stop:
            out[(s_, d)] = (float(o), "stop (gap)")
        elif lo and lo <= stop:
            out[(s_, d)] = (float(stop), "stop")
    return out


def _choose(book, open_rows, age, live, hit):
    """What a book does at a decision: sales (disaster stop hits, the time exit, the exit on strength) and the
    buys into the free slots (most extreme signals not held). Returns (sales [(symbol, buy_day, fut, reason)],
    buys, signals, n_signals, score)."""
    b = _book(book)
    rsi_now = live.get("rsi_all", {})
    to_sell = []
    for s_, d, f, _, _ in open_rows:
        if (s_, d) in hit:
            continue
        if age[(s_, d)] >= MAX_DAYS:
            to_sell.append((s_, d, f, "time"))
        elif exit_mode(book) == "strength" and rsi_now.get(s_) is not None and rsi_now[s_] > connors.EXIT_RSI:
            to_sell.append((s_, d, f, "strength"))
    held = {r[0] for r in open_rows} - {x[0] for x in to_sell} - {k[0] for k in hit}
    if b["setup"] == "cumrsi2":  # the cumulative-RSI book: today's + yesterday's 2-day RSI below 35, lowest first
        signals = sorted((x for x in live["stocks"] if x["signal_cum"] and x["symbol"] not in held), key=lambda x: x["cum"])
        score, n_signals = "cum", sum(x["signal_cum"] for x in live["stocks"])
    else:
        signals = [x for x in live["stocks"] if x["signal"] and x["symbol"] not in held]
        score, n_signals = "rsi", sum(x["signal"] for x in live["stocks"])
    buys = signals[:max(0, max_open(book) - len(held))]
    return to_sell, buys, signals, n_signals, score


def _open_rows(cursor, b):
    cursor.execute(f"SELECT symbol, buy_day, fut, COALESCE(priced, 'spot'), stop FROM {b['trades']} WHERE sell_day IS NULL")
    return cursor.fetchall()


def _stop_for(price):
    return price * (1 - disaster_pct()) if price else None


def disaster_pct():
    import disaster as ds
    return ds.PCT / 100


def _day_row(cursor, b, today, stamp, live, n_signals, bought, sold, note, uni):
    cursor.execute(
        f"INSERT INTO {b['days']} (day, recorded_at, rankable, above_average, signals, bought, sold, note, universe) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day) DO UPDATE SET recorded_at = EXCLUDED.recorded_at, "
        "rankable = EXCLUDED.rankable, above_average = EXCLUDED.above_average, signals = EXCLUDED.signals, "
        "bought = EXCLUDED.bought, sold = EXCLUDED.sold, note = EXCLUDED.note, universe = EXCLUDED.universe",
        (today, stamp, live["rankable"], len(live["stocks"]), n_signals, bought, sold, note, uni))


def _record_book(book, kite, today, stamp, prices, live, uni, futures, pr="spot", spot_q=None):
    """At close (the 15:15 run): disaster stops, sales and buys, all at the price now."""
    b = _book(book)
    with connect() as conn, conn.cursor() as cursor:
        open_rows = _open_rows(cursor, b)
        age = {(s_, d): _trading_days_between(cursor, d, today) + 1 for s_, d, *_ in open_rows}
    fut_keys = {f"NFO:{r[2]}" for r in open_rows if r[2]} | {f"NFO:{f}" for f, _ in futures.values()}
    fq = {}
    keys = sorted(fut_keys)
    for i in range(0, len(keys), 400):
        fq.update(kite.quote(keys[i:i + 400]))
    fut_q = {k.split(":", 1)[1]: v for k, v in fq.items()}
    fut_price = lambda f: float(fut_q[f]["last_price"]) if f and f in fut_q and fut_q[f].get("last_price") else None
    hit = _disaster(open_rows, spot_q or {}, fut_q, today)
    to_sell, buys, signals, n_signals, score = _choose(book, open_rows, age, live, hit)
    on = disaster(book) == "on"
    mode = trade_at(book)
    with connect() as conn, conn.cursor() as cursor:
        if mode == "closeopen":  # the sales wait for the next open; the buys happen now
            if to_sell:
                execute_values(cursor, f"INSERT INTO {b['trades']}_orders (day, symbol, action, rsi, reason, priced, slots, buy_day) "
                                       "VALUES %s ON CONFLICT DO NOTHING",
                               [(today, s_, "sell", None, reason, None, None, d) for s_, d, _, reason in to_sell])
            queued, to_sell = to_sell, []
        else:
            queued = []
        for (symbol, buy_day), (px, reason) in hit.items():
            row = next(r for r in open_rows if r[0] == symbol and r[1] == buy_day)
            fut = row[2]
            spot_px, fut_px = (prices.get(symbol), px) if row[3] == "futures" else (px, fut_price(fut))
            cursor.execute(f"UPDATE {b['trades']} SET sell_day = %s, sell_at = %s, sell = %s, fut_sell = %s, reason = %s "
                           "WHERE symbol = %s AND buy_day = %s", (today, stamp, spot_px, fut_px, reason, symbol, buy_day))
        for symbol, buy_day, fut, reason in to_sell:
            if symbol not in prices:
                continue
            cursor.execute(f"UPDATE {b['trades']} SET sell_day = %s, sell_at = %s, sell = %s, fut_sell = %s, reason = %s "
                           "WHERE symbol = %s AND buy_day = %s",
                           (today, stamp, prices[symbol], fut_price(fut), reason, symbol, buy_day))
        rows = []
        slots = max_open(book)
        for x in buys:
            fut = futures.get(x["symbol"], (None, None))[0]
            if pr == "futures" and fut_price(fut) is None:
                continue  # judged on the future: no future price, no trade
            if x["symbol"] not in prices:
                continue
            own = fut_price(fut) if pr == "futures" else prices[x["symbol"]]
            rows.append((x["symbol"], today, stamp, x[score], prices[x["symbol"]], fut, fut_price(fut), slots, pr, mode,
                         _stop_for(own) if on else None))
        if rows:
            execute_values(cursor, f"INSERT INTO {b['trades']} (symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, slots, priced, "
                                   "trade_at, stop) VALUES %s ON CONFLICT (symbol, buy_day) DO NOTHING", rows)
        late = stamp.time() > clock(15, 20)
        _day_row(cursor, b, today, stamp, live, n_signals, len(rows), len(to_sell) + len(hit),
                 f"prices taken at {stamp.time():%H:%M:%S}" + (" (late)" if late else "")
                 + (f"; {len(queued)} to sell at the next open" if queued else ""), uni)
        conn.commit()
    return {"sold": len(to_sell), "to_sell_next_open": [x[0] for x in queued], "stopped": len(hit),
            "bought": [x["symbol"] for x in buys], "signals": len(signals)}


def decide(force=False):
    """Next open books, after the close (from DECIDE_AT, once the day's official closes are stored): the signal
    on the official closes; disaster stops from the day's low (sold at the stop that day); the time exit and the
    exit on strength, and the buys into the free slots, stored as orders for the next session's open."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or (now.time() < DECIDE_AT and not force):
        return {"decided": False, "reason": "not after the close"}
    books = [bk for bk in BOOKS if trade_at(bk) == "nextopen"]
    if not books:
        return {"decided": False, "reason": "no next-open book"}
    out = {}
    kite = None
    for book in books:
        b = _book(book)
        with connect() as conn, conn.cursor() as cursor:
            _ensure_tables(cursor)
            conn.commit()
            cursor.execute(f"SELECT note FROM {b['days']} WHERE day = %s", (today,))
            row = cursor.fetchone()
            if row and row[0] and row[0].startswith("decided") and not force:
                continue
        uni, pr = universe(book), price(book)
        if pr == "futures":
            connors._cache.pop(("fut-frames", uni), None)  # today's stored futures close
            c = connors.fut_closes(uni)
        else:
            c = xsmom._closes(uni)
        if c.index[-1].date() != today:
            out[book] = "today's closes not stored yet"
            continue  # the closes come in after 15:45 / 15:50: tried again next minute
        live = connors.live_signals(None, today, uni, closes=c[c.index <= pd.Timestamp(today)].iloc[-450:])
        if not live["stocks"]:
            out[book] = "no session"
            continue
        kite = kite or kite_auth.trading_client()
        with connect() as conn, conn.cursor() as cursor:
            open_rows = _open_rows(cursor, b)
            age = {(s_, d): _trading_days_between(cursor, d, today) + 1 for s_, d, *_ in open_rows}
        spot_q = {k.split(":", 1)[1]: v for k, v in (kite.quote([f"NSE:{r[0]}" for r in open_rows]) if open_rows else {}).items()}
        fq = [f"NFO:{r[2]}" for r in open_rows if r[2]]
        fut_q = {k.split(":", 1)[1]: v for k, v in (kite.quote(fq) if fq else {}).items()}
        hit = _disaster(open_rows, spot_q, fut_q, today, skip_today=True)
        to_sell, buys, signals, n_signals, score = _choose(book, open_rows, age, live, hit)
        stamp = gapwatch._now()
        with connect() as conn, conn.cursor() as cursor:
            for (symbol, buy_day), (px, reason) in hit.items():
                row = next(r for r in open_rows if r[0] == symbol and r[1] == buy_day)
                last = lambda q: (q or {}).get("last_price")
                spot_px, fut_px = (last(spot_q.get(symbol)), px) if row[3] == "futures" else (px, last(fut_q.get(row[2])))
                cursor.execute(f"UPDATE {b['trades']} SET sell_day = %s, sell_at = %s, sell = %s, fut_sell = %s, reason = %s "
                               "WHERE symbol = %s AND buy_day = %s", (today, stamp, spot_px, fut_px, reason, symbol, buy_day))
            orders = [(today, s_, "sell", None, reason, None, None, d) for s_, d, _, reason in to_sell]
            orders += [(today, x["symbol"], "buy", x[score], None, pr, max_open(book), None) for x in buys]
            if orders:
                execute_values(cursor, f"INSERT INTO {b['trades']}_orders (day, symbol, action, rsi, reason, priced, slots, buy_day) "
                                       "VALUES %s ON CONFLICT DO NOTHING", orders)
            _day_row(cursor, b, today, stamp, live, n_signals, len(buys), len(to_sell) + len(hit),
                     f"decided after the close at {stamp.time():%H:%M:%S}: {len(buys)} to buy, {len(to_sell)} to sell at the next open", uni)
            conn.commit()
        out[book] = {"stopped": len(hit), "to_sell": [x[0] for x in to_sell], "to_buy": [x["symbol"] for x in buys]}
    return {"decided": bool(out), **out}


PREOPEN_FILL_FROM = clock(9, 9)  # the pre-open call auction (orders 09:00-09:08) has matched: its price is the open
PREOPEN_STAMP = clock(9, 8)


def execute_orders():
    """The next session's pre-open (from 09:09; orders go in 09:00-09:08 and fill at the auction price, the
    day's open; stamped 09:08): fill every pending order at the opening price (the share's, and the
    future's: the trade's own for a sale, the nearest expiring at least 10 days on for a buy). An order whose
    instrument hasn't traded yet waits for the next minute."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or now.time() < PREOPEN_FILL_FROM:
        return {"filled": 0}
    pending = {}
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        for book, b in BOOKS.items():
            cursor.execute(f"SELECT day, symbol, action, rsi, reason, priced, slots, buy_day FROM {b['trades']}_orders "
                           "WHERE done_day IS NULL AND day < %s ORDER BY action DESC, rsi", (today,))
            rows = cursor.fetchall()
            if rows:
                pending[book] = rows
    if not pending:
        return {"filled": 0}
    kite = kite_auth.trading_client()
    futures = _futures_for(kite, today)
    filled = 0
    for book, rows in pending.items():
        b = _book(book)
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute(f"SELECT symbol, buy_day, fut FROM {b['trades']} WHERE sell_day IS NULL")
            held = {(s_, d): f for s_, d, f in cursor.fetchall()}
        keys = {f"NSE:{r[1]}" for r in rows}
        keys |= {f"NFO:{held[(r[1], r[7])]}" for r in rows if r[2] == "sell" and held.get((r[1], r[7]))}
        keys |= {f"NFO:{futures[r[1]][0]}" for r in rows if r[2] == "buy" and r[1] in futures}
        q = kite.quote(sorted(keys))

        def opened(key):
            x = q.get(key) or {}
            ltt = x.get("last_trade_time")
            o = (x.get("ohlc") or {}).get("open")
            return float(o) if o and ltt and ltt.date() == today else None
        stamp = gapwatch.IST.localize(datetime.combine(today, PREOPEN_STAMP)) if hasattr(gapwatch.IST, "localize") \
            else datetime.combine(today, PREOPEN_STAMP, tzinfo=gapwatch.IST)  # a pre-open order: in by 09:08, filled at the open
        on = disaster(book) == "on"
        with connect() as conn, conn.cursor() as cursor:
            for day, s_, action, rsi, reason, priced, slots, buy_day in rows:
                spot = opened(f"NSE:{s_}")
                if action == "sell":
                    fut = held.get((s_, buy_day))
                    if (s_, buy_day) not in held:  # already sold (a disaster stop): nothing to do
                        cursor.execute(f"UPDATE {b['trades']}_orders SET done_day = %s, note = 'already sold' "
                                       "WHERE day = %s AND symbol = %s AND action = 'sell'", (today, day, s_))
                        continue
                    fpx = opened(f"NFO:{fut}") if fut else None
                    if spot is None or (fut and fpx is None):
                        continue  # not traded yet: next minute
                    cursor.execute(f"UPDATE {b['trades']} SET sell_day = %s, sell_at = %s, sell = %s, fut_sell = %s, reason = %s "
                                   "WHERE symbol = %s AND buy_day = %s", (today, stamp, spot, fpx, reason, s_, buy_day))
                else:
                    fut = futures.get(s_, (None, None))[0]
                    fpx = opened(f"NFO:{fut}") if fut else None
                    if spot is None or (priced == "futures" and fpx is None):
                        if now.time() >= clock(9, 30):  # never traded this morning: drop the order
                            cursor.execute(f"UPDATE {b['trades']}_orders SET done_day = %s, note = 'no opening price' "
                                           "WHERE day = %s AND symbol = %s AND action = 'buy'", (today, day, s_))
                        continue
                    own = fpx if priced == "futures" else spot
                    cursor.execute(f"INSERT INTO {b['trades']} (symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, slots, priced, "
                                   "trade_at, stop) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'nextopen', %s) "
                                   "ON CONFLICT (symbol, buy_day) DO NOTHING",
                                   (s_, today, stamp, rsi, spot, fut, fpx, slots, priced, _stop_for(own) if on else None))
                cursor.execute(f"UPDATE {b['trades']}_orders SET done_day = %s WHERE day = %s AND symbol = %s AND action = %s",
                               (today, day, s_, action))
                filled += 1
            conn.commit()
    return {"filled": filled}


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
    cum = b["setup"] == "cumrsi2"
    out = {"book": book, "universe": uni, "at": now.strftime("%H:%M:%S"), "stocks": [], "rsi_max": connors.RSI_MAX,
           "cum_max": connors.CUM_RSI_MAX, "exit_rsi": connors.EXIT_RSI, "setup": "cumrsi2" if cum else "rsi2", "sma_days": connors.SMA_DAYS}
    if not kite_auth.status().get("connected"):
        out["note"] = "Kite not connected: no live prices"
        return out
    symbols = gapwatch._symbols()
    kite = kite_auth.trading_client()
    fut = price(book) == "futures"
    out["price"] = price(book)
    if fut:  # the future's price now, and its move on the roll-adjusted futures closes
        futures = _futures_for(kite, today)
        keys = [f"NFO:{f}" for f, _ in futures.values()]
        q = {}
        for i in range(0, len(keys), 400):
            q.update(kite.quote(keys[i:i + 400]))
        prices, moves = {}, {}
        for s_, (f, _) in futures.items():
            x = q.get(f"NFO:{f}") or {}
            pv, lp = (x.get("ohlc") or {}).get("close"), x.get("last_price")
            if pv and lp:
                prices[s_], moves[s_] = float(lp), float(lp) / float(pv)
        live = connors.live_signals_fut(moves, today, uni)
        closes = connors.fut_closes(uni)
    else:
        q = kite.ltp([f"NSE:{s}" for s in symbols])
        prices = {s: float(q[f"NSE:{s}"]["last_price"]) for s in symbols if q.get(f"NSE:{s}", {}).get("last_price")}
        live = connors.live_signals(prices, today, uni)
        closes = xsmom._closes(uni)
    if not live["stocks"]:
        out["note"] = "No session today (weekend or holiday): candidates are computed on trading days"
    else:
        last = closes[closes.index < pd.Timestamp(today)].iloc[-(connors.SMA_DAYS - 1):]
        stocks = sorted(live["stocks"], key=lambda x: x["cum"] if cum else x["rsi"])
        for x in stocks:
            s_ = x["symbol"]
            px, prev = prices.get(s_), last[s_].dropna().iloc[-1] if s_ in last and last[s_].notna().any() else None
            if fut and px and prev:  # the adjusted series' level -> the contract's: scale by today's move
                scale = px / (float(prev) * moves[s_])
                prev, last_s = float(prev) * scale, last[s_] * scale
                sma = (last_s.sum() + px) / (last_s.count() + 1)
            else:
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


def _book_lots(out_open, out_closed):
    """The book's totals with each trade on its own prices (book_* fields): capital required (the peak margin
    held on any day), and the closed trades' net, costs and win rate."""
    held = [(t["buy_day"], t.get("sell_day") or "9999-12-31", t["book_margin_rs"] or 0, t["book_contract_rs"] or 0)
            for t in out_open + out_closed if t.get("book_margin_rs")]
    starts = {h[0] for h in held}
    peak = max((sum(h[2] for h in held if h[0] <= d < h[1]) for d in starts), default=0)
    peak_value = max((sum(h[3] for h in held if h[0] <= d < h[1]) for d in starts), default=0)
    closed = [t for t in out_closed if t.get("book_net_rs") is not None]
    net = sum(t["book_net_rs"] for t in closed)
    cost_rs = sum(t["book_cost_rs"] or 0 for t in closed)
    return {"capital_rs": round(peak), "value_rs": round(peak_value), "net_rs": round(net, 2), "cost_rs": round(cost_rs, 2),
            "net_margin_pct": v2margin.margin_pct(net, peak), "net_value_pct": v2margin.margin_pct(net, peak_value),
            "cost_value_pct": v2margin.margin_pct(cost_rs, peak_value), "trades": len(closed),
            "win_rate": round(100 * sum(t["book_net_rs"] > 0 for t in closed) / len(closed), 1) if closed else None}


def _lot_sizing(out_open, out_closed, cost, today, cap=None, cash_cost=None):
    """One F&O lot a position (today's lots and margin rates), at the stock and at the futures prices:
    each trade gets stock_* and fut_* rupee fields; the result, for each price set, the capital
    required (the peak margin of the positions held on any day) and the closed trades' totals."""
    rows = v2margin.table()
    out = {"margins_as_of": v2margin.as_of(rows),
           "avg_lot_margin_rs": round(sum(r["margin"] for r in rows.values()) / len(rows)) if rows else None}
    for key, buy, sell, live in (("stock", "buy", "sell", "ltp"), ("fut", "fut_buy", "fut_sell", "fut_ltp")):
        held = []
        for t in out_open + out_closed:
            if key == "stock" and cap:  # spot: capital / max open in shares, delivery costs
                z = _spot_size(cap, t.get("slots"), t.get(buy), t.get(sell) or t.get(live), cash_cost)
            else:
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
        cursor.execute("SELECT symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, sell_day, sell_at, sell, fut_sell, slots, reason, priced, "
                       "trade_at, stop "
                       f"FROM {b['trades']} ORDER BY buy_day DESC, symbol")
        trades = cursor.fetchall()
        cursor.execute("SELECT day, recorded_at, rankable, above_average, signals, bought, sold, note, universe "
                       f"FROM {b['days']} ORDER BY day DESC LIMIT 60")
        days = cursor.fetchall()
        today = gapwatch._now().date()
        cursor.execute(f"SELECT day, symbol, action, rsi, reason, priced FROM {b['trades']}_orders WHERE done_day IS NULL ORDER BY action, symbol")
        orders = [{"decided": d.isoformat(), "symbol": s_, "action": a_, "rsi": round(r, 1) if r is not None else None, "reason": rs, "priced": pc}
                  for d, s_, a_, r, rs, pc in cursor.fetchall()]
        open_days = {(t[0], t[1]): _trading_days_between(cursor, t[1], today) + 1 for t in trades if t[7] is None}
    out_open, out_closed = [], []
    for symbol, buy_day, buy_at, rsi, buy, fut, fut_buy, sell_day, sell_at, sell, fut_sell, slots, reason, priced, at, stop in trades:
        row = {"symbol": symbol, "buy_day": buy_day.isoformat(), "buy_at": buy_at.astimezone(backtest.IST).strftime("%H:%M:%S"), "slots": slots,
               "entry_at": f"{buy_day.isoformat()} {buy_at.astimezone(backtest.IST).strftime('%H:%M:%S')}",
               "rsi": round(rsi, 1), "buy": round(buy, 2), "fut": fut, "fut_buy": round(fut_buy, 2) if fut_buy else None,
               "priced": "futures" if priced == "futures" else "spot", "trade_at": at or "close",
               "stop": round(stop, 2) if stop else None}
        if sell_day is None:
            row["day_of_hold"] = min(open_days[(symbol, buy_day)], MAX_DAYS)
            out_open.append(row)
            continue
        gross = sell / buy - 1
        net = gross - cost * (1 + sell / buy)
        row.update({"sell_day": sell_day.isoformat(), "sell": round(sell, 2), "reason": reason or "time",
                    "exit_at": f"{sell_day.isoformat()} {sell_at.astimezone(backtest.IST).strftime('%H:%M:%S')}", "fut_sell": round(fut_sell, 2) if fut_sell else None,
                    "gross_pct": round(100 * gross, 2), "net_pct": round(100 * net, 2)})
        if fut_buy and fut_sell:
            fg = fut_sell / fut_buy - 1
            row.update({"fut_gross_pct": round(100 * fg, 2), "fut_net_pct": round(100 * (fg - cost * (1 + fut_sell / fut_buy)), 2)})
        out_closed.append(row)
    ltp_at = _live_prices(out_open)
    nets = [t["net_pct"] for t in out_closed]
    fnets = [t["fut_net_pct"] for t in out_closed if "fut_net_pct" in t]
    n = max_open(book)
    import v2ltlv
    lots = _lot_sizing(out_open, out_closed, cost, today, cap=capital(book), cash_cost=v2ltlv.cash_cost_per_side(slippage))
    for t in out_open + out_closed:  # each trade on the prices it was bought under: the book's own figures
        k = "fut" if t["priced"] == "futures" else "stock"
        for f_ in ("net_rs", "cost_rs", "pnl_rs", "margin_rs", "contract_rs", "qty", "net_margin_pct", "net_value_pct"):
            t[f"book_{f_}"] = t.get(f"{k}_{f_}")
        t["book_net_pct"] = t.get("fut_net_pct" if k == "fut" else "net_pct")
    lots["book"] = _book_lots(out_open, out_closed)
    summary = {"trades": len(out_closed), "open": len(out_open),
               "win_rate": round(100 * sum(n > 0 for n in nets) / len(nets), 1) if nets else None,
               "avg_net_pct": round(sum(nets) / len(nets), 2) if nets else None,
               "book_net_pct": round(sum(t["net_pct"] / t["slots"] for t in out_closed), 2),
               "fut_book_net_pct": round(sum(t["fut_net_pct"] / t["slots"] for t in out_closed if "fut_net_pct" in t), 2) if fnets else None,
               "cost_per_side_bps": round(10000 * cost, 2)}
    return {"open": out_open, "closed": out_closed, "summary": summary, "max_open": n, "max_open_limit": MAX_OPEN_LIMIT,
            "hold": MAX_DAYS, "exit": exit_mode(book), "price": price(book), "trade_at": trade_at(book), "disaster": disaster(book),
            "capital": capital(book),
            "orders": orders, "setup": b["setup"], "exit_rsi": connors.EXIT_RSI, "book": book, "book_label": b["label"],
            "universe": universe(book), "universes": list(UNIVERSES), "lots": lots, "ltp_at": ltp_at,
            "backtest_variant": backtest_variant(n, book),
            "days": [{"day": d.isoformat(), "recorded_at": r.astimezone(backtest.IST).strftime("%H:%M:%S"), "rankable": rk,
                      "above_average": aa, "signals": sg, "bought": bo, "sold": so, "note": nt, "universe": un}
                     for d, r, rk, aa, sg, bo, so, nt, un in days]}
